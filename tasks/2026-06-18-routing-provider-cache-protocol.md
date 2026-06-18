# Task: Generic routing-provider cache protocol for pi-router

Date: 2026-06-18
Status: implemented in pi-router; companion pi-cache-optimizer task completed and archived

## Background

`pi-cache-optimizer` needs to support virtual routing providers without hard-coding each router implementation. This includes:

- `pi-router` (`provider: "router"`)
- `pi-auto-router` (`provider: "auto-router"`)
- future router-like Pi extensions that register a virtual provider and internally call real upstream providers via `streamSimple`

The desired design is protocol-based, not package-based. `pi-router` should expose its active route through a generic routing-provider protocol, while `pi-cache-optimizer` should consume that protocol and still use assistant message metadata as the authoritative source for completed cache stats.

Companion task in `pi-cache-optimizer`:

```text
/home/jiang/jiang/source/pi-cache-optimizer/.trellis/tasks/06-18-06-18-routing-provider-cache-protocol/prd.md
```

Related pi-router alias task:

```text
tasks/2026-06-18-router-model-aliases.md
```

## Goals

1. Let `pi-cache-optimizer` observe `pi-router` active routes without importing or hard-coding `pi-router` internals.
2. Keep final cache stats attributed to the real upstream provider/model, not `router/<canonical>`.
3. Support canonical model aliases where router-facing model IDs differ from upstream model IDs.
4. Use a generic protocol that can also be implemented by `pi-auto-router` and future routers.
5. Avoid global singleton route state for final stats correctness.
6. Preserve existing `pi-router` behavior when `pi-cache-optimizer` is not installed.

## Non-goals

- Do not implement pi-auto-router policy/profile/budget/UVI features in this project.
- Do not import `pi-cache-optimizer` from `pi-router`.
- Do not require `pi-cache-optimizer` at install time.
- Do not rewrite `models.json` for aliases.
- Do not canonicalize or overwrite real upstream assistant message metadata.
- Do not publish packages until both repository-specific implementations are complete and validated.

## Recommended architecture

Use three layers:

### Layer 1: Completed stats come from assistant message metadata

For completed requests, the authoritative identity is the relayed assistant message:

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

`pi-router` requirement:

- Preserve upstream `provider`, `model` / `responseModel`, `api`, and `usage` on assistant events.
- Do not rewrite these fields to `router` or the canonical router model id.

This keeps cache stats request-local and robust even if live route state changes before `message_end`.

### Layer 2: Live route / doctor / compat use routing registry

For live UI and diagnostics before a final assistant message exists, `pi-router` should register itself in a generic routing registry:

```ts
const PI_ROUTING_REGISTRY = Symbol.for("pi.routing.registry.v1");
```

The registry is owned by convention, not by a package dependency. `pi-router` registers an adapter for virtual provider `router`. `pi-cache-optimizer` consumes it if present.

### Layer 3: Prompt/cache-key passthrough uses cache hints service

`pi-cache-optimizer` should expose cache hints through:

```ts
const PI_CACHE_HINTS = Symbol.for("pi.cache.hints.v1");
```

`pi-router` can read these hints before calling real upstream `streamSimple`:

- optimized system prompt, if available
- prompt cache key, if available
- cache retention hint, if available

This replaces package-specific globals like `__piCacheOptimizerPrompt__` / `__piCacheOptimizerCacheKey__` as the preferred path. Compatibility shims may remain in `pi-cache-optimizer` temporarily, but new router integration should use symbols.

## Protocol sketch

This is the shared contract target. Final implementation may adjust naming, but should preserve the same responsibilities.

```ts
const PI_ROUTING_REGISTRY = Symbol.for("pi.routing.registry.v1");
const PI_CACHE_HINTS = Symbol.for("pi.cache.hints.v1");

type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: { sessionIdHash?: string; requestId?: string }
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};

type PiRoutingRegistryV1 = {
  version: 1;
  registerRouter(adapter: PiRouterAdapterV1): () => void;
  getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined;
};

type PiCacheHintsV1 = {
  version: 1;
  getHints(input: {
    sessionIdHash?: string;
    virtualProvider?: string;
    virtualModelId?: string;
    upstreamProvider?: string;
    upstreamModelId?: string;
    api?: string;
  }): {
    systemPrompt?: string;
    promptCacheKey?: string;
    cacheRetention?: "long";
  } | undefined;
};
```

## pi-router implementation status

Implemented in `index.ts`:

- Registers adapter for virtual provider `router` via `Symbol.for("pi.routing.registry.v1")` during extension activation.
- Tracks active route snapshots with virtual/canonical/upstream identities and route status transitions.
- Exposes active and candidate route resolvers through the routing registry.
- Reads optional cache hints from `Symbol.for("pi.cache.hints.v1")` before real upstream `streamSimple` calls.
- Applies cache hints to `context.systemPrompt`, `options.sessionId`, and `options.cacheRetention`.
- Keeps summary and health-probe internal calls from consuming request cache hints where appropriate.
- Preserves real upstream assistant message metadata by forwarding provider events unchanged.

Validation run:

```text
npm run build
npm run typecheck
npm test
```

All passed.

Companion pi-cache-optimizer status:

- The companion task is archived as completed at `/home/jiang/jiang/source/pi-cache-optimizer/.trellis/tasks/archive/2026-06/06-18-06-18-routing-provider-cache-protocol/`.
- The companion implementation landed in pi-cache-optimizer commit `e07ccda` (`feat: add routing provider cache protocol`).
- Verified current pi-cache-optimizer type safety with `./node_modules/.bin/tsc --noEmit`.
- The archived verifier expects `bun`, which is not installed in this environment, so that script was not rerun here.

Optional manual validation before release:

- Run an end-to-end route such as `router/deepseek-v4-flash -> wx-api/oc/deepseek-v4-flash-free` and confirm cache stats are keyed by the upstream provider/model.

## pi-router implementation responsibilities

### 1. Register virtual provider adapter

At extension activation, register a router adapter if the global routing registry exists. If it does not exist yet, create a minimal registry or retry/ensure registration in a safe way compatible with other extensions.

Adapter identity:

```ts
virtualProvider: "router"
```

### 2. Track active route snapshots

Whenever `pi-router` selects or attempts a route, update route state with both virtual and real identities.

Example for canonical alias routing:

```json
{
  "virtualProvider": "router",
  "virtualModelId": "deepseek-v4-flash",
  "canonicalModelId": "deepseek-v4-flash",
  "provider": "wx-api",
  "modelId": "oc/deepseek-v4-flash-free",
  "api": "openai-completions",
  "status": "trying",
  "timestamp": 1781726400000
}
```

Status transitions should be best-effort:

```text
planned -> trying -> selected/success
planned -> trying -> failed -> next trying
```

### 3. Expose active route resolver

`resolveActiveRoute(virtualModelId, hint)` should return the latest useful route snapshot for that virtual model. Prefer session-scoped state when `sessionIdHash` is available. Fall back to last known route only for display/diagnostics, not for final stats.

### 4. Expose candidate route resolver

`resolveCandidateRoutes(virtualModelId)` should return configured upstream candidates for a router model. This is useful for diagnostics and future tools. It should understand canonical alias config:

```text
router/deepseek-v4-flash
  -> deepseek/deepseek-v4-flash
  -> abrdns-ds/DeepSeek-V4-Flash
  -> wx-api/oc/deepseek-v4-flash-free
```

### 5. Use cache hints before inner streamSimple

Before calling the real provider, read cache hints when present:

```ts
const hints = globalThis[PI_CACHE_HINTS]?.getHints({
  virtualProvider: "router",
  virtualModelId: canonicalOrRouterModelId,
  upstreamProvider: upstreamModel.provider,
  upstreamModelId: upstreamModel.id,
  api: upstreamModel.api,
});
```

Then pass safe hints to the inner request path. Preserve existing request keys and avoid overriding user/provider-specific fields.

### 6. Preserve upstream assistant metadata

The relayed assistant events must keep true upstream fields:

- `provider`
- `model` / `responseModel`
- `api`
- `usage`

Do not overwrite them with:

- `provider: "router"`
- canonical model id
- alias group id

This is the main correctness requirement for `pi-cache-optimizer` final stats.

## pi-cache-optimizer companion responsibilities

Tracked in the Trellis task above. Summary:

1. On `message_end`, prefer assistant message real provider/model metadata for final stats.
2. Use `pi.routing.registry.v1` for live route footer, doctor, compat, and reset UX.
3. Expose `pi.cache.hints.v1` for optimized prompt/cache-key passthrough.
4. Keep old PR #2 globals as temporary compatibility shims if needed.
5. Avoid hard-coding package-specific logic beyond fallback compatibility.

## Coordination / release plan

1. Keep this task and the pi-cache-optimizer Trellis task in planning until implementation starts.
2. Implement `pi-cache-optimizer` protocol support first or in parallel.
3. Implement `pi-router` registry adapter and cache hints consumption.
4. Implement canonical alias routing in `pi-router` using `tasks/2026-06-18-router-model-aliases.md`.
5. Validate both repos together locally.
6. Commit, push, and publish each repository separately:
   - `pi-cache-optimizer`: its own git commit/tag/publish
   - `pi-router`: its own git commit/tag/publish
7. Do not mix both repositories into a single git operation.

## Tests / verification

### pi-router tests

- Registers routing adapter for `virtualProvider: "router"`.
- Route snapshot includes both canonical router id and upstream model id.
- Alias route `router/deepseek-v4-flash -> wx-api/oc/deepseek-v4-flash-free` reports correct upstream provider/model.
- Candidate resolver returns all configured upstream candidates.
- Route status updates on attempt, success, and failover.
- Cache hints are read and forwarded to inner provider calls without overriding existing request values.
- Assistant message metadata remains upstream-real after relay.

### Cross-repo manual verification

Use `pi-router` selected model:

```text
router/deepseek-v4-flash
```

Route to upstream:

```text
wx-api / oc/deepseek-v4-flash-free
```

Expected:

- pi-cache-optimizer footer stats bucket is real upstream provider/model.
- `/cache-optimizer doctor` diagnoses `wx-api/oc/deepseek-v4-flash-free`, not `router/deepseek-v4-flash`.
- `/cache-optimizer compat` checks the upstream `PiModel` from model registry.
- `/reload` restores last actual routed model stats.
- No stats are stored under `router/deepseek-v4-flash` unless upstream message metadata is missing and fallback is unavoidable.

## Guardrails

- Final cache stats must never depend solely on live route state.
- Live route state is best-effort UI/diagnostic context only.
- Keep protocol versioned.
- Keep protocol optional.
- Avoid package imports between router and optimizer.
- Avoid process-global singleton prompt/cache values when session/request-scoped hints are available.
- Do not continue implementing code until this task and the companion optimizer task are accepted as the plan.
