# Pre-Release Checklist

This checklist ensures pi-router is ready for publication.

## Code Quality

- [x] TypeScript compiles without errors
- [x] No linting errors (if linter configured)
- [x] All TODOs resolved or documented
- [x] No console.log debugging statements (except intentional logs)
- [x] Code comments are clear and helpful

## Documentation

- [x] README.md is complete and accurate
- [x] README.zh-CN.md is synchronized
- [x] CHANGELOG.md includes all versions
- [x] ARCHITECTURE.md explains design decisions
- [x] INSTALL.md has clear installation steps
- [x] TESTING.md provides testing scenarios
- [x] Example configurations provided
- [x] All commands documented
- [x] All configuration options documented

## Package Configuration

- [x] package.json version is correct (0.3.0-alpha.1)
- [x] package.json name is correct (pi-router)
- [x] package.json description is accurate
- [x] Keywords include "pi-package"
- [x] Keywords include "pi-extension"
- [x] "pi" field points to correct extension file
- [x] "files" includes all necessary files
- [x] peerDependencies are correct
- [x] dependencies are minimal
- [x] repository URL is correct
- [x] license is specified (MIT)
- [x] author is specified
- [x] homepage URL works

## Build & Distribution

- [x] `npm run build` succeeds
- [x] dist/ contains compiled JavaScript
- [x] dist/ contains type definitions
- [ ] `npm pack` produces expected tarball
- [ ] Tarball contains all necessary files
- [ ] Tarball size is reasonable (<1MB)
- [ ] .npmignore excludes development files

## Testing

- [ ] Extension loads in pi without errors
- [ ] Basic routing works (single channel)
- [ ] L1 failover works (multi-channel)
- [ ] L2 fallback works (model fallback)
- [ ] Circuit breaker opens after failures
- [ ] Circuit breaker closes after cooldown
- [ ] Context transfer works (summary mode)
- [ ] Health probes run in background
- [ ] All commands work (/router status, list, explain, etc.)
- [ ] Cost-based sorting works
- [ ] Latency tracking works
- [ ] Auto-sync detects model changes
- [ ] Sticky mode prefers last successful channel

## Commands Verification

- [ ] `/router status` - shows config
- [ ] `/router list` - lists models
- [ ] `/router explain` - shows health/circuits
- [ ] `/router decisions` - shows recent decisions
- [ ] `/router probes` - shows health probes
- [ ] `/router pricing` - shows pricing
- [ ] `/router sync` - detects changes
- [ ] `/router sync accept` - applies changes
- [ ] `/router diff` - previews differences

## Configuration

- [ ] Default config works out of box
- [ ] Minimal config example works
- [ ] Full config example works
- [ ] All config options are validated
- [ ] Invalid config shows helpful errors
- [ ] Config file path is documented

## Edge Cases

- [ ] Works with no configuration file
- [ ] Works with empty models array
- [ ] Handles missing model gracefully
- [ ] Handles missing channel gracefully
- [ ] Handles network timeouts
- [ ] Handles rate limiting
- [ ] Handles circuit breaker overflow
- [ ] Handles context too large for summary
- [ ] Handles missing summaryModel
- [ ] Works in non-interactive mode
- [ ] Works in RPC mode (if applicable)

## Performance

- [ ] Routing decision takes <50ms
- [ ] No memory leaks during long sessions
- [ ] Health probes don't impact user experience
- [ ] Circuit breaker state size is bounded
- [ ] Decision log size is bounded (max 50 entries)
- [ ] Latency tracking map size is bounded

## Security

- [ ] No hardcoded API keys
- [ ] No sensitive data logged
- [ ] Configuration validation prevents injection
- [ ] File paths are sanitized
- [ ] External input is validated

## Compatibility

- [ ] Works with pi >= 0.79.0
- [ ] Works on Linux
- [ ] Works on macOS
- [ ] Works on Windows (if applicable)
- [ ] Works with Node.js >= 18.0.0

## Git & GitHub

- [x] All changes committed
- [x] Commit messages are clear
- [x] No WIP commits in main branch
- [ ] Repository is public (or ready to be)
- [ ] .gitignore excludes unnecessary files
- [ ] GitHub repository created
- [ ] GitHub topics/tags set correctly

## Pre-Publication

- [ ] Version number follows semver
- [ ] CHANGELOG.md updated for this version
- [ ] All tests pass
- [ ] Documentation reviewed
- [ ] Example configs tested
- [ ] README screenshots/demos (optional)
- [ ] Video demo recorded (optional)

## Publication

- [ ] `npm login` successful
- [ ] `npm publish --dry-run` succeeds
- [ ] Review dry-run output
- [ ] `npm publish` succeeds
- [ ] Package appears on npmjs.com
- [ ] Package page looks correct
- [ ] Installation from npm works
- [ ] GitHub release created
- [ ] Release notes published

## Post-Publication

- [ ] Test installation: `pi install npm:pi-router`
- [ ] Verify extension loads correctly
- [ ] Test basic functionality
- [ ] Announce on social media (optional)
- [ ] Share in pi community (optional)
- [ ] Monitor for issues
- [ ] Respond to user feedback

## Version-Specific Notes

### v0.3.0-alpha.1

Current status:
- Core features complete (routing, failover, fallback)
- Health probes implemented
- Per-channel pricing implemented
- All commands working
- Documentation complete
- Ready for testing phase

Known limitations:
- No unit tests yet (deferred to v0.4.0)
- No integration tests yet
- Strict TypeScript mode disabled
- Performance benchmarks not yet measured
- Real-world usage data not yet collected

Next steps:
1. Complete testing checklist
2. Run npm pack and verify
3. Local installation test
4. Collect feedback
5. Fix any issues
6. Prepare for stable release

## Notes

- This is an alpha release: expect bugs and breaking changes
- Semantic versioning: breaking changes = major bump
- Keep CHANGELOG.md updated with every change
- Tag releases in git: `git tag v0.3.0-alpha.1`
- Push tags: `git push --tags`

## Release Decision

Ready to publish when:
- [x] All "Code Quality" items checked
- [x] All "Documentation" items checked
- [x] All "Package Configuration" items checked
- [x] All "Build & Distribution" items checked
- [ ] Critical "Testing" items checked (basic functionality)
- [ ] Critical "Commands Verification" items checked
- [ ] No blocking issues found

Status: **READY FOR TESTING PHASE**

Next action: Complete testing checklist items.
