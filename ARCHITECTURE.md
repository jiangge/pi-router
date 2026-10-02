# Pi-Router Architecture

## Overview

Pi-Router is a **production-grade intelligent routing layer** for pi (coding agent) that provides:
- **Channel Failover (channelFirst)**: Same model, different providers (Provider-A, Provider-B, Provider-C, etc.)
- **Model Fallback**: Different models with context transfer (opus → sonnet → gemini)
- **Smart Routing**: Latency-based, cost-based, capability-based channel selection
- **Reliability**: Circuit breaker, health monitoring, cooldown mechanisms
- **Observability**: Decision logging, failure tracking, performance metrics

---

## Core Concepts

### 1. Router Models

Virtual models registered as `router/{model-id}` that intercept requests:

```
User selects: router/claude-opus-4-8
  ↓
Router intercepts via custom streamSimple handler
  ↓
Try channels: Provider-A → Provider-B → Provider-C
  ↓
Forward to real provider: claude-opus-4-8@Provider-A
```

### 2. Multi-Level Failover

```
Channel Failover (channelFirst) (same model)
├─ claude-opus-4-8@Provider-A (primary)
├─ claude-opus-4-8@Provider-B (failover 1)
└─ claude-opus-4-8@Provider-C (failover 2)
    ↓ All all channels failed
Model Fallback (different models)
├─ claude-sonnet-4-6@Provider-A (fallback model 1)
└─ gemini-2.0-flash-exp@google (fallback model 2)
```

### 3. Configuration

Located at `~/.pi/agent/pi-router.json` by default, or under the directory selected by pi's `PI_CODING_AGENT_DIR` setting:

```json
{
  "strategy": "channelFirst",
  "auto": true,
  "sticky": true,
  "contextTransfer": "summary",
  "sortBy": "config",
  "summaryPrompt": "Summarize conversation...",
  "summaryMaxTokens": 2000,
  "models": [
    {
      "id": "claude-opus-4-8",
      "channels": ["Provider-A", "Provider-B", "Provider-C"],
      "sticky": true,
      "sortBy": "latency",
      "fallbackModels": [
        {
          "id": "claude-sonnet-4-6",
          "channels": ["Provider-A", "Provider-C"]
        }
      ]
    }
  ]
}
```

---

## Architecture Components

### Core Runtime Modules

The request data plane is split from extension wiring:

- `core/route-executor.ts`: shared admission, dispatch, relay outcome and reliability bookkeeping for normal, auto and fallback routes
- `core/stream-relay.ts`: timeout, abort propagation and the stream commit barrier
- `core/failure-classifier.ts`: structured failure taxonomy and cooldown selection for auth, transport, timeout, rate-limit and provider failures
- `core/atomic-file.ts`: same-directory temporary write plus atomic rename for config replacement
- `reliability/circuit-breaker.ts`: closed/open/half-open state machine with single-flight recovery admission
- `index.ts`: extension lifecycle, provider/model resolution, configuration, UI/commands and dependency binding for the core runtime

### Request Flow

```
┌─────────────────────────────────────────────────────┐
│ 1. User Request: router/claude-opus-4-8            │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│ 2. registerRouterProvider.streamSimple              │
│    - Intercept request                              │
│    - Load config                                    │
│    - Call routeRequest()                            │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│ 3. routeRequest()                                   │
│    - Get model config                               │
│    - Determine channel order (sticky/sort)          │
│    - Call createFailoverStream()                    │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│ 4. createFailoverStream()                           │
│    - Resolve route candidates                       │
│    - executeRouteAttempt() for every attempt        │
│      • Check cooldown                               │
│      • Acquire circuit-breaker admission            │
│      • forwardToProvider() → pi-ai streamSimple     │
│      • relayProviderStream() commit barrier         │
│      • Record latency / health / failures / circuit │
│    - On all channels failed:                        │
│      • tryModelFallback() uses same executor        │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│ 5. Stream Events                                    │
│    - First event: record latency, update health     │
│    - Forward events to user via eventStream         │
│    - On stream error: failover to next channel      │
└─────────────────────────────────────────────────────┘
```

### Key Functions

#### **determineChannelOrder()**
Decides channel priority based on:
1. **Sticky mode**: Prefer last successful channel (cache optimization)
2. **Sort strategy**:
   - `config`: Use config file order
   - `latency`: Sort by measured time-to-first-token
   - `cost`: Sort by provider pricing
   - `capabilityFirst`: Prefer routes targeting higher-capability upstream models; unknown/tied models preserve config order

#### **forwardToProvider()**
Converts router's `PiModel` to pi-ai's `Model<Api>` format and forwards:
```typescript
const realModel: Model<Api> = {
  id: model.id,
  provider: model.provider,
  api: model.api as Api,
  // ... other properties with defaults
};
return streamSimple(realModel, context, options);
```

#### **createFailoverStream()**
Returns `AssistantMessageEventStream` that:
1. Resolves configured routes in determined order
2. Sends each route through the shared `executeRouteAttempt()` boundary
3. Preserves commit safety: failover is allowed only before user-visible output commits
4. Records route-scoped latency, health, cooldown and circuit state
5. Falls back to fallback models when all primary routes are exhausted

#### **executeRouteAttempt()**
Shared data-plane executor used by normal routing, `router/auto`, and model fallback:
1. Check route cooldown
2. Acquire circuit-breaker admission
3. Dispatch to the resolved upstream provider/model
4. Relay the stream through the commit barrier
5. Record success/failure state with the same route identity
6. Release half-open probe ownership on abort or committed-stream failure

#### **tryModelFallback()**
Handles cross-model failover:
1. Iterate through fallback models
2. Generate context summary when required by the target context window
3. Call `sanitizeContextForSwitch()` for compatibility
4. Execute each fallback route through `executeRouteAttempt()`
5. Continue to the next fallback route if admission or dispatch fails

---

## Reliability Features

### Circuit Breaker

**Purpose**: Fast-fail for consistently broken channels

**States**:
- **Closed**: Normal operation, allow all requests
- **Open**: Channel broken, block requests for 2 minutes
- **Half-Open**: Testing recovery, allow exactly one in-flight probe request

**Logic**:
- Open circuit after **5 consecutive failures**
- Reset timeout: **2 minutes**
- Automatic recovery testing via half-open state
- Half-open admission is single-flight; concurrent requests remain blocked until the probe resolves

**Integration**: `canAttemptChannel()` called before each attempt

### Cooldown Mechanism

**Purpose**: Prevent retry storms immediately after failure

**Logic**:
- Apply cooldown after channel failure
- Default: **60 seconds** (configurable per-model or globally)
- Channel skipped during cooldown period
- Independent from circuit breaker (different time scales)
- Transient credential-resolution failures, network transport failures and timeouts use a **5 second** cooldown; permanent auth failures keep the configured cooldown

### Configuration Writes

`pi-router.json` is replaced atomically: the new JSON is written to a temporary file in the same directory and then renamed over the destination. This prevents an interrupted write from leaving a partially written primary config file.

### Health Monitoring

**Purpose**: Track channel reliability over time

**Tracking**:
- Update health on every request outcome
- Mark unhealthy after **3+ consecutive failures**
- Reset to healthy on first success
- Displayed in `/router explain`

**Background probes**: Optional periodic probes are implemented and disabled by default; real user traffic remains the source of truth for failover health.

### Latency Tracking

**Purpose**: Learn from actual performance and optimize routing

**Measurement**:
- Record **time-to-first-token** (stream start to first event)
- Keep last **10 measurements** per channel
- Calculate average for sorting

**Usage**:
- `sortBy: "latency"` uses real measurements
- Displayed in `/router explain` with sample count

---

## Context Transfer (Fallback Model Switch)

When switching models, handle incompatibilities:

### Strategies

1. **`none`**: Pass context as-is (risky, may fail on compat issues)
2. **`full`**: Sanitize but keep full conversation
3. **`summary`**: Only summarize when needed; otherwise pass full context. When summarizing, target size defaults to ~2000 tokens.

### Process

```typescript
// 1. Generate summary (if strategy = "summary")
const summaryResult = await generateContextSummary(
  messages,
  primaryModel,
  targetModel,
  summaryModel,      // Optional dedicated summary model
  summaryPrompt,
  summaryMaxTokens
);

// 2. Sanitize context for compatibility
const modifiedContext = sanitizeContextForSwitch(
  context,
  primaryModel,
  targetModel,
  strategy,
  summaryResult.summary
);

// 3. Forward to fallback model
forwardToProvider(targetModel, modifiedContext, options);
```

### Why Summary?

- **Cache preservation**: New model can't use old model's cache
- **Cost savings**: Summary << full context
- **Compatibility**: Avoid system message / role incompatibilities

---

## Decision Logger

**Purpose**: Understand routing behavior and debug issues

**Captured Data**:
```typescript
{
  timestamp: number;
  modelId: string;
  selectedChannel: string;
  attemptedChannels: string[];  // Shows failover path
  sortStrategy: string;
  latencyMs?: number;           // Added on first event
  fallbackUsed: boolean;
  fallbackModel?: string;
  reason: string;               // "first choice" | "failover after N failures"
}
```

**Storage**: Keep last **50 decisions** in memory

**Usage**: `/router decisions` command

---

## Commands

### `/router status`
Show current configuration and active router models

### `/router list`
List all available router models with their channels

### `/router explain`
**Most important diagnostic command**:
- Active channels per model
- Active cooldowns (with remaining time)
- Recent failures (last 10 with timestamps)
- Channel latency statistics (avg last 10 samples)
- Channel health status
- Circuit breaker states (open/half-open only)

### `/router decisions`
Show last 20 routing decisions with:
- Selected channel
- Attempted channels (on failover)
- Sort strategy
- Latency (when available)
- Fallback usage
- Reason

### `/router sync`
Check for model changes from explicit `models.json` entries and auth-only builtin providers, with deprecated models filtered silently

### `/router sync accept`
Apply detected model changes to config

### `/router diff`
Preview differences between config and `models.json`

---

## State Management

### RouterState
```typescript
{
  currentRouterConfig: RouterConfig | null;
  configFileMtimeMs: number | null;
  autoSyncChecked: boolean;
  autoSyncConfig: RouterConfig | null;
  cachedModelMap: Map<string, PiModel> | null;
  activeChannels: Map<string, string>;        // "modelId" → routeKey
  cooldowns: Map<string, number>;             // "modelId@routeKey" → endTime
  lastFailures: Map<string, FailureRecord[]>; // "modelId" → failures[]
}
```

Configuration lifecycle and registry-derived model-map state are session-scoped through the same `AsyncLocalStorage<RouterState>` boundary as route health and UI state. Process-level caches are reserved for immutable/file-backed catalog data that is invalidated by file identity/mtime.

### LatencyTracker
```typescript
{
  records: Map<string, LatencyRecord[]>; // "modelId@routeKey" → latencies[]
  maxRecords: 10;
}
```

### HealthChecker
```typescript
{
  status: Map<string, HealthCheckStatus>; // "modelId@routeKey" → status
  enabled: false; // Background probes are optional and disabled by default
}
```

### CircuitBreaker
```typescript
{
  circuits: Map<string, CircuitBreakerStatus>; // "modelId@routeKey" → status
  failureThreshold: 5;
  resetTimeoutMs: 120000;
  enabled: true;
}
```

### DecisionLogger
```typescript
{
  decisions: RoutingDecision[];
  maxDecisions: 50;
  enabled: true;
}
```

---

## Future Enhancements

### 1. Per-Channel Pricing
- Fine-grained cost data per provider
- Real cost-based sorting (currently assumes uniform pricing per model)

### 2. Latency-Based Adaptive Routing
- Dynamic threshold: prefer faster channel if latency diff > X%
- Time-of-day patterns (some providers slower at peak hours)

### 3. Decision Analytics
- Aggregate statistics over time
- Failure pattern detection
- Strategy effectiveness comparison

### 4. Inline Fallback Mode
- Currently only `'switch'` mode (replace model)
- Add `'inline'`: show both responses (primary + fallback)

### 5. Config Presets
- Common patterns: `"mode": "reliability"`, `"mode": "cost"`, `"mode": "speed"`
- Auto-generate optimal config based on use case

---

## Performance Characteristics

### Overhead

**Minimal when healthy**:
- Sticky mode: ~0ms (cache hit, no re-selection)
- First request: Determined channel order (~1-5ms)
- Stream forwarding: Direct passthrough (no buffering)

**On failure**:
- Channel failover: Time to detect error + retry (~100-500ms)
- Circuit breaker: Instant skip (0ms added)
- model fallback: Summary generation + model switch (~2-5s)

### Memory

**Per-session state**:
- Config: ~1-5 KB
- State maps: ~10-50 KB (scales with unique model@channel combos)
- Latency records: ~1 KB per channel (10 samples × 100 bytes)
- Decision log: ~10-20 KB (50 decisions × 200-400 bytes)

**Total**: ~50-100 KB typical

### Scalability

**Handles**:
- 100+ models with 3-5 channels each
- 1000+ requests per session
- Decision log auto-trimmed (keep last 50)
- Latency records auto-trimmed (keep last 10 per channel)

---

## Testing Strategy

### Unit Tests
- ✅ `determineChannelOrder()` logic
- ✅ Circuit breaker state transitions
- ✅ Latency averaging
- ✅ Context sanitization
- ✅ Config wizard classification/sorting/editors
- ✅ Provider/model expansion and config persistence

### Integration Tests
- ✅ Full L1 failover flow
- ✅ fallback model fallback with summary
- ✅ Circuit breaker opening/closing
- ✅ Cooldown skip/expiration
- ✅ Stream commit safety (do not fail over after committed output)
- ✅ Config wizard keyboard-driven flow

### Manual Testing
1. Configure router with multiple channels
2. Kill one provider (e.g., stop Provider-A endpoint)
3. Observe automatic failover in logs
4. Check `/router explain` for failure tracking
5. Verify circuit breaker opens after threshold
6. Wait for cooldown/reset, observe recovery

---

## Troubleshooting

### Channel always fails
- Check `/router explain` for circuit breaker state
- Verify cooldown hasn't been applied
- Check actual provider availability (ping endpoint)
- Review recent failures for error patterns

### Latency sorting not working
- Need 10+ samples before meaningful
- Check `/router explain` for sample counts
- Verify `sortBy: "latency"` in config
- Sticky mode overrides sorting (by design)

### Context transfer fails
- Check summary generation logs (enable with `PI_ROUTER_DEBUG=1`)
- Verify fallback model has compatible API
- Try `contextTransfer: "full"` as fallback
- Review `sanitizeContextForSwitch()` logic

### High failover rate
- Review `/router decisions` for patterns
- Check if circuit breaker threshold too low
- Verify health of primary channels
- Consider adjusting cooldown duration

---

## References

- Pi documentation: `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- Extension API: `docs/extensions.md`
- Models registry: `~/.pi/agent/models.json` by default (`PI_CODING_AGENT_DIR/models.json` when overridden)
- Router config: `~/.pi/agent/pi-router.json` by default (`PI_CODING_AGENT_DIR/pi-router.json` when overridden)

---

## Version History

### v0.5.7 (Current)
- ✅ Channel failover and model fallback with context transfer
- ✅ Shared route executor for normal, auto, and fallback attempts
- ✅ Route-scoped cooldown, latency, health, sticky and circuit state
- ✅ Half-open circuit breaker with single-flight recovery probe
- ✅ Stream commit barrier prevents failover after user-visible output begins
- ✅ Background health probes and AI-assisted summary generation
- ✅ Session-scoped runtime state via `AsyncLocalStorage`
- ✅ Routing registry/cache-hint integration protocols
- ✅ Unit and runtime integration coverage
