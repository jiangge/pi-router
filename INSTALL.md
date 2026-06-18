# Installation Guide

Pi-router is a standard pi extension. Installation is simple and follows pi's extension management commands.

## Quick Install

### From npm (after publication)

```bash
# Install globally
pi install npm:pi-router

# Or install for current project only
pi install npm:pi-router -l
```

### From GitHub

```bash
# Install from git
pi install git:github.com/jiangge/pi-router

# Or with specific version/tag
pi install git:github.com/jiangge/pi-router@v0.3.0
```

### From Local Directory (for development)

```bash
# Install from local path
pi install /path/to/pi-router

# Or relative path
pi install ./pi-router
```

---

## Configuration

Recommended configuration method:

```bash
/router config wizard
```

Or create configuration file manually at `~/.pi/agent/pi-router.json`:

### Minimal Configuration

```json
{
  "strategy": "channelFirst",
  "models": [
    {
      "id": "claude-opus-4-8",
      "channels": ["anthropic", "openrouter"]
    }
  ]
}
```

### Full Configuration

See `examples/router.config.json` for all available options.

---

## Verify Installation

```bash
# List installed packages
pi list

# Should show: pi-router@0.3.0-alpha.1
```

Start pi, then verify the command is available:

```bash
/router config show
```

Normal startup is quiet by default. For debug logs only:

```bash
PI_ROUTER_DEBUG=1 pi
```

---

## Usage

### Available Commands

```bash
/router status       # Show current configuration
/router list         # List available router models
/router pricing      # Show per-channel pricing
/router explain      # Show health, failures, and circuits
/router decisions    # Show recent routing decisions
/router probes       # Show background health probe results
/router sync         # Check for model changes
/router diff         # Preview configuration differences
```

### Select Router Model

```bash
/model
# Select router/model-name from the list
```

Router models are prefixed with `router/`:
- `router/claude-opus-4-8`
- `router/gpt-5.5`
- etc.

---

## Update

```bash
# Update pi-router
pi update npm:pi-router

# Or update all packages
pi update
```

---

## Uninstall

```bash
# Remove pi-router
pi remove npm:pi-router

# Or for git installations
pi remove git:github.com/jiangge/pi-router

# Or for local installations
pi remove /path/to/pi-router
```

The configuration files will remain. Delete them manually if needed:

```bash
rm -f ~/.pi/agent/pi-router.json ~/.pi/agent/pi-router.README.md
```

---

## Troubleshooting

### Extension not loading

1. Check installation:
   ```bash
   pi list
   ```

2. Restart pi or reload:
   ```bash
   /reload
   ```

3. Check logs for errors

### Configuration not found

Pi-router works without configuration (auto-discovery mode). To use custom configuration:

1. Create `~/.pi/agent/pi-router.json`
2. Add at least `strategy` and `models`
3. Restart pi or `/reload`

### Commands not available

If `/router` commands are not available:

1. Verify installation with `pi list`
2. Try `/reload`
3. Restart pi
4. Check for conflicts with other extensions
5. Use `PI_ROUTER_DEBUG=1 pi` to inspect debug logs

---

## Development Setup

For contributors or local development:

### 1. Clone Repository

```bash
git clone https://github.com/jiangge/pi-router.git
cd pi-router
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build
```

### 4. Install Locally

```bash
# Method 1: Using pi install
pi install .

# Method 2: Symlink package root (for development)
ln -sfn $(pwd) ~/.pi/agent/extensions/pi-router
```

Use the package root, not `dist/`. The package root lets pi identify the extension as `pi-router` instead of `dist`.

### 5. Watch Mode (for development)

```bash
npm run watch
```

Changes will be automatically recompiled. Use `/reload` in pi to load updates.

---

## Platform-Specific Notes

### Linux / macOS

Standard installation works out of the box.

### Windows

Use PowerShell or Command Prompt:

```powershell
pi install npm:pi-router
```

Configuration file location: `%USERPROFILE%\.pi\agent\pi-router.json`

---

## Next Steps

- See [README.md](README.md) for feature overview
- See [TESTING.md](TESTING.md) for test scenarios
- See [examples/](examples/) for configuration examples
- Check [CHANGELOG.md](CHANGELOG.md) for version history

---

**Version**: v0.3.0-alpha.1  
**Author**: Jiang Jilin  
**License**: MIT
