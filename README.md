# pi-router

**Intelligent routing layer for pi (coding agent) with multi-level failover and observability.**

English | [简体中文](./README.zh-CN.md)

## Features

- 🔄 **Channel Failover**: Same model, different providers (lan → n1-claude → run-claude)
- 🎯 **Model Fallback**: Cross-model failover with context transfer (opus → sonnet → gemini)
- 🧠 **Smart Routing**: Latency-based, cost-based, capability-based channel selection
- 🛡️ **Circuit Breaker**: Fast-fail for broken channels with automatic recovery
- 📊 **Observability**: Decision logging, latency tracking, health monitoring
- 💾 **Sticky Mode**: Cache preservation by preferring last successful channel
- ⏱️ **Cooldown**: Prevent retry storms after failures

## Quick Start

### 1. Install

```bash
cd /home/jiang/jiang/source/pi-router
npm install
npm run build
```

### 2. Configure

Edit `~/.pi/agent/pi-router.json`:

```json
{
  "strategy": "channelFirst",
  "auto": true,
  "sticky": true,
  "contextTransfer": "summary",
  "sortBy": "latency",
  "models": [
    {
      "id": "claude-opus-4-8",
      "channels": ["lan", "n1-claude", "run-claude"],
      "fallbackModels": [
        { "id": "claude-sonnet-4-6", "channels": ["lan"] }
      ]
    }
  ]
}
```

### 3. Use

In pi, select a router model:

```
Model: router/claude-opus-4-8
```

Pi-router will automatically:
- Try channels in order (with smart sorting)
- Failover on errors
- Apply circuit breaker and cooldowns
- Fall back to alternative models if needed
- Track performance and health

## Commands

```
/router status       # Show current config
/router list         # List available models
/router explain      # Show failures, latency, health, circuits
/router decisions    # Show recent routing decisions
/router probes       # Show background health probe results
/router pricing      # Show per-channel pricing breakdown
/router sync         # Check for model changes
/router sync accept  # Apply detected changes
```

## How It Works

```
User Request: router/claude-opus-4-8
    ↓
Router Intercepts
    ↓
Try channels: lan → n1-claude → run-claude
├─ Check cooldown
├─ Check circuit breaker
├─ Forward to real provider
└─ On error: record, try next
    ↓
All L1 failed? Try model fallback
├─ Generate context summary
├─ Sanitize for compatibility
└─ Forward to claude-sonnet-4-6@lan
    ↓
Stream events to user
├─ Record latency on first event
├─ Update health status
└─ Log routing decision
```

## Key Concepts

### Sticky Mode

Prefer last successful channel to maximize cache hits:

```
Request 1: lan (success) → sticky = lan
Request 2: Try lan first (cache hit!)
Request 3: lan fails → try n1-claude → sticky = n1-claude
Request 4: Try n1-claude first (cache preserved)
```

### Circuit Breaker

Fast-fail for broken channels:

```
Failures: 0 → 1 → 2 → 3 → 4 → 5 (OPEN)
    ↓
Block requests for 2 minutes
    ↓
Half-open: Allow 1 test request
    ↓
Success? → CLOSED (reset)
Failure? → OPEN (another 2 minutes)
```

### Context Transfer

When switching models (model fallback):

1. **Summary mode**: AI summarizes conversation (~500 tokens)
2. **Sanitize**: Handle system message / role incompatibilities
3. **Forward**: Use modified context with fallback model

## Observability

### /router explain

```
Active Channels:
  claude-opus-4-8 → lan

Active Cooldowns:
  claude-opus-4-8@n1-claude: 45s remaining

Recent Failures:
  claude-opus-4-8@n1-claude (52s ago): Connection timeout

Channel Latency (avg last 10):
  claude-opus-4-8@lan: 523ms (10 samples)
  claude-opus-4-8@n1-claude: 1247ms (8 samples)

Channel Health:
  claude-opus-4-8@lan: ✓ healthy (checked 5s ago)
  claude-opus-4-8@n1-claude: ✗ unhealthy (3 failures)

Circuit Breakers:
  🔴 opus@n1-claude: open (5 failures, retry in 87s)
```

### /router decisions

```
Recent Routing Decisions (last 20):

claude-opus-4-8 -> lan (523ms) (12s ago)
  Strategy: sticky | first choice

claude-opus-4-8 -> run-claude (1847ms) (45s ago)
  Strategy: sticky | failover after 2 failures
  Tried: lan -> n1-claude -> run-claude
```

## Configuration Reference

### Global Options

```json
{
  "strategy": "channelFirst",     // Routing strategy
  "auto": true,                   // Auto-sync models.json changes
  "sticky": true,                 // Prefer last successful channel
  "contextTransfer": "summary",   // "none" | "full" | "summary"
  "sortBy": "latency",            // "config" | "latency" | "cost"
  "summaryPrompt": "...",         // Custom summary prompt
  "failover": {
    "cooldownMs": 60000           // Cooldown duration (default 60s)
  },
  "healthProbe": {
    "enabled": true,              // Enable background health probes
    "intervalMs": 300000,         // Probe interval (default 5 min)
    "timeoutMs": 10000,           // Probe timeout (default 10s)
    "probeMessage": "ping"         // Simple test message
  }
}
```

### Per-Model Options

```json
{
  "id": "claude-opus-4-8",
  "channels": ["lan", "n1-claude", "run-claude"],
  "sticky": true,                 // Override global sticky
  "sortBy": "latency",            // Override global sortBy
  "contextTransfer": "summary",   // Override global contextTransfer
  "fallbackModels": [
    {
      "id": "claude-sonnet-4-6",
      "channels": ["lan", "run-claude"]
    }
  ],
  "failover": {
    "cooldownMs": 30000           // Override global cooldown
  }
}
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design documentation.

## Development Status

**v0.3.0-alpha** - Cost optimization:
- ✅ Per-channel pricing with multipliers
- ✅ Cost-based channel sorting
- ✅ Free self-hosted channel detection
- ✅ /router pricing command

**v0.2.0-alpha** - Enhanced features:
- ✅ Real AI summary generation
- ✅ Background health probes
- ✅ Proactive circuit breaker recovery
- ✅ Enhanced observability

**v0.1.0-alpha** - Core features complete:
- ✅ channel failover
- ✅ model fallback
- ✅ Circuit breaker
- ✅ Latency tracking
- ✅ Health monitoring
- ✅ Decision logging
- ✅ Full command set

**v0.2.0** - Planned:
- Background health probes
- Per-channel pricing
- Real AI summary generation
- Decision analytics
- Unit tests

## License

MIT

## Credits

Built with [pi coding agent](https://github.com/pi-agi/pi-coding-agent) extension API.
