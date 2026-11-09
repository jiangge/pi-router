# Opt-in routing policies

Defaults remain legacy (`channelFirst`, `capabilityFirst`, `sticky`). New policies only reorder routes targeting the **exact same upstream model id**, keeping their slots in the existing model chain. There is no automatic cross-model quality downgrade.

```json
{
  "routingPolicy": { "enabled": true, "objective": "cheap", "currency": "USD" },
  "sticky": false,
  "routeMetadata": {
    "canonical@provider#actual-upstream": {
      "price": { "input": 1, "output": 3, "currency": "USD", "source": "manual", "expiresAt": 1999999999999 }
    }
  }
}
```

Metadata keys are `canonical@routeKey`: `canonical@provider` when no upstream override, otherwise `canonical@provider#actual-upstream`. Do not put credentials in metadata. Prices are per million tokens. `cheap` compares a documented 1000 uncached input/500 output estimate (not actual billing); cache prices can be stored but are not assumed to predict future hits. Every candidate in an exact-model group needs fresh, non-negative finite prices in the chosen currency; otherwise that group keeps its legacy order. Static reference prices are explicitly ineligible. No currency conversion.

`free` only promotes an explicit `free: {"kind":"no-quota","source":"manual"}` (or `provider`) marker. Catalog zero prices, subscriptions, channel names and missing prices do not prove no-quota free usage. Optional `expiresAt` is milliseconds since epoch. Manual data is an operator assertion, not independently verified.

Legacy `cost`/`costFirst` retain their reference-price/multiplier behavior for compatibility; they are NOT trusted channel quotes. The unknown cost estimate now returns Infinity instead of zero. For trustworthy economics use the new opt-in block. Legacy sticky still overrides sorting and logs this explicitly. With policies enabled, incompatible image/reasoning/tools (where explicitly unsupported) and unknown/exceeded context windows are skipped before executor admission. Context-capacity checks are conservative; explicit fallback's existing summary transfer remains available.

Diagnostics: enable the existing debug logging in an isolated test config, then use `/router explain` and `/router decisions`. Policy diagnostics describe source/fallback/retention reasons, not user message text. No active price probes or quota HTTP requests happen just by installing this version.
