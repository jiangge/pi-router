# Changelog

All notable changes to pi-router will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
