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

## Phase 2: scoped affinity and shared failover budget

Opt in with `"affinity":{"mode":"turn","returnToPreferred":true,"minResidenceMs":30000}`. Modes: `legacy` (default), `turn`, `session`, `cache-aware`. Successful routes remain pinned through tool loops in a user turn; only a new user prompt advances the turn. Session/branch navigation invalidates scoped state. Cache-aware retention requires an explicit short/long cache-retention hint and expires after `cacheTtlMs` (default 300000); this is a bounded hint, not a measured cache saving. Minimum residence delays return-to-preferred to reduce oscillation. Recovery always uses normal cooldown/circuit admission. `sticky:false` still wins. Scoped state is not written to stickyRecords.

`"failoverBudget":{"maxAttempts":4,"maxTotalWaitMs":45000,"respectRetryAfter":true}` bounds the existing executor chain, including explicit fallback; skips do not count as attempts. Deadline abort reaches the stream relay. No second retry loop or speculative generation is added. Auxiliary fallback summarization uses deterministic text transfer when a budget is enabled, avoiding unbudgeted LLM calls. Committed text/tool output still forbids replay/failover. Structured status/code/Retry-After fields, when exposed by the provider SDK, augment the last 50 failures per model; quota, credit, rate-limit, auth and transient errors are distinguished. Missing headers are unknown, not fabricated reset times. Retry-After delays re-admission via cooldown, not a sleeping retry loop. Built-in provider SDK retries remain outside router attempt counts.

## Phase 3: allowance snapshots

All disabled by default. Example (merge with existing model configuration):

```json
{
  "routingPolicy": {"enabled": true, "objective": "smart-lite"},
  "allowance": {
    "enabled": true, "ttlMs": 60000, "timeoutMs": 1500, "backoffMs": 30000,
    "sources": [{"adapter":"openrouter-key", "providerId":"openrouter", "accountRef":"my-account", "quotaPoolId":"key-budget", "modelScope":["exact-upstream-id"]}]
  },
  "routeMetadata": {"canonical@openrouter": {"quotaPoolRef":"key-budget"}}
}
```

The real OpenRouter adapter reads `https://openrouter.ai/api/v1/key` with the active registry's OpenRouter key. It does not read auth files, accept a configurable endpoint, follow redirects, log keys or generate completions. It maps enforced `budgets` (all windows), or explicit `limit`/`limit_remaining` when budget layers are absent. These are **key spending limits**, not account credit balances. Unlimited, missing, malformed and usage-only responses are unknown. Reference: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key . Network behavior is verified with mocked HTTP, not a live credentialed request.

Snapshots carry provider/account/pool identity, exact model scope, observation timestamp, source/confidence, multiple used-share/reset/expiry windows, optional amount/unit/paid-continuation and free-plan assertion. `allowance.snapshots` also accepts explicit `manual` or `trusted-gateway` snapshots in that shape; operators must provide current data, not derive balances from local router usage. Account/pool refs must not contain secrets. Ambiguous accounts, stale/future snapshots, expired windows, missing scope/data preserve legacy ordering for the whole exact-model group. All candidates need valid snapshots, even if this means the new objective remains inactive for most providers.

Refresh is non-blocking, coalesced, cached, bounded to 1.5s by default and backed off on error; the current request does not wait for HTTP and initially falls back. Session shutdown aborts refresh. Smart-lite uses the worst window utilization and puts exhausted/near-exhausted non-paid-continuation pools behind healthy pools. This is deliberately not full magpie Smart, a price optimizer or an account scheduler. Expiring additionally requires known free-plan status (and a reset/expiry for free pools) for every candidate, preferring free allocations lapsing soon; OpenRouter spending budgets alone do NOT assert free-plan status, so expiring conservatively falls back until explicit trusted metadata supplies that information. No cross-model downgrade.

