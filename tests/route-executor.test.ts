import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { executeRouteAttempt } from '../core/route-executor.js';
import { relayProviderStream } from '../core/stream-relay.js';

function createSuccessfulStream() {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      api: 'test-api',
      provider: 'provider-a',
      model: 'm1',
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    } as any;
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message } as any);
    stream.push({ type: 'done', reason: 'stop', message } as any);
    stream.end();
  });
  return stream;
}

describe('route executor', () => {
  it('skips a route before dispatch when cooldown is active', async () => {
    const forward = vi.fn(() => createSuccessfulStream());
    const output = createAssistantMessageEventStream();

    const result = await executeRouteAttempt(
      {
        stateModelId: 'm1',
        route: { routeKey: 'provider-a', routeLabel: 'provider-a', model: { id: 'm1' } },
        modelConfig: { id: 'm1' },
        context: { messages: [] } as any,
        options: undefined,
        config: {},
        outputStream: output,
        virtualModelId: 'm1',
      },
      {
        getCooldownEnd: () => Date.now() + 60_000,
        canAttempt: () => true,
        forward,
        relay: () => Promise.resolve({ ok: true }),
        recordLatency: vi.fn(),
        recordFailure: vi.fn(),
        updateHealth: vi.fn(),
        recordCircuit: vi.fn(),
        releaseCircuit: vi.fn(),
      },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'cooldown' });
    expect(forward).not.toHaveBeenCalled();
  });

  it('records first-token latency at commit and success health only after terminal completion', async () => {
    const output = createAssistantMessageEventStream();
    const recordLatency = vi.fn();
    const updateHealth = vi.fn();
    const recordCircuit = vi.fn();
    const onCommit = vi.fn();
    const onSuccess = vi.fn();

    const result = await executeRouteAttempt(
      {
        stateModelId: 'm1',
        route: { routeKey: 'provider-a#upstream-v2', routeLabel: 'provider-a#upstream-v2', model: { id: 'upstream-v2' } },
        modelConfig: { id: 'm1' },
        context: { messages: [] } as any,
        options: undefined,
        config: {},
        outputStream: output,
        virtualModelId: 'm1',
        onCommit,
        onSuccess,
      },
      {
        getCooldownEnd: () => undefined,
        canAttempt: () => true,
        forward: () => createSuccessfulStream(),
        relay: (stream, outputStream, options, _config, commit) => relayProviderStream(stream, outputStream, options, 1_000, commit),
        recordLatency,
        recordFailure: vi.fn(),
        updateHealth,
        recordCircuit,
        releaseCircuit: vi.fn(),
      },
    );

    expect(result.status).toBe('succeeded');
    expect(recordLatency).toHaveBeenCalledWith('m1', 'provider-a#upstream-v2', expect.any(Number));
    expect(updateHealth).toHaveBeenCalledWith('m1', 'provider-a#upstream-v2', true);
    expect(recordCircuit).toHaveBeenCalledWith('m1', 'provider-a#upstream-v2', true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('marks a committed stream failure as a route failure without retrying another route', async () => {
    const output = createAssistantMessageEventStream();
    const recordFailure = vi.fn();
    const updateHealth = vi.fn();
    const recordCircuit = vi.fn();
    const releaseCircuit = vi.fn();
    const onSuccess = vi.fn();
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        api: 'test-api',
        provider: 'provider-a',
        model: 'm1',
        usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error',
        timestamp: Date.now(),
      } as any;
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'partial', partial: message } as any);
      stream.push({ type: 'error', reason: 'error', error: { ...message, errorMessage: '500 after partial output' } } as any);
      stream.end();
    });

    const result = await executeRouteAttempt(
      {
        stateModelId: 'm1',
        route: { routeKey: 'provider-a', routeLabel: 'provider-a', model: { id: 'm1' } },
        modelConfig: { id: 'm1' },
        context: { messages: [] } as any,
        options: undefined,
        config: {},
        outputStream: output,
        virtualModelId: 'm1',
        onSuccess,
      },
      {
        getCooldownEnd: () => undefined,
        canAttempt: () => true,
        forward: () => stream,
        relay: (providerStream, outputStream, options, _config, commit) => relayProviderStream(providerStream, outputStream, options, 1_000, commit),
        recordLatency: vi.fn(),
        recordFailure,
        updateHealth,
        recordCircuit,
        releaseCircuit,
      },
    );

    expect(result).toEqual(expect.objectContaining({ status: 'failed', committed: true, aborted: false }));
    expect(recordFailure).toHaveBeenCalledWith('m1', 'provider-a', '500 after partial output', {}, { id: 'm1' });
    expect(updateHealth).toHaveBeenCalledWith('m1', 'provider-a', false);
    expect(recordCircuit).toHaveBeenCalledWith('m1', 'provider-a', false);
    expect(releaseCircuit).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
