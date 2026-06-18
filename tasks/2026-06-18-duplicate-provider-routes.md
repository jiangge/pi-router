# Task: Same-provider model variant routes in config/order UI

Date: 2026-06-18
Status: implemented in pi-router; validated by typecheck/build/tests

## Background

Canonical aliases and `modelByChannel` let one router model group upstream model-name variants such as:

- `deepseek-v4-flash`
- `DeepSeek-V4-Flash`
- `oc/deepseek-v4-flash-free`

This works when each provider/channel appears only once in a canonical model group. However, some providers can expose both the canonical upstream model name and one or more variant names at the same time, for example:

```text
deepseek-v4-flash @ wx-api
oc/deepseek-v4-flash-free @ wx-api
```

A single `modelByChannel: Record<channel, upstreamModel>` cannot represent both routes, because the provider key can only appear once.

The user goal is practical config editing: in `/router config order` and related config UI, the same real model should be sortable as one canonical model queue, with variant routes shown as channel entries annotated by the real upstream model name.

Example UI target:

```text
deepseek-v4-flash
  deepseek
  wx-api
  wx-api (oc/deepseek-v4-flash-free)
  abrdns-ds (DeepSeek-V4-Flash)
```

Normal routes should not be annotated. Variant routes should be annotated. The label is display-only and must not be written into `channels`.

## Goals

1. Support multiple routes for the same provider/channel under one canonical router model when upstream model IDs differ.
2. Keep existing `channels` + `modelByChannel` configs valid.
3. Add a compact optional `routes` representation only when duplicate provider routes need to be distinguished.
4. Show variant routes in config/order UI as `channel (upstreamModel)`.
5. Preserve runtime semantics: requests still call the real upstream provider/model; cache stats still use upstream assistant metadata.
6. Make `/router sync` and config order preserve duplicate-provider variant routes.
7. Keep implementation generic; no DeepSeek-specific code paths.

## Proposed config shape

Existing simple shape remains supported:

```json
{
  "id": "deepseek-v4-flash",
  "channels": ["deepseek", "abrdns-ds", "wx-api"],
  "aliases": ["DeepSeek-V4-Flash", "oc/deepseek-v4-flash-free"],
  "modelByChannel": {
    "abrdns-ds": "DeepSeek-V4-Flash",
    "wx-api": "oc/deepseek-v4-flash-free"
  }
}
```

New optional shape for duplicate provider routes:

```json
{
  "id": "deepseek-v4-flash",
  "aliases": ["DeepSeek-V4-Flash", "oc/deepseek-v4-flash-free"],
  "routes": [
    { "channel": "deepseek" },
    { "channel": "wx-api" },
    { "channel": "wx-api", "model": "oc/deepseek-v4-flash-free" },
    { "channel": "abrdns-ds", "model": "DeepSeek-V4-Flash" }
  ]
}
```

Rules:

- `route.channel` is the provider/channel.
- `route.model` is the exact upstream model ID. If omitted, canonical `modelConfig.id` is used.
- Same `channel` may appear multiple times if `model` differs.
- Existing `channels` and `modelByChannel` are treated as a legacy/simple route list.
- For compatibility and old tooling, `channels` may remain present as a provider summary, but runtime ordering should prefer `routes` when present.

## Custom strategy

Existing `customOrder` strings cannot distinguish duplicate routes:

```json
"customOrder": ["deepseek-v4-flash@wx-api"]
```

Add optional `customRoutes`:

```json
"customRoutes": [
  { "model": "deepseek-v4-flash", "channel": "wx-api" },
  { "model": "deepseek-v4-flash", "channel": "wx-api", "upstreamModel": "oc/deepseek-v4-flash-free" }
]
```

Runtime reads `customRoutes` first; falls back to `customOrder`.

## Implementation notes

Implemented in `router-routes.ts`, `index.ts`, and the config wizard/order UI:

- Added shared route helpers:
  - `getModelRouteEntries(modelConfig)`
  - `makeRouteKey(channel, upstreamModelId, canonicalModelId)`
  - `getRouteDisplayLabel(route)`
  - `getRouteSignature(route)`
  - `serializeRouteEntriesForConfig(...)`
- Runtime routing now prefers structured `routes` when present and uses route keys such as `wx-api#oc/deepseek-v4-flash-free` to distinguish same-provider variants.
- Auto routing, custom routing, failover, sticky state, cooldown/circuit state, health probes, route snapshots, and `/router sync` preserve duplicate same-provider upstream IDs.
- The config/order UI carries route metadata while rendering display-only labels like `wx-api (oc/deepseek-v4-flash-free)`.
- Channel-first order saves duplicate-provider entries as `routes`; custom strategy saves `customRoutes` and still keeps `customOrder` route-key strings for compatibility.

## Tests

Regression coverage added for:

1. Same provider has canonical and variant upstream models under one canonical router model.
2. `createMirrorModels` and `createFailoverStream` route both entries separately.
3. Config order UI displays `channel (upstreamModel)` but saves route objects, not labels.
4. Custom strategy can distinguish duplicate provider routes via `customRoutes`.
5. `/router sync` grouping preserves duplicate provider variants.

## Validation

```text
npm run build
npm run typecheck
npm test
```

All passed. Current suite: 77 tests.
