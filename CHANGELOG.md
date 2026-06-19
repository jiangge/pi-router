# Changelog

All notable changes to pi-router will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-06-19

### Added

- **Auth-only builtin sync**: `/router sync` now imports builtin models for authenticated providers found only in `auth.json`, while still respecting explicit `models: []` provider disables in `models.json`.
- **Config multi-select editing**: `/router config order` now supports selecting multiple models, channels, or custom model/channel pairs with `Space`, range selection with `Shift+Up/Down`, select-all with `a`, grouped movement with `Enter`, and confirmed deletion with `Delete`.

### Fixed

- **Deprecated model filtering**: Deprecated models are silently filtered from sync candidates, configurable model discovery, model maps, and health probe scheduling. The filter covers structured deprecation fields and model IDs/names containing `deprecated`.
- **Custom route persistence**: Custom strategy saves now rebuild `models`, `customOrder`, and `customRoutes` from the remaining model/channel pairs so deleted pairs do not leave stale config entries.

### Tests

- Expanded regression coverage to 81 passing tests, including auth-only sync, deprecated filtering, health probe scheduling, and multi-select config editing.

## [0.4.0] - 2026-06-18

### Added

- **Canonical router model aliases**: `pi-router.json` models now support `aliases`, `modelByChannel`, and optional `routes`, allowing one router-facing model ID to group provider-specific upstream model names without editing `models.json`.
- **Alias-aware routing**: failover, auto mode, custom/customRoutes order, fallback models, mirror model registration, health probes, and `/router sync` now resolve the real upstream model ID before calling providers.
- **Same-provider variant routes**: config/order UI can sort duplicate provider routes independently and labels variants as `channel (upstreamModel)` without writing labels into config.
- **Generic routing-provider protocol**: pi-router registers `Symbol.for("pi.routing.registry.v1")` snapshots for active/candidate routes and consumes `Symbol.for("pi.cache.hints.v1")` cache hints for optimized system prompts, prompt cache keys, and cache retention.

### Fixed

- `/router sync` now folds configured aliases into canonical model groups and writes `modelByChannel` entries when upstream IDs differ from the canonical router ID.
- Upstream assistant message metadata (`provider`, `model` / `responseModel`, `api`, `usage`) remains untouched so cache stats stay attributed to the real provider/model.

### Tests

- Expanded router regression coverage to 77 passing tests, including canonical DeepSeek alias routing, duplicate same-provider variant routes, config/order preservation, and protocol/cache-hint forwarding.

## [0.3.2] - 2026-06-14

### Fixed

- **Explicit model precedence**: `provider.models` entries now correctly override provider-level `headers` and `compat` defaults instead of being overwritten by them during model expansion.
- **Explicit provider disable**: Providers declared in `models.json` with `models: []` now stay disabled even when the same provider appears in `auth.json`.

### Tests

- Expanded router regression coverage to 64 passing tests.
- Added behavior tests for config wizard keyboard flows, ordering editors, channel ordering, cooldown/failover behavior, fallback summary transfer, and committed-stream failover safety.

## [0.3.1] - 2026-06-14

### Fixed

- **Config preservation**: `saveConfig()` now preserves advanced fields (`auto`, `request`, `footer`, `stickyRecords`, `intent`) when writing JSON-safe comments, preventing manual options and sticky routing state from being dropped during config saves.
- **Footer options**: Clarified that `footer.rightAlignRoute` defaults to enabled and implemented `footer.statusLine=false` for suppressing the built-in status-line fallback when footer replacement is disabled.

### Documentation

- Documented `request` and `footer` global options in English and Chinese READMEs.
- Generated `pi-router.README.md` now explains `auto`, `request`, and footer defaults for manual config editing.

## [0.3.0] - 2026-06-14

### Fixed

#### Critical Performance Issues
- **Hot path optimization**: Cache modelMap to avoid O(n) rebuild on every streaming request (100-500x speedup)
- **File system optimization**: Consolidate and cache provider ID loading with mtime checks
- **Algorithm optimization**: Use Set for O(1) lookups instead of O(n²) array filtering in channel merging

#### Critical Correctness Issues
- **Config mutation bug**: Replace in-place mutation with immutable config snapshots to prevent stale references
- **Format validation**: Validate custom order format before split('@') to prevent undefined channel names
- **Config preservation**: Preserve configured models even when channels are temporarily unavailable
- **Error visibility**: Surface modelOverrides errors to users (console.warn vs debugLog), with smart detection for OAuth providers

#### Behavior Fixes
- **Provider disabling**: Respect explicit `models:[]` to disable provider (no unintended builtin fallback)
- **Type safety**: Safer getBuiltinPiAiModels handling with explicit type checks
- **Failover order**: Use first *configured* channel not first *available* to preserve user's failover order

#### Code Quality Improvements
- **Code deduplication**: Extract mergeModelProps() helper to eliminate 4x duplication of header/compat merge logic
- **Single responsibility**: Consolidate loadAuthProviderIds() and loadModelsJsonProviderIds() into single loadProviderIds()
- **False positive warnings**: Suppress warnings for OAuth providers (like kiro) that don't have builtin models

### Changed
- Version bumped from 0.3.0-alpha.1 to 0.3.0 (stable release)

### Technical Details
See [CODE_REVIEW_FIXES.md](./CODE_REVIEW_FIXES.md) for detailed analysis of all 15 bug fixes.

### Performance Impact
- Streaming requests: ~1-5ms → ~0.01ms overhead (100-500x improvement)
- Config operations: ~0.5-2ms → ~0.01ms when cached
- Channel filtering: O(n²) → O(n) with Set-based lookups

## [Unreleased] - 2026-06-13

### Added

#### Auto Router Mode (`router/auto`)
- **Virtual model `router/auto`**: Full automatic routing through all configured models and channels
- **channelFirst strategy**: Try all channels of model A, then all channels of model B, etc.
- **custom strategy** (renamed from modelFirst): Fully customizable order for all model@channel pairs
  - Uses `customOrder` array in config file for explicit ordering
  - Config wizard provides flat list editor for drag-and-drop reordering
  - Initial order generated from the discovered model/channel list and then saved explicitly in `customOrder`
- **Persistent sticky routing**: Remember the last successful model@channel across restarts
  - On success: update sticky record (debounced 5s file write)
  - On failure: clear sticky, fall back to normal strategy
  - `/router sticky` command to view/clear sticky records
- **Footer status**: Show active channel via `setStatus` (e.g., `via anthropic`)
- **Model select event**: Clear footer status when switching away from router models

#### Configuration Wizard Enhancements
- **Three editor modes**: 
  - channelFirst: Two-tier editor (model order + channel order per model)
  - custom: Flat editor (all model@channel pairs in one customizable list)
- **Flat order editor** (`FlatOrderEditor`): New component for custom strategy
  - Shows all model@channel combinations in a flat list
  - Support arbitrary position swapping
  - Viewport scrolling for long lists
- **Better error reporting**: Detailed failure summary when all channels exhausted
- **Footer status updates**: Show active channel immediately when attempting, not just on success

#### Interactive Menus and Tab Completion
- **Interactive main menu**: `/router` without args opens SelectList with all subcommands
- **Interactive config submenu**: `/router config` without args opens wizard/order/show/reset menu
- **Two-level tab completion**: First level (9 subcommands), second level (config sub-commands)
- **Trailing space detection**: Proper handling of `"config "` vs `"config"` for tab trigger

#### New Commands
- `/router sticky` — View current sticky routing records
- `/router sticky clear` — Clear all sticky records (re-route from beginning)
- `/router sticky clear <modelId>` — Clear specific model's sticky record

#### Interactive Configuration Wizard
- **Configuration wizard command**: `/router config wizard` - 6-step guided setup
- **Smart channel classification**: Auto-detect OAuth, free/self-hosted, and aggregator channels
  - Scan auth.json for OAuth providers
  - Check baseUrl for local addresses (localhost, 192.168.x.x, etc.)
  - Match official domains (api.anthropic.com, api.openai.com, etc.)
  - Default to aggregator for third-party platforms
- **Intelligent channel sorting**: Auto-sort by latency, capability, or cost
  - Latency priority: aggregator > OAuth > local
  - Capability priority: OAuth > aggregator > self-hosted
  - Cost priority: self-hosted > aggregator > OAuth
- **Interactive channel order adjustment**: 
  - Browse mode: navigate with arrow keys
  - Enter to select channel for moving
  - Arrow keys to move selected channel
  - Enter again to confirm position
  - Tab to switch between models
- **Configuration commands**:
  - `/router config wizard` (or `/router config w`) - Run setup wizard
  - `/router config order` (or `/router config o`) - Adjust existing model/channel order
  - `/router config show` (or `/router config s`) - Display current configuration
  - `/router config reset` (or `/router config r`) - Reset to defaults
- **Shortcut support**: Type command prefixes (w, o, s, r) for quick access
- **Auto-discovery**: Automatically find multi-channel models from models.json
- **Smart defaults**: Intelligent default values for advanced settings

#### Configuration Features
- Wizard steps:
  1. Routing strategy (channelFirst / custom)
  2. Sort strategy (latency / capabilityFirst / cost / manual)
  3. Auto-sync (enable / disable)
  4. Health probe (10min interval / disabled)
  5. Sticky mode (enable / disable)
  6. Channel order adjustment (interactive editor)
- Channel classification based on:
  - auth.json entries (OAuth authentication)
  - baseUrl patterns (local vs remote)
  - Official domain matching
- Real-time channel scoring and sorting
- User-adjustable channel order with visual feedback
- Completion summary with configuration preview

### Performance

#### Startup Optimization (40-80% faster)
- **Smart File Hash Caching**: Cache file hashes based on mtime, avoiding redundant SHA-256 calculations
- **Eliminated Redundant Model Loading**: Load models.json only once during initialization
- **Conditional Hash Calculation**: Only calculate file hash when autoSync is enabled
- **Deferred Health Probes**: Start health probes 1 second after initialization to avoid blocking startup
- **Optimized needsModelData Logic**: Include hasConfiguredModels to reduce redundant checks

#### Performance Improvements by Scenario
- Cold cache (first start): ~40% faster (50-80ms → 30-50ms)
- Hot cache (subsequent starts): ~80% faster (50-80ms → 5-15ms)
- With autoSync disabled: ~80% faster (30-50ms → 5-10ms)
- With healthProbe disabled: ~75% faster (40-60ms → 5-15ms)

#### Technical Details
- `fileHashCache`: Map-based cache with mtime tracking
- File I/O reduction: 50% fewer models.json reads
- Hash calculation (hot): 95% faster (full read → stat only)
- Non-blocking initialization: Health probes deferred by 1s

See [PERFORMANCE_OPTIMIZATION.md](PERFORMANCE_OPTIMIZATION.md) for detailed analysis.

---

## [0.3.0-alpha] - 2026-06-12

### Added

#### Per-Channel Pricing
- Base model pricing from official providers
- Channel pricing multipliers for different providers
- Free pricing for self-hosted channels (for example, local/self-hosted providers)
- Cost-based channel sorting (prefer free/cheap channels)
- Real cost estimation for routing decisions
- `/router pricing` command to view pricing breakdown

#### Enhanced Cost Optimization
- getChannelPricing(): Effective pricing per model@channel
- estimateRequestCost(): Calculate costs with cache tokens
- sortChannelsByCost(): Intelligent cost-based sorting
- Cost tracking in routing decisions

### Channel Types
- Official providers (1.0x): anthropic, openai, google
- Third-party aggregators (1.05x-1.1x): openrouter, together, fireworks
- Self-hosted (0.0x free): local, self-hosted
- Custom channels (configurable)

### Technical Details
- CHANNEL_PRICING_MULTIPLIERS configuration
- Weighted cost calculation (typical usage pattern)
- Cost field in RoutingDecision type
- Transparent cost visibility

---

## [0.2.0-alpha] - 2026-06-12

### Added

#### Real AI Summary Generation
- Connect to actual AI model via streamSimple for context summaries
- Use configured summary model (cheap models recommended)
- Stream response and collect text_delta events
- Estimate token usage based on response length
- Graceful fallback on errors

#### Background Health Probes
- Periodic lightweight requests to check channel availability
- Configurable interval (default: 5 minutes)
- Configurable timeout (default: 10 seconds)
- Simple probe message (default: "ping")
- Automatic probe scheduling for all channels
- Proactive circuit breaker recovery detection
- `/router probes` command to view probe results

### Configuration
- Added `healthProbe` configuration section:
  - `enabled`: Enable/disable probes
  - `intervalMs`: Probe interval in milliseconds
  - `timeoutMs`: Probe timeout in milliseconds
  - `probeMessage`: Custom probe message

### Technical Details
- Real AI API integration via pi-ai streamSimple
- Event-driven probe execution with async/await
- Automatic timer management and cleanup
- Integration with circuit breaker and health monitoring

---

## [0.1.0-alpha] - 2026-06-12

### Added

#### Core Routing
- Multi-level failover system (L1 channel + L2 model)
- Custom `streamSimple` handler for transparent interception
- Provider registration with mirror models (`router/{model-id}`)
- Real provider forwarding via `@earendil-works/pi-ai`
- Async failover stream with seamless channel switching

#### Channel Failover
- Same model, different providers (Provider-A → Provider-B → Provider-C)
- Stream-level error catching and failover
- Cooldown mechanism (60s default, configurable)
- Sticky mode for cache preservation
- Circuit breaker with fast-fail (5 failures → 2min cooldown)

#### Model Fallback
- Cross-model failover with context transfer
- Three transfer modes: none / full / summary
- AI-generated conversation summaries (default target ~2000 tokens, only when needed)
- Context sanitization for compatibility
- Fallback chain support (primary → fallback1 → fallback2 → ...)

#### Smart Routing
- Multiple sort strategies:
  - `config`: Use config file order
  - `latency`: Sort by measured time-to-first-token
  - `cost`: Sort by provider pricing (placeholder)
  - `capabilityFirst`: Prefer higher-capability providers
- Sticky-first priority (cache optimization)
- Per-model and global strategy configuration

#### Reliability Features
- **Circuit Breaker**: Open after 5 consecutive failures, test recovery after 2 minutes
- **Health Monitoring**: Track channel health, mark unhealthy after 3+ failures
- **Latency Tracking**: Record time-to-first-token, keep last 10 measurements
- **Cooldown System**: Prevent retry storms with configurable delay
- **Failure Recording**: Track last failures per channel with timestamps

#### Observability
- **Decision Logger**: Record every routing decision with latency and fallback info
- **Performance Metrics**: Average latency per channel, sample counts
- **Circuit States**: Open/half-open/closed visibility
- **Health Dashboard**: Channel health status with consecutive failure counts

#### Commands
- `/router status` - Show configuration and active models
- `/router list` - List all available router models with channels
- `/router explain` - Show failures, latency, health, circuit breakers
- `/router decisions` - Show last 20 routing decisions
- `/router sync` - Check for model changes in models.json
- `/router sync accept` - Apply detected changes
- `/router diff` - Preview config differences

#### Configuration
- JSON-based config at `~/.pi/agent/pi-router.json`
- Auto-discovery mode (sync from models.json)
- Per-model and global settings
- Context transfer strategy configuration
- Custom summary prompts
- Cooldown and threshold configuration

#### Documentation
- Comprehensive ARCHITECTURE.md with diagrams
- User-friendly README.md with examples
- Step-by-step INSTALL.md guide
- Inline code documentation

#### Build System
- TypeScript compilation to ES2022
- Declaration files for type checking
- Source maps for debugging
- Watch mode for development

### Technical Details
- Dependencies: `@earendil-works/pi-ai@^0.79.1`
- Peer dependencies: `@earendil-works/pi-coding-agent@>=0.79.0`
- Target: ES2022, Node.js 18+
- Size: ~51KB compiled (index.js)

### Known Limitations
- AI summary generation is placeholder (not connected to real API)
- Per-channel pricing not implemented (uses model-level pricing)
- Background health probes not implemented (passive health tracking only)
- No automated tests yet
- Strict TypeScript mode disabled for MVP

---

## [Unreleased] - v0.2.0

### Planned Features
- [ ] Background health probes for proactive recovery detection
- [ ] Per-channel pricing with real cost data
- [ ] Real AI summary generation using cheap models
- [ ] Decision analytics and pattern detection
- [ ] Inline fallback mode (show both responses)
- [ ] Config presets (reliability / cost / speed)
- [ ] Unit tests for core logic
- [ ] Integration tests for failover flows
- [ ] Re-enable strict TypeScript mode
- [ ] Performance benchmarks
- [ ] Prometheus metrics export (optional)

### Potential Improvements
- [ ] Retry with exponential backoff
- [ ] Request deduplication
- [ ] Response caching layer
- [ ] Multi-model parallel racing (fastest wins)
- [ ] Load balancing across channels
- [ ] Priority queues for different request types
- [ ] Webhook notifications on failures
- [ ] Dashboard web UI
- [ ] CLI tool for configuration management

---

## Version History Summary

- **v0.1.0-alpha** (2026-06-12): Initial release with full channel/model failover stack
- **v0.2.0** (planned): Background probes, tests, strict types, analytics

---

## Git Commit History

### Session 1: Foundation (10 commits)
1. Initial setup with config structure
2. Provider registration with mirror models
3. Auto-discovery from models.json
4. Multi-channel model grouping
5. Context sanitization for model switching
6. channel failover with real provider forwarding
7. model fallback with context transfer
8. Smart channel sorting (latency/cost/capability)
9. Circuit breaker and decision logger
10. Latency tracking and health monitoring
11. Documentation and build setup

See git log for detailed commit messages.
