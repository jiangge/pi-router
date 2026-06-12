# pi-router

Transparent two-tier router for [pi coding agent](https://github.com/badlogic/pi-mono) — routes **channels** first (same model across providers), with an opt-in **model fallback chain** when exhausted.

> **auto-router routes models** (task → best model via intent/budget/quota);  
> **pi-router routes channels** (model → best channel, with model fallback when all channels fail).

## Why pi-router

- **Real model identity end-to-end** — no virtual names, no globalThis bridge protocol. Extensions like [pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer) work out of the box (adapter selection, footer stats, compat warnings, prompt optimization, cache keys).
- **Channel-first failover** — your `claude-opus-4-8` stays on `lan`, falls back to `n1-claude`, then `run-claude` before exhausting. Cache stability by default.
- **Sticky failover (cache-aware)** — fallback to a backup channel/model, stick with it to build cache, health-check the primary in background, switch back at turn boundary (not mid-request).
- **Configurable two-tier routing** — channels first (default `channelFirst`), or provider-first (try all models on one provider before switching providers).
- **Model fallback chain** — when all channels for `claude-opus-4-8` fail, optionally fall back to `claude-sonnet-4-6` or `gemini-3-pro`. User choice: `inline` (same request) or `switch` (session-level via `ctx.setModel`, zero stats pollution).

## Status

**v0.1.0-alpha** — MVP in progress (planning → implementation).

- [x] PRD complete
- [x] Technical foundations verified (pi 0.79.1 source)
- [ ] MVP: mirror registration + L1 channel failover + cooldown + commands
- [ ] v0.2: latency ranking, circuit breaker, L2 model fallback chain
- [ ] v0.3: inline fallback mode, overflow trigger, budget/quota, intent suggest/auto

## Install (when published)

```bash
pi install npm:pi-router
```

## Quick start (will be)

1. Config file at `~/.pi/agent/pi-router.json` (optional — auto-discovery works without config):

```jsonc
{
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

2. `/reload` in pi
3. Select `router/claude-opus-4-8` from `/model`
4. Check status: `/router status`, `/router explain`

## Commands (planned)

- `/router` — interactive menu or help
- `/router status` — current model, active channel, health
- `/router list` — all mirror entries + per-channel latency
- `/router explain [modelId]` — last routing decision
- `/router switch <modelId>` — manual channel/model switch

## Architecture

```
router/claude-opus-4-8     ← mirror entry (real id/name/compat from primary channel)
  L1 (channels):  lan → n1-claude → run-claude
  L2 (models):    claude-sonnet-4-6(lan) → gemini-3-pro(google)
```

**Provider registration:** `router` (models display as `router/claude-opus-4-8`)  
**streamSimple:** forward via pi-ai `streamSimple(realModel, context, options)` with `options` preserved → `sessionId` → correct `prompt_cache_key` + session-affinity headers, zero bridge needed.

## Roadmap

See [PRD](https://github.com/jiangge/pi-cache-optimizer/tree/master/.trellis/tasks/06-12-pi-router-transparent-two-tier-router-extension/prd.md) for full design.

- **v0.1 (MVP)**: mirror registration (auto-discovery), L1 channel failover, cooldown, context sanitizer, status bar, basic commands
- **v0.2**: latency ranking, circuit breaker (closed→open→half-open), L2 model fallback chain (switch mode), sticky + health-check primary, decision logger
- **v0.3**: inline fallback mode, overflow trigger, channel budget/quota, `@channel` shortcuts, intent suggest/auto modes

## Comparison with auto-router

| | auto-router | pi-router |
|---|---|---|
| **Routes** | Different models (opus → gemini → deepseek) | **Channels first** (lan → n1 → run), models second (opt-in) |
| **Model identity** | Virtual (e.g. `subscription-reasoning`) | **Real** (`router/claude-opus-4-8`) |
| **pi-cache-optimizer compat** | Requires globalThis bridge protocol | **Zero protocol** (works out of box) |
| **Cache stability** | Every-request re-decision → cache fragmentation | **Sticky by default** (build cache on fallback target) |
| **Use case** | Smart model selection (intent/budget/quota) | **Channel failover + capacity management** |

Both can coexist — auto-router for cross-model intelligence, pi-router for channel-level resilience.

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
