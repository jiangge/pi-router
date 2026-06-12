# Changelog

All notable changes to pi-router will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0-alpha] - 2026-06-12

### Added

#### Per-Channel Pricing
- Base model pricing from official providers
- Channel pricing multipliers for different providers
- Free pricing for self-hosted channels (lan, local)
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
- Self-hosted (0.0x free): lan, local, self-hosted
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

#### L1 Channel Failover
- Same model, different providers (lan → n1-claude → run-claude)
- Stream-level error catching and failover
- Cooldown mechanism (60s default, configurable)
- Sticky mode for cache preservation
- Circuit breaker with fast-fail (5 failures → 2min cooldown)

#### L2 Model Fallback
- Cross-model failover with context transfer
- Three transfer modes: none / full / summary
- AI-generated conversation summaries (~500 tokens)
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

- **v0.1.0-alpha** (2026-06-12): Initial release with full L1/L2 failover stack
- **v0.2.0** (planned): Background probes, tests, strict types, analytics

---

## Git Commit History

### Session 1: Foundation (10 commits)
1. Initial setup with config structure
2. Provider registration with mirror models
3. Auto-discovery from models.json
4. Multi-channel model grouping
5. Context sanitization for model switching
6. L1 channel failover with real provider forwarding
7. L2 model fallback with context transfer
8. Smart channel sorting (latency/cost/capability)
9. Circuit breaker and decision logger
10. Latency tracking and health monitoring
11. Documentation and build setup

See git log for detailed commit messages.
