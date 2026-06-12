# Installation Guide

## Prerequisites

- Node.js 18+ (or compatible with ES2022)
- Pi coding agent v0.79.0+
- Access to multiple provider channels (lan, n1-claude, run-claude, etc.)

## Step 1: Clone and Build

```bash
cd ~/jiang/source  # or your preferred directory
git clone https://github.com/jiangge/pi-router.git
cd pi-router
npm install
npm run build
```

## Step 2: Link as Pi Extension

```bash
# Create extensions directory if it doesn't exist
mkdir -p ~/.pi/agent/extensions

# Link the extension
ln -sf $(pwd) ~/.pi/agent/extensions/pi-router
```

## Step 3: Configure Router

Create `~/.pi/agent/pi-router.json`:

```json
{
  "strategy": "channelFirst",
  "auto": true,
  "sticky": true,
  "contextTransfer": "summary",
  "sortBy": "latency",
  "models": [
    {
      "id": "claude-opus-4-8",
      "channels": ["lan", "n1-claude", "run-claude"],
      "fallbackModels": [
        {
          "id": "claude-sonnet-4-6",
          "channels": ["lan"]
        }
      ]
    }
  ]
}
```

**Or use auto-discovery** (recommended):

Set `"auto": true` and the router will automatically detect all multi-channel models from `~/.pi/agent/models.json`.

## Step 4: Verify Installation

Start pi and check that the extension loaded:

```bash
pi
```

In pi, type:

```
/router status
```

You should see:

```
Router Status:
  Strategy: channelFirst
  Auto-discovery: enabled
  Sticky mode: enabled
  Context transfer: summary
  
Models (1):
  router/claude-opus-4-8
    Channels: lan, n1-claude, run-claude
    Fallback: claude-sonnet-4-6
```

## Step 5: Use Router Models

Select a router model in pi:

```
Model: router/claude-opus-4-8
```

Now all your requests will be routed through pi-router with automatic failover!

---

## Troubleshooting

### Extension not loading

Check pi's extension logs:

```bash
# In pi console
/extensions
```

Make sure `pi-router` appears in the list.

### No router models available

1. Check that `models.json` has multi-channel models
2. Run `/router list` to see what models are registered
3. Check config file: `cat ~/.pi/agent/pi-router.json`

### Channels failing immediately

1. Run `/router explain` to see failure history
2. Check circuit breaker states
3. Verify provider endpoints are accessible
4. Check cooldown periods

### Build errors

Make sure dependencies are installed:

```bash
cd pi-router
npm install
npm run build
```

---

## Configuration Tips

### For Maximum Reliability

```json
{
  "strategy": "channelFirst",
  "sticky": false,
  "sortBy": "config",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "n1-claude", "run-claude"],
    "fallbackModels": [
      { "id": "claude-sonnet-4-6", "channels": ["lan", "n1-claude"] }
    ]
  }]
}
```

### For Minimum Cost

```json
{
  "strategy": "channelFirst",
  "sticky": true,
  "sortBy": "cost",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "n1-claude", "run-claude"]
  }]
}
```

### For Best Performance

```json
{
  "strategy": "channelFirst",
  "sticky": true,
  "sortBy": "latency",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "n1-claude", "run-claude"]
  }]
}
```

---

## Development

### Watch mode

```bash
npm run watch
```

### Type checking only

```bash
npm run typecheck
```

### Testing locally

After making changes:

1. `npm run build`
2. Restart pi
3. Test with `/router status` and `/router explain`

---

## Uninstall

```bash
# Remove symlink
rm ~/.pi/agent/extensions/pi-router

# Remove config
rm ~/.pi/agent/pi-router.json

# Remove source (optional)
rm -rf ~/jiang/source/pi-router
```

Restart pi to complete uninstallation.
