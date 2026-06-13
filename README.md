# pi-router

Intelligent routing layer for pi (coding agent) with multi-level failover and observability.

English | [简体中文](./README.zh-CN.md)

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [How It Works](#how-it-works)
- [Configuration Reference](#configuration-reference)
- [Performance](#performance)
- [Uninstall](#uninstall)
- [Architecture](#architecture)
- [Further Reading](#further-reading)
- [License](#license)

## Features

- **Auto Router mode** — select `router/auto` and let pi-router handle all routing automatically
- Channel failover for the same model across different providers
- Model fallback with context transfer
- Smart routing by latency, capability, cost, or manual order
- Circuit breaker and cooldown protection
- **Persistent sticky routing** — remembers the last successful channel across restarts
- Decision logging, latency tracking, and health monitoring
- Footer status showing the active provider channel
- Interactive menus and tab completion for all commands
- Interactive configuration wizard
- Fast startup with lazy loading and caching

## Quick Start

### 1. Install

```bash
# From npm (after publication)
pi install npm:pi-router

# Or from GitHub
pi install git:github.com/jiangjilin/pi-router

# Or from local directory (for development)
pi install /path/to/pi-router
```

See [INSTALL.md](INSTALL.md) for detailed installation options.

### 2. Configure

Recommended: run the interactive wizard.

```bash
/router config wizard
```

The wizard walks through:

1. Routing strategy (`channelFirst` / `modelFirst`)
2. Sort strategy (`latency` / `capabilityFirst` / `cost` / `manual`)
3. Auto-sync (`enable` / `disable`)
4. Health probe (`10 minutes` / `disabled`)
5. Sticky mode (`enable` / `disable`)
6. Optional channel order adjustment

**Channel Classification**: The wizard automatically classifies channels into three categories:

- 🔵 **OAuth** (Official) - Official API endpoints from AI providers (e.g., `api.anthropic.com`, `api.deepseek.com`)
- 🟡 **Aggregator** (Third-party) - Third-party aggregation services
- 🟢 **Free** (Local) - Local deployments and free services

Classification is based on:
- `auth.json` OAuth markers (`type: "oauth"`)
- Official domain whitelist (40+ providers including Anthropic, OpenAI, Google, DeepSeek, Qwen, GLM, Kimi, and more)
- Local URL detection (`localhost`, `127.0.0.1`)

Configuration is stored at:

```text
~/.pi/agent/pi-router.json
```

Advanced users can edit the file directly. A companion file is also generated:

```text
~/.pi/agent/pi-router.README.md
```

A reference example is available at [examples/router.config.json](examples/router.config.json).

### 3. Use

In pi, select the Auto Router model:

```text
/model router/auto
```

This routes all requests through pi-router automatically, using your configured strategy and model chain.

You can also select a specific model with routing:

```text
/model router/your-model-id
```

pi-router will then:

- try channels in order (based on strategy)
- fail over on errors
- apply circuit breaker and cooldown rules
- optionally fall back to another model
- record health and latency information
- display the active channel in the footer (e.g., `via anthropic`)
- remember the last successful route for next time (sticky mode)

## Commands

Run `/router` without arguments to open an interactive menu, or use tab completion.

### Configuration

```text
/router config wizard    # Interactive configuration wizard
/router config show      # Show current configuration
/router config reset     # Reset to default configuration
```

Shortcuts:

```text
/router config w         # = wizard
/router config s         # = show
/router config r         # = reset
```

### Monitoring

```text
/router status           # Show config summary
/router list             # List configured router models
/router explain          # Show failures, latency, health, circuits
/router decisions        # Show recent routing decisions
/router probes           # Show background health probe results
/router pricing          # Show per-channel pricing breakdown
```

### Sticky Routing

```text
/router sticky           # Show current sticky routing records
/router sticky clear     # Clear all sticky records (re-route from beginning)
/router sticky clear <m> # Clear sticky record for a specific model
```

### Management

```text
/router sync             # Check models.json changes
/router sync accept      # Apply detected changes
/router diff             # Preview config differences
```

## How It Works

### Auto Router (`router/auto`)

When you select `router/auto`, pi-router manages the full model chain:

```text
User Request: router/auto
    ↓
Check sticky record → found "model-X@channel-Y"?
    ↓ yes                    ↓ no
Try sticky first         Follow strategy order
    ↓ fail                   ↓
Clear sticky, fall back to strategy order
    ↓
channelFirst: Model-A[ch1,ch2,ch3] → Model-B[ch1,ch2] → ...
modelFirst:   [Model-A@ch1, Model-B@ch1] → [Model-A@ch2, Model-B@ch2] → ...
    ↓
On success: update sticky record, stream response
    ↓
Footer shows: via <channel-name>
```

### Same model, different providers

Example:

```text
Try channels: Provider-A -> Provider-B -> Provider-C
```

Typical flow:

```text
User Request: router/example-model
    ↓
Router intercepts
    ↓
Try Provider-A -> Provider-B -> Provider-C
- check cooldown
- check circuit breaker
- forward to real provider
- on error: record failure, try next
    ↓
If all channels fail, try fallback model
    ↓
Stream events back to user
```

### Sticky Mode

Sticky mode remembers the last successful route and tries it first on next request:

```text
Request 1: Provider-A succeeds → sticky = Provider-A
Request 2: Provider-A tried first → succeeds
Request 3: Provider-A fails → clear sticky, try Provider-B → succeeds → sticky = Provider-B
Request 4: Provider-B tried first
...
(Persists across pi restarts)
```

Use `/router sticky clear` to reset and re-route from the beginning.

### Circuit Breaker

```text
Failures: 0 -> 1 -> 2 -> 3 -> 4 -> 5 (open)
    ↓
Block requests for a cooldown window
    ↓
Half-open: allow a test request
    ↓
Success -> closed
Failure -> open again
```

### Context Transfer

When switching models:

1. `summary` mode: summarize the conversation
2. sanitize incompatible context fields if needed
3. forward the adapted context to the fallback model

## Configuration Reference

### Main File

```text
~/.pi/agent/pi-router.json
```

### Typical Configuration

```json
{
  "strategy": "channelFirst",
  "sortBy": "latency",
  "autoSync": true,
  "sticky": true,
  "healthProbe": {
    "enabled": false
  },
  "models": [
    {
      "id": "example-model",
      "channels": ["Provider-A", "Provider-B", "Provider-C"]
    }
  ]
}
```

### Global Options

```json
{
  "strategy": "channelFirst",
  "sortBy": "latency",
  "autoSync": true,
  "sticky": true,
  "contextTransfer": "summary",
  "summaryModel": "optional-summary-model",
  "summaryPrompt": "optional custom prompt",
  "summaryMaxTokens": 2000,
  "failover": {
    "cooldownMs": 60000
  },
  "healthProbe": {
    "enabled": true,
    "intervalMs": 600000,
    "timeoutMs": 10000,
    "probeMessage": "ping"
  }
}
```

### Summary AI Behavior

Default behavior:

- `summaryModel` is not required
- if the current context still fits inside the selected target model's context window, pi-router skips summary generation and forwards the full context
- when a summary is needed and `summaryModel` is unset, pi-router first uses the target model for summary generation
- if AI summary generation fails, pi-router falls back to a plain text non-AI summary path
- `summaryMaxTokens` defaults to `2000`

Optional dedicated summary AI configuration:

```json
{
  "contextTransfer": "summary",
  "summaryModel": "cheap-summary-model",
  "summaryPrompt": "Summarize the conversation for model handoff.",
  "summaryMaxTokens": 2000
}
```

`summaryModel` supports either:

- `model-id`
- `model-id@provider`

### Per-Model Options

```json
{
  "id": "example-model",
  "channels": ["Provider-A", "Provider-B"],
  "sticky": true,
  "sortBy": "latency",
  "contextTransfer": "summary",
  "fallbackModels": [
    {
      "id": "fallback-model",
      "channels": ["Provider-A", "Provider-B"]
    }
  ],
  "failover": {
    "cooldownMs": 30000
  }
}
```

### Manual Editing

You can edit `~/.pi/agent/pi-router.json` directly.

After editing:

```text
/reload
```

or restart pi.

## Performance

pi-router is optimized for fast startup with minimal overhead.

### Startup Optimization

- smart file hash caching
- lazy loading of `models.json`
- deferred health probe startup
- reduced duplicate file I/O

### Typical Improvement

| Scenario | Before | After | Improvement |
|----------|--------|-------|-------------|
| Hot cache | ~50-80ms | ~5-15ms | ~80% |
| Cold cache | ~50-80ms | ~30-50ms | ~40% |
| autoSync disabled | ~30-50ms | ~5-10ms | ~80% |
| healthProbe disabled | ~40-60ms | ~5-15ms | ~75% |

See [PERFORMANCE_OPTIMIZATION.md](PERFORMANCE_OPTIMIZATION.md) for details.

## Uninstall

```bash
# npm install
pi remove npm:pi-router

# git install
pi remove git:github.com/jiangjilin/pi-router

# local install
pi remove /path/to/pi-router
```

Configuration files are not removed automatically.

```bash
rm -f ~/.pi/agent/pi-router.json ~/.pi/agent/pi-router.README.md
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design documentation.

## Further Reading

- [INSTALL.md](./INSTALL.md)
- [TESTING.md](./TESTING.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CHANGELOG.md](./CHANGELOG.md)

## License

MIT

## Credits

Built with the [pi coding agent](https://github.com/pi-agi/pi-coding-agent) extension API.
