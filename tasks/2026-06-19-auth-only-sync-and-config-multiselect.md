# Task: auth-only sync and multi-select config editing

Date: 2026-06-19
Status: implemented in pi-router; validated by typecheck/build/tests

## Goals

1. `/router sync` should include builtin models discovered from authenticated providers in `auth.json`, even when those providers are absent from `models.json`.
2. Providers explicitly declared in `models.json` with `models: []` remain disabled and must not be re-added from `auth.json`.
3. Deprecated models must be filtered before sync, configuration discovery, model maps, and health probes. Filtering is silent in user-facing output.
4. `/router config` editors should support multi-select movement and deletion for models, channels, and custom model/channel pairs.

## Deprecated filtering

Treat a model as deprecated when either structured metadata or display text says so:

- `deprecated: true`
- `status`, `state`, or `lifecycle` is one of `deprecated`, `retired`, `sunset`, or `disabled`
- `id` or `name` contains `deprecated` case-insensitively

The filter should not print model names or counts to `/router sync`, `/router probes`, or config UI output.

## Config editor interaction

Use `model/channel pair` for custom-mode items. In simple cases this is `<model, channel>`. For provider variants it is `<model, channel, upstream model>`, so two entries with the same channel can still be edited independently.

- `Space`: enter/keep multi-select mode and toggle the current item.
- `Shift+Up` / `Shift+Down`: extend a contiguous selection range while moving the cursor.
- `a`: select all items in the current layer.
- `Esc`: cancel selection, delete confirmation, or move mode first; only fall back to the existing back/skip behavior when no temporary state is active.
- `Enter`: keep the existing move flow. With no selection, move the current item. With a selection, move the selected block.
- `Up` / `Down` in moving mode: move the current item or selected block, preserving selected-item relative order.
- `Delete`: delete the selected items, or the current item when nothing is selected. Require a second `Delete` or `Enter` to confirm; `Esc` cancels.

When deleting channels or model/channel pairs leaves a model with no routes, omit that model from the saved router config because it is no longer routable.

## Verification

- Sync imports auth-only builtin models and still respects explicit provider disable.
- Deprecated models are absent from sync/configurable candidates and model maps.
- Health probes do not schedule configured deprecated routes.
- Two-tier and flat editors support multi-select delete and block movement.

Validation run:

```text
npm run typecheck
npm test
npm run build
```

All passed. Current suite: 81 tests.
