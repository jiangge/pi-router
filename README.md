# pi-router

Transparent two-tier router for [pi coding agent](https://github.com/badlogic/pi-mono) — routes **channels** first (same model across providers), with an opt-in **model fallback chain** when exhausted.

> **auto-router routes models** (task → best model via intent/budget/quota);  
> **pi-router routes channels** (model → best channel, with model fallback when all channels fail).

## Why pi-router

- **Real model identity end-to-end** — no virtual names, no globalThis bridge protocol. Extensions like [pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer) work out of the box (adapter selection, footer stats, compat warnings, prompt optimization, cache keys).
- **Flexible routing strategies** — `channelFirst` (default, preserve model identity) or `modelFirst` (cost/capability optimized failover chain).
- **Sticky failover (cache-aware)** — fallback to a backup channel/model, stick with it to build cache, health-check the primary in background, switch back at turn boundary (not mid-request).
- **Smart model sorting** — built-in capability scores + reference pricing for auto-ranking (cost-first or capability-first), with full manual override.
- **Model fallback chain** — when all channels for `claude-opus-4-8` fail, optionally fall back to `claude-sonnet-4-6` or `gemini-3-pro`. User choice: `inline` (same request) or `switch` (session-level via `ctx.setModel`, zero stats pollution).

## Status

**v0.1.0-alpha** — MVP in progress (planning → implementation).

- [x] PRD complete
- [x] Technical foundations verified (pi 0.79.1 source)
- [ ] MVP: mirror registration + L1 channel failover + cooldown + commands + auto-sync detection
- [ ] v0.2: latency ranking, circuit breaker, L2 model fallback chain
- [ ] v0.3: inline fallback mode, overflow trigger, budget/quota, intent suggest/auto

## Install (when published)

```bash
pi install npm:pi-router
```

## Quick start (will be)

1. Config file at `~/.pi/agent/pi-router.json` (optional — auto-discovery works without config):

**Strategy 1: channelFirst (default)** — Preserve model identity, exhaust all channels before switching models

```jsonc
{
  "strategy": "channelFirst",  // default
  "auto": true,  // auto-discover same-id-multi-channel models from models.json
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "n1-claude", "run-claude"],
    "sortBy": "config",  // config | latency | cost
    "failover": { "on": ["connect", "429", "5xx", "timeout"], "cooldownMs": 60000 },
    "fallbackModels": [
      { "id": "claude-sonnet-4-6", "channels": ["lan"] },
      { "id": "gemini-3-pro", "channels": ["google"] }
    ],
    "fallbackMode": "switch",  // switch (default, zero stats pollution) | inline (micro pollution)
    "sticky": true
  }]
}
```

**Strategy 2: modelFirst** — Single-layer flat chain, all model+channel combinations in order

```jsonc
{
  "strategy": "modelFirst",
  "sortBy": "capabilityFirst",  // capabilityFirst | costFirst | manual
  "models": [
    { "id": "claude-opus-4-8", "channels": ["lan", "n1-claude"] },
    { "id": "gpt-5.5", "channels": ["hyb-gpt"] },
    { "id": "claude-sonnet-4-6", "channels": ["lan"] },
    { "id": "gemini-3-pro", "channels": ["google"] }
  ],
  "failover": { "on": ["connect", "429", "5xx", "timeout"], "cooldownMs": 60000 },
  "sticky": true
}
```

**Smart sorting modes (modelFirst only):**
- `capabilityFirst` — Uses built-in capability scores (Opus 4.8: 95, GPT-5.5: 98, Sonnet 4.6: 85)
- `costFirst` — Ranks by weighted cost (input + output + cache reads + cache writes), uses reference pricing when `models.json` cost is 0/missing
- `manual` — User-defined order from config

Router auto-generates recommended config on first run, user can accept or customize.

**Auto-sync with models.json:**
- Detects new/removed/modified channels and models from `models.json`
- Prompts user to confirm config updates (interactive TUI)
- User can accept all, accept selected, or keep current config
- Diff view shows: new channels (green), removed channels (red), modified models (yellow)

2. `/reload` in pi
3. Select `router/claude-opus-4-8` from `/model`
4. Check status: `/router status`, `/router explain`

## Commands (planned)

- `/router` — interactive menu or help
- `/router status` — current model, active channel, health
- `/router list` — all mirror entries + per-channel latency
- `/router explain [modelId]` — last routing decision
- `/router switch <modelId>` — manual channel/model switch
- `/router sync` — check models.json changes, prompt for config update
- `/router diff` — preview models.json vs current config differences

## Architecture

**Strategy 1: channelFirst (two-tier)**
```
router/claude-opus-4-8     ← mirror entry (real id/name/compat from primary channel)
  L1 (channels):  lan → n1-claude → run-claude
  L2 (models):    claude-sonnet-4-6(lan) → gemini-3-pro(google)
```

**Strategy 2: modelFirst (single-tier flat chain)**
```
router/auto-ranked     ← mirror entry (dynamic model selection)
  L1 (flat): claude-opus-4-8@lan → claude-opus-4-8@n1-claude → 
             gpt-5.5@hyb-gpt → claude-sonnet-4-6@lan → gemini-3-pro@google
```

**Provider registration:** `router` (models display as `router/claude-opus-4-8` or `router/auto-ranked`)  
**streamSimple:** forward via pi-ai `streamSimple(realModel, context, options)` with `options` preserved → `sessionId` → correct `prompt_cache_key` + session-affinity headers, zero bridge needed.

**Built-in intelligence:**
- **Capability scores:** Claude Opus 4.8: 95, GPT-5.5: 98, Sonnet 4.6: 85, Gemini 3 Pro: 90, Haiku 4.5: 75, etc.
- **Reference pricing:** Official API + third-party platform pricing (Anthropic, OpenAI, Google, run.ai, siliconflow, etc.)
- **Cost calculation:** `weighted_cost = (input_tokens × input_price) + (output_tokens × output_price) + (cache_reads × cache_read_price) + (cache_writes × cache_write_price)` with typical token distribution weights

## Roadmap

See [PRD](https://github.com/jiangge/pi-cache-optimizer/tree/master/.trellis/tasks/06-12-pi-router-transparent-two-tier-router-extension/prd.md) for full design.

- **v0.1 (MVP)**: mirror registration (auto-discovery), L1 channel failover, cooldown, context sanitizer, status bar, basic commands
- **v0.2**: latency ranking, circuit breaker (closed→open→half-open), L2 model fallback chain (switch mode), sticky + health-check primary, decision logger
- **v0.3**: inline fallback mode, overflow trigger, channel budget/quota, `@channel` shortcuts, intent suggest/auto modes

## Comparison with auto-router

| | auto-router | pi-router (channelFirst) | pi-router (modelFirst) |
|---|---|---|---|
| **Routes** | Different models per request | **Channels first** (lan → n1 → run), models second (opt-in) | **Pre-configured failover chain** (fixed order) |
| **Model identity** | Virtual (e.g. `subscription-reasoning`) | **Real** (`router/claude-opus-4-8`) | **Real** (`router/auto-ranked`) |
| **Selection logic** | Every-request AI decision (intent/budget/quota) | Channel health + model fallback | **Pre-sorted chain** (cost/capability) |
| **pi-cache-optimizer compat** | Requires globalThis bridge protocol | **Zero protocol** (works out of box) | **Zero protocol** (works out of box) |
| **Cache stability** | Every-request re-decision → cache fragmentation | **Sticky by default** (build cache on fallback target) | **Sticky by default** |
| **Use case** | Smart model selection (context-aware) | **Channel resilience + model identity** | **Static failover chain (budget/capability)** |

All three can coexist:
- **auto-router**: AI-powered model selection per request
- **pi-router channelFirst**: Same model, multiple channels, preserve identity
- **pi-router modelFirst**: Predetermined failover chain, cost or capability optimized

## Technical notes

All chain links verified against pi 0.79.1 source:
- `registerProvider` model entries preserve `compat`/`thinkingLevelMap`/`reasoning`/`contextWindow`/`cost` (model-registry.js:741-762)
- pi core injects `sessionId` into `streamSimple` options (sdk.js:216)
- Forwarding with `options` preserved → `prompt_cache_key` / session-affinity headers automatic (openai-completions.js:394-396, sdk.js:195)
- Optimized system prompt already in `context.systemPrompt` (pi-ai types.d.ts:245, agent-session.js:811)
- Extension can resolve any real channel credentials via `ctx.modelRegistry.getApiKeyAndHeaders(model)` (model-registry.js:570)
- Extension can switch active model via `ctx.setModel(model)` (extensions/types.d.ts:889)
- AssistantMessage's provider/model/api filled by real called provider (pi-ai anthropic.js:288-290)

## License

MIT
