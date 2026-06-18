# Task: Canonical model aliases in pi-router config

Date: 2026-06-18
Status: implemented in pi-router; validated by typecheck/build/tests

## Background

Some third-party providers expose the same underlying model with different upstream model IDs, for example:

- `deepseek-v4-pro`
- `DeepSeek-V4-Pro`
- `op/deepseek-v4-pro`
- `deepseek/deepseek-v4-pro`
- `deepseek-v4-flash`
- `DeepSeek-V4-Flash`
- `oc/deepseek-v4-flash-free`

`models.json` should keep these upstream IDs unchanged because each provider may require its exact model string. The normalization should live in `~/.pi/agent/pi-router.json`: pi-router should expose one canonical router model while still forwarding each request with the provider's real upstream model ID.

## Goals

1. Keep `models.json` untouched and authoritative for provider/upstream model definitions.
2. Let `pi-router.json` group multiple upstream model IDs into one canonical router model.
3. Preserve true upstream provider/model identity in requests and assistant messages.
4. Keep pi-cache-optimizer stats keyed to the true upstream provider/model, not `router/<canonical>`.
5. Make `/router sync` alias-aware so known aliases are folded into existing canonical model groups.
6. Keep existing configs valid without requiring aliases.

## Non-goals

- Do not auto-merge semantically different models without explicit user configuration.
- Do not rewrite `models.json` model IDs.
- Do not hide the actual upstream model ID in diagnostics.
- Do not aggregate pi-cache-optimizer stats under the canonical router ID; stats should stay per actual provider/model.

## Proposed pi-router.json shape

Use per-model aliases, local to the canonical model group:

```json
{
  "id": "deepseek-v4-flash",
  "aliases": [
    "DeepSeek-V4-Flash",
    "op/deepseek-v4-flash",
    "deepseek/deepseek-v4-flash",
    "oc/deepseek-v4-flash-free"
  ],
  "channels": [
    "deepseek",
    "hello",
    "charm",
    "abrdns-ds",
    "wx-api",
    "wx-api-1"
  ],
  "modelByChannel": {
    "abrdns-ds": "DeepSeek-V4-Flash",
    "wx-api": "oc/deepseek-v4-flash-free",
    "wx-api-1": "oc/deepseek-v4-flash-free"
  }
}
```

Meaning:

- `id` is the canonical router-facing model ID.
- `aliases` declares upstream model IDs considered the same real model for grouping/sync.
- `modelByChannel[channel]` declares the upstream model ID to send to that channel when it differs from `id`.
- If `modelByChannel[channel]` is absent, default to the canonical `id`.

Optional robust lookup behavior:

1. Try `modelByChannel[channel]` if present.
2. Try canonical `id` for that channel.
3. Try aliases in order for that channel.
4. If more than one alias exists for the same channel, require explicit `modelByChannel[channel]` to avoid ambiguity.

## Routing behavior

When routing canonical `deepseek-v4-flash`:

```text
router/deepseek-v4-flash @ deepseek   -> upstream model deepseek-v4-flash
router/deepseek-v4-flash @ abrdns-ds  -> upstream model DeepSeek-V4-Flash
router/deepseek-v4-flash @ wx-api     -> upstream model oc/deepseek-v4-flash-free
```

Implementation should resolve a route to two identities:

- Canonical identity: `modelConfig.id` + `channel` for router state, cooldown, latency, sticky, UI grouping.
- Upstream identity: `upstreamModelId` + `channel` for `modelMap` lookup and actual `streamSimple` forwarding.

## Code areas to update

- `RouterModelConfig` type: add `aliases?: string[]` and `modelByChannel?: Record<string, string>`.
- Add route resolver helper, e.g. `resolveUpstreamModel(modelConfig, channel, modelMap)`.
- Replace direct lookups like `modelMap.get(`${modelConfig.id}@${channel}`)` with the resolver in:
  - mirror model creation / first configured model
  - auto mode routing
  - custom order routing
  - explicit model routing
  - fallback model routing
  - health probes
  - summary/context-transfer primary model resolution
- Keep cooldown/latency/sticky state under canonical `modelConfig.id@channel` unless there is a clear reason to expose upstream ID.
- Add actual upstream ID to decisions/debug output where helpful, e.g. `deepseek-v4-flash@wx-api -> oc/deepseek-v4-flash-free@wx-api`.
- Make `/router sync` alias-aware:
  - Build alias lookup from all `models[].id` and `models[].aliases` in `pi-router.json`.
  - Fold matching upstream models into the canonical group.
  - Auto-fill `modelByChannel` when the matched upstream ID differs from the canonical ID.
  - Preserve manual channel ordering where possible.

## pi-cache-optimizer compatibility assessment

Assessment result: OK if pi-router preserves upstream event metadata.

Current pi-cache-optimizer behavior relevant to router models:

1. While the selected model is `provider: "router"`, pi-cache-optimizer does not count stats under the router model directly.
2. On `message_end`, it calls `modelFromAssistantMessage(event.message, ctx.model)` for router models.
3. That function derives stats identity from the assistant message fields:
   - `message.provider`
   - `message.model` or `message.responseModel`
   - `message.api`
4. Stats are stored by session + `provider/model`, e.g. `wx-api/oc/deepseek-v4-flash-free`, not `router/deepseek-v4-flash`.
5. `lastRoutedModelBySession` also stores the actual routed provider/model and restores the exact footer after `/reload`.

Therefore, alias grouping will not break cache stats as long as pi-router:

- forwards to the provider with the true upstream `PiModel` (`id` = upstream model ID, `provider` = real channel), and
- relays upstream assistant events without rewriting `message.provider`, `message.model`, `message.responseModel`, `message.api`, or `message.usage` to the canonical router ID.

Important caveat: pi-cache-optimizer currently lowercases provider/model when deriving the routed model from assistant messages. That is existing behavior; it means `DeepSeek-V4-Pro` may be recorded as `deepseek-v4-pro`, but still under the real channel/provider.

No pi-cache-optimizer code change appears required for this feature. Add regression/manual verification to ensure pi-router does not accidentally canonicalize upstream assistant messages.

## Regression tests / verification

### pi-router unit tests

1. Resolver maps canonical route to upstream ID:
   - config: `id=deepseek-v4-pro`, `modelByChannel.abrdns-ds=DeepSeek-V4-Pro`
   - model map contains `DeepSeek-V4-Pro@abrdns-ds`
   - resolver returns that upstream model.

2. Resolver falls back to alias when `modelByChannel` is absent and unambiguous.

3. Mirror model registration exposes only `router/deepseek-v4-pro`, not one router model per alias.

4. Failover attempts use canonical state keys but upstream stream receives the upstream model ID.

5. `/router sync accept` folds aliases into existing canonical config and writes `modelByChannel` for non-canonical channel IDs.

6. Health probes use upstream IDs for actual probe requests.

### pi-cache-optimizer compatibility verification

Use a fake upstream stream through pi-router where selected `ctx.model` is `router/deepseek-v4-flash`, but the relayed assistant message is:

```json
{
  "provider": "wx-api",
  "model": "oc/deepseek-v4-flash-free",
  "api": "openai-completions",
  "usage": {
    "input": 100,
    "cacheRead": 900,
    "cacheWrite": 0
  }
}
```

Expected result:

- pi-cache-optimizer selects the DeepSeek adapter.
- stats key is actual route, effectively `wx-api/oc/deepseek-v4-flash-free` (case may be lowercased by existing optimizer behavior).
- stats are not recorded under `router/deepseek-v4-flash`.
- footer for router mode restores/displays the last actual routed model stats after `/reload`.

## Initial DeepSeek config candidates

Likely canonical groups for the current environment:

### `deepseek-v4-pro`

Aliases:

- `DeepSeek-V4-Pro`
- `op/deepseek-v4-pro` if present
- `deepseek/deepseek-v4-pro` if present

Known channel override candidate:

```json
"modelByChannel": {
  "abrdns-ds": "DeepSeek-V4-Pro"
}
```

### `deepseek-v4-flash`

Aliases:

- `DeepSeek-V4-Flash`
- `op/deepseek-v4-flash` if present
- `deepseek/deepseek-v4-flash` if present
- `oc/deepseek-v4-flash-free`

Known channel override candidates:

```json
"modelByChannel": {
  "abrdns-ds": "DeepSeek-V4-Flash",
  "wx-api": "oc/deepseek-v4-flash-free",
  "wx-api-1": "oc/deepseek-v4-flash-free"
}
```

## Implementation notes

Implemented in `index.ts` and covered by `tests/routing-core.test.ts`:

- `RouterModelConfig.aliases` and `RouterModelConfig.modelByChannel` are supported for primary and fallback models.
- Route resolution tries `modelByChannel[channel]`, canonical `id`, `aliases`, then other `modelByChannel` values.
- Auto routing, custom routing, failover routing, fallback routing, health probes, mirror model creation, and sync now resolve upstream model IDs through the alias-aware resolver.
- `/router sync` reads explicit `models.json` entries, folds known aliases into canonical config groups, and writes `modelByChannel` for non-canonical upstream IDs.
- Upstream `streamSimple` receives the real provider/model; relayed assistant events are not canonicalized.
- Added regression coverage for DeepSeek-style canonical alias routing and cache/protocol metadata preservation.

Validation run:

```text
npm run build
npm run typecheck
npm test
```

All passed.

## Implementation guardrails

- Before implementing, review current uncommitted `index.ts` changes and either reconcile or revert any earlier partial alias draft so the final code matches this task.
- Do not mutate the upstream `PiModel.id` to the canonical ID before calling provider `streamSimple`.
- Do not rewrite relayed upstream assistant message metadata.
- Keep error events created by pi-router as router errors; they do not carry cache usage and should not be counted by pi-cache-optimizer.
- Update README/README.zh-CN config reference after tests pass.
