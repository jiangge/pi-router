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

- [x] package.json version is correct (0.4.1)
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
- [x] `npm pack` produces expected tarball
- [x] Tarball contains all necessary files
- [x] Tarball size is reasonable (<1MB)
- [x] .npmignore/files whitelist excludes development files

## Testing

- [ ] Extension loads in pi without errors
- [x] Basic routing works (single channel)
- [x] L1 failover works (multi-channel)
- [x] L2 fallback works (model fallback)
- [x] Circuit breaker opens after failures
- [x] Circuit breaker closes after cooldown
- [x] Context transfer works (summary mode)
- [x] Health probes run in background
- [ ] All commands work (/router status, list, explain, etc.)
- [x] Cost-based sorting works
- [x] Latency tracking works
- [x] Auto-sync detects model changes
- [x] Sticky mode prefers last successful channel

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
- [x] Minimal config example works
- [x] Full config example works
- [ ] All config options are validated
- [ ] Invalid config shows helpful errors
- [x] Config file path is documented

## Edge Cases

- [x] Works with no configuration file
- [x] Works with empty models array
- [x] Handles missing model gracefully
- [x] Handles missing channel gracefully
- [x] Handles network timeouts
- [x] Handles rate limiting
- [x] Handles circuit breaker overflow
- [x] Handles context too large for summary
- [x] Handles missing summaryModel
- [ ] Works in non-interactive mode
- [ ] Works in RPC mode (if applicable)

## Performance

- [ ] Routing decision takes <50ms
- [ ] No memory leaks during long sessions
- [ ] Health probes don't impact user experience
- [ ] Circuit breaker state size is bounded
- [x] Decision log size is bounded (max 50 entries)
- [x] Latency tracking map size is bounded

## Security

- [x] No hardcoded API keys
- [x] No sensitive data logged
- [ ] Configuration validation prevents injection
- [x] File paths are sanitized
- [ ] External input is validated

## Compatibility

- [x] Works with pi >= 0.79.0
- [x] Works on Linux
- [ ] Works on macOS
- [ ] Works on Windows (if applicable)
- [ ] Works with Node.js >= 18.0.0

## Git & GitHub

- [x] All changes committed
- [x] Commit messages are clear
- [x] No WIP commits in main branch
- [x] Repository is public (or ready to be)
- [x] .gitignore excludes unnecessary files
- [x] GitHub repository created
- [x] GitHub topics/tags set correctly

## Pre-Publication

- [x] Version number follows semver
- [x] CHANGELOG.md updated for this version
- [x] All tests pass
- [x] Documentation reviewed
- [x] Example configs tested
- [ ] README screenshots/demos (optional)
- [ ] Video demo recorded (optional)

## Publication

- [ ] `npm login` successful
- [x] `npm publish --dry-run` succeeds
- [x] Review dry-run output
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

### v0.4.1

Current status:
- Version bumped to 0.4.1 because 0.4.0 already exists on npm.
- Auth-only builtin sync and config multi-select editing are implemented.
- Deprecated model filtering covers sync/config/modelMap/health probes.
- Typecheck, tests, build, npm pack, verify.sh, and npm publish dry-run pass.
- GitHub repository is public and reachable via gh.
- npm registry already has 0.4.0; 0.4.1 is not published yet.

Known limitations:
- npm login is not active on this machine, so real `npm publish` cannot be completed here.
- GitHub release is not created yet; create it after the publish target is finalized.
- Full interactive `/router` command verification still needs manual TUI testing.
- Strict TypeScript mode disabled
- Performance benchmarks not yet measured beyond automated unit/smoke checks
- Real-world usage data not yet collected

Next steps:
1. Run `npm login` or provide an npm token.
2. Publish `pi-router@0.4.1`.
3. Create tag/release `v0.4.1` on GitHub.
4. Test installation from npm and run manual `/router` command checks.
5. Collect feedback and monitor issues.

## Notes

- This is an alpha release: expect bugs and breaking changes
- Semantic versioning: breaking changes = major bump
- Keep CHANGELOG.md updated with every change
- Tag releases in git: `git tag v0.4.1`
- Push tags: `git push --tags`

## Release Decision

Ready to publish when:
- [x] All "Code Quality" items checked
- [x] All "Documentation" items checked
- [x] All "Package Configuration" items checked
- [x] All "Build & Distribution" items checked
- [x] Critical "Testing" items checked (basic functionality)
- [ ] Critical "Commands Verification" items checked
- [ ] No blocking issues found

Status: **READY FOR NPM LOGIN / PUBLISH PHASE**

Next action: Log in to npm, publish `0.4.1`, create GitHub release, then complete manual command verification.
