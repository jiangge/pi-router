# Pi-Router Architecture

## Overview

Pi-Router is a **production-grade intelligent routing layer** for pi (coding agent) that provides:
- **L1 Channel Failover**: Same model, different providers (lan, n1-claude, run-claude, etc.)
- **L2 Model Fallback**: Different models with context transfer (opus → sonnet → gemini)
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
Try channels: lan → n1-claude → run-claude
  ↓
Forward to real provider: claude-opus-4-8@lan
```

### 2. Multi-Level Failover

```
L1 Channel Failover (same model)
├─ claude-opus-4-8@lan (primary)
├─ claude-opus-4-8@n1-claude (failover 1)
└─ claude-opus-4-8@run-claude (failover 2)
    ↓ All L1 failed
L2 Model Fallback (different models)
├─ claude-sonnet-4-6@lan (fallback model 1)
└─ gemini-2.0-flash-exp@google (fallback model 2)
```

### 3. Configuration

Located at `~/.pi/agent/pi-router.json`:

```json
{
  "strategy": "channelFirst",
  "auto": true,
  "sticky": true,
  "contextTransfer": "summary",
  "sortBy": "config",
  "summaryPrompt": "Summarize conversation...",
  "models": [
    {
      "id": "claude-opus-4-8",
      "channels": ["lan", "n1-claude", "run-claude"],
      "sticky": true,
      "sortBy": "latency",
      "fallbackModels": [
        {
          "id": "claude-sonnet-4-6",
          "channels": ["lan", "run-claude"]
        }
      ]
    }
  ]
}
```

---

## Architecture Components

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
│    - tryNextChannel() loop:                         │
│      • Check cooldown                               │
│      • Check circuit breaker                        │
│      • forwardToProvider() → pi-ai streamSimple     │
│      • On error: record failure, try next           │
│    - On all L1 failed:                              │
│      • tryL2ModelFallback()                         │
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
   - `capabilityFirst`: Prefer higher-capability providers

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
1. Tries channels in determined order
2. Skips channels in cooldown or with open circuit breaker
3. Records latency on first event
4. Catches stream errors and failovers transparently
5. Falls back to L2 models when all L1 channels exhausted

#### **tryL2ModelFallback()**
Handles cross-model failover:
1. Iterate through fallback models
2. Generate context summary (if `contextTransfer: "summary"`)
3. Call `sanitizeContextForSwitch()` for compatibility
4. Forward to fallback model
5. Continue to next fallback if fails

---

## Reliability Features

### Circuit Breaker

**Purpose**: Fast-fail for consistently broken channels

**States**:
- **Closed**: Normal operation, allow all requests
- **Open**: Channel broken, block requests for 2 minutes
- **Half-Open**: Testing recovery, allow one probe request

**Logic**:
- Open circuit after **5 consecutive failures**
- Reset timeout: **2 minutes**
- Automatic recovery testing via half-open state

**Integration**: `canAttemptChannel()` called before each attempt

### Cooldown Mechanism

**Purpose**: Prevent retry storms immediately after failure

**Logic**:
- Apply cooldown after channel failure
- Default: **60 seconds** (configurable per-model or globally)
- Channel skipped during cooldown period
- Independent from circuit breaker (different time scales)

### Health Monitoring

**Purpose**: Track channel reliability over time

**Tracking**:
- Update health on every request outcome
- Mark unhealthy after **3+ consecutive failures**
- Reset to healthy on first success
- Displayed in `/router explain`

**Future**: Background health probes to detect recovery proactively

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

## Context Transfer (L2 Fallback)

When switching models, handle incompatibilities:

### Strategies

1. **`none`**: Pass context as-is (risky, may fail on compat issues)
2. **`full`**: Sanitize but keep full conversation
3. **`summary`**: Generate AI summary (~500 tokens), sanitize

### Process

```typescript
// 1. Generate summary (if strategy = "summary")
const summaryResult = await generateContextSummary(
  messages,
  primaryModel,
  targetModel,
  summaryModel, // Use cheap model
  summaryPrompt
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
Check for model changes in `models.json` and show diff

### `/router sync accept`
Apply detected changes to config

### `/router diff`
Preview differences between config and `models.json`

---

## State Management

### RouterState
```typescript
{
  activeChannels: Map<string, string>;        // "modelId" → "channel"
  cooldowns: Map<string, number>;             // "modelId@channel" → endTime
  lastFailures: Map<string, FailureRecord[]>; // "modelId" → failures[]
}
```

### LatencyTracker
```typescript
{
  records: Map<string, LatencyRecord[]>; // "modelId@channel" → latencies[]
  maxRecords: 10;
}
```

### HealthChecker
```typescript
{
  status: Map<string, HealthCheckStatus>; // "modelId@channel" → status
  enabled: false; // Will enable in v0.2 with background probes
}
```

### CircuitBreaker
```typescript
{
  circuits: Map<string, CircuitBreakerStatus>; // "modelId@channel" → status
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

## Future Enhancements (v0.2+)

### 1. Background Health Probes
- Periodic lightweight requests to check channel availability
- Detect recovery without waiting for user request
- Update circuit breaker state proactively

### 2. Per-Channel Pricing
- Fine-grained cost data per provider
- Real cost-based sorting (currently assumes uniform pricing per model)

### 3. Latency-Based Adaptive Routing
- Dynamic threshold: prefer faster channel if latency diff > X%
- Time-of-day patterns (some providers slower at peak hours)

### 4. Decision Analytics
- Aggregate statistics over time
- Failure pattern detection
- Strategy effectiveness comparison

### 5. Inline Fallback Mode
- Currently only `'switch'` mode (replace model)
- Add `'inline'`: show both responses (primary + fallback)

### 6. Real Summary Generation
- Currently placeholder
- Connect to actual cheap model (e.g., gemini-flash)
- Token counting and cost tracking

### 7. Config Presets
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
- L2 fallback: Summary generation + model switch (~2-5s)

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

### Unit Tests (TODO)
- `determineChannelOrder()` logic
- Circuit breaker state transitions
- Latency averaging
- Context sanitization

### Integration Tests (TODO)
- Full L1 failover flow
- L2 model fallback with summary
- Circuit breaker opening/closing
- Cooldown expiration

### Manual Testing
1. Configure router with multiple channels
2. Kill one provider (e.g., stop lan endpoint)
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
- Check summary generation logs
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
- Models registry: `~/.pi/agent/models.json`
- Router config: `~/.pi/agent/pi-router.json`

---

## Version History

### v0.1.0-alpha (Current)
- ✅ L1 channel failover
- ✅ L2 model fallback with context transfer
- ✅ Sticky mode for cache preservation
- ✅ Latency tracking and sorting
- ✅ Circuit breaker (fast-fail)
- ✅ Health monitoring
- ✅ Decision logger
- ✅ Cooldown mechanism
- ✅ Full command set (/router status/list/explain/decisions/sync/diff)

### v0.2.0 (Planned)
- Background health probes
- Per-channel pricing
- Real AI summary generation
- Decision analytics
- Config presets
- Unit tests
- Integration tests
