# Pi-Router Testing Guide

This guide helps you test pi-router functionality in a real pi environment.

## Installation

### Method 1: Local Development (Recommended for testing)

```bash
cd /path/to/pi-router
npm run build
ln -sf $(pwd) ~/.pi/agent/extensions/pi-router
```

Then restart pi or use `/reload`.

### Method 2: Temporary Test

```bash
pi -e /path/to/pi-router/dist/index.js
```

### Method 3: Install as Package

```bash
pi install /path/to/pi-router
```

## Configuration

Create `~/.pi/agent/router.config.json`:

### Minimal Configuration

```json
{
  "strategy": "channelFirst",
  "auto": true,
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

## Test Scenarios

### Scenario 1: Basic Routing

**Setup:**
- Configure a model with 2+ channels
- Ensure first channel is available

**Test:**
1. Start pi
2. Select the router model: `/model`
3. Send a prompt
4. Check decision: `/router decisions`

**Expected:**
- Routes to first channel
- Decision logged with channel name

### Scenario 2: L1 Channel Failover

**Setup:**
- Configure model with channels: `["unavailable", "working"]`
- Ensure first channel fails (wrong endpoint, no API key, etc.)

**Test:**
1. Send a prompt
2. Observe failover message in TUI
3. Check decisions: `/router decisions`

**Expected:**
- Tries first channel, fails
- Automatically tries second channel
- Response from second channel
- Decision shows attempted channels

### Scenario 3: Circuit Breaker

**Setup:**
- Configure a model with a failing channel

**Test:**
1. Send 3-5 prompts quickly
2. Check circuit state: `/router explain`
3. Wait for cooldown (default 60s)
4. Send another prompt

**Expected:**
- Circuit opens after failures
- Failed channel skipped while open
- Circuit closes after cooldown
- Channel retried after recovery

### Scenario 4: L2 Model Fallback

**Setup:**
```json
{
  "models": [{
    "id": "primary-model",
    "channels": ["unavailable"],
    "fallbackModels": [
      {
        "id": "fallback-model",
        "channels": ["working"]
      }
    ]
  }]
}
```

**Test:**
1. Send a prompt
2. Watch L1 failure → L2 fallback
3. Check decisions

**Expected:**
- All L1 channels fail
- Fallback to L2 model
- Decision shows fallback used

### Scenario 5: Context Transfer

**Setup:**
```json
{
  "contextTransfer": "summary",
  "summaryModel": "claude-haiku-4-5@anthropic",
  "models": [{
    "id": "model-a",
    "channels": ["provider-a"],
    "fallbackModels": [{
      "id": "model-b",
      "channels": ["provider-b"]
    }]
  }]
}
```

**Test:**
1. Have a conversation (3+ turns)
2. Trigger fallback (disable provider-a)
3. Send another message
4. Check for summary in session

**Expected:**
- Context summarized before model switch
- Summary injected into conversation
- Fallback model sees summary

### Scenario 6: Health Probes

**Setup:**
```json
{
  "healthProbe": {
    "enabled": true,
    "intervalMs": 60000,
    "timeoutMs": 10000
  },
  "models": [{
    "id": "model",
    "channels": ["ch1", "ch2"]
  }]
}
```

**Test:**
1. Start pi and wait 60 seconds
2. Check probes: `/router probes`
3. Disable a channel temporarily
4. Wait another 60 seconds
5. Check probes again

**Expected:**
- Background probes every 60s
- Success/failure status per channel
- Latency measurements
- Failed probes show errors

### Scenario 7: Cost-Based Sorting

**Setup:**
```json
{
  "sortBy": "cost",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "anthropic", "openrouter"]
  }]
}
```

**Test:**
1. Check pricing: `/router pricing`
2. Send a prompt
3. Check decisions: `/router decisions`

**Expected:**
- Pricing shows: lan=FREE, anthropic<openrouter
- Routes to lan first (free)
- If lan fails, tries anthropic (cheaper)
- If both fail, tries openrouter

### Scenario 8: Auto-Sync

**Setup:**
```json
{
  "auto": true,
  "autoSync": true
}
```

**Test:**
1. Start pi with empty models array
2. Check auto-discovery in logs
3. Add/remove providers in pi's models.json
4. Restart pi
5. Check for sync notification

**Expected:**
- Auto-discovers multi-channel models on first run
- Detects models.json changes on restart
- Prompts to run `/router sync`

### Scenario 9: Latency Tracking

**Setup:**
```json
{
  "sortBy": "latency",
  "models": [{
    "id": "model",
    "channels": ["slow", "fast"]
  }]
}
```

**Test:**
1. Send several prompts
2. Check latencies: `/router explain`
3. Verify channel ordering adapts

**Expected:**
- Latency tracked per channel
- Channels sorted by avg latency
- Faster channels preferred

## Command Reference

```bash
/router status       # Show current config
/router list         # List available models
/router explain      # Show failures, latency, health, circuits
/router decisions    # Show recent routing decisions
/router probes       # Show background health probe results
/router pricing      # Show per-channel pricing breakdown
/router sync         # Check models.json changes
/router sync accept  # Apply detected changes
/router diff         # Preview config differences
```

## Debugging Tips

### Enable Debug Logs

The extension logs to console with `[pi-router]` prefix. Watch for:
- `Extension loaded` on startup
- `Routing decision` on each prompt
- `L1 failover` on channel failures
- `L2 fallback` on model fallbacks

### Check Configuration

```bash
/router status
```

Shows:
- Active strategy
- Number of configured models
- Auto-sync status

### Inspect Decisions

```bash
/router decisions
```

Shows last 20 routing decisions with:
- Model and channel used
- Attempted channels
- Latency
- Reason for selection

### Monitor Health

```bash
/router explain
```

Shows:
- Circuit breaker states
- Health status per channel
- Recent failures
- Average latencies

### View Pricing

```bash
/router pricing
```

Shows:
- Per-channel pricing
- Multipliers
- Example costs

## Troubleshooting

### Extension Not Loading

1. Check symlink: `ls -la ~/.pi/agent/extensions/`
2. Rebuild: `npm run build`
3. Check logs for errors
4. Try `/reload`

### Routes to Wrong Channel

1. Check `/router status` for strategy
2. Check `/router pricing` for cost-based sorting
3. Check `/router explain` for circuit breaker states
4. Review configuration file

### No Failover

1. Ensure multiple channels configured
2. Check `failover.on` matches error codes
3. Check logs for failure reasons
4. Verify channels are actually different providers

### Context Not Transferred

1. Ensure `contextTransfer: "summary"` configured
2. Check `summaryModel` is valid
3. Verify fallback actually triggered
4. Look for summary in session history

### Health Probes Not Running

1. Check `healthProbe.enabled: true`
2. Wait for intervalMs duration
3. Check `/router probes`
4. Look for probe logs in console

## Performance Benchmarks

Run these to measure overhead:

### Baseline (Direct Provider)

```bash
time echo "2+2?" | pi -p --provider anthropic --model claude-opus-4-8
```

### With Router

```bash
time echo "2+2?" | pi -p
# (after selecting router/claude-opus-4-8)
```

**Expected overhead:** <50ms for routing decision

### Failover Latency

Measure time from first failure to second attempt:
- Expected: <100ms for L1 failover
- Expected: <200ms for L2 fallback (with summary)

## Success Criteria

A successful test should demonstrate:

- ✅ Routes to correct channel based on strategy
- ✅ Fails over to next channel on error
- ✅ Circuit breaker opens after repeated failures
- ✅ Falls back to alternate model when all channels fail
- ✅ Transfers context between models
- ✅ Background health probes detect availability
- ✅ Cost-based sorting prefers cheaper channels
- ✅ Commands provide useful observability

## Reporting Issues

When reporting bugs, include:

1. Configuration file (sanitized)
2. Output of `/router status`
3. Output of `/router decisions`
4. Console logs with `[pi-router]` entries
5. Steps to reproduce
6. Expected vs actual behavior

## Next Steps

After testing:

1. Report any issues on GitHub
2. Share your configuration patterns
3. Suggest new features
4. Write blog posts about your setup
5. Contribute improvements

Happy routing! 🚀
