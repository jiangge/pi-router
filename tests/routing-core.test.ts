import { afterEach, describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream, registerApiProvider } from '@earendil-works/pi-ai';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  __testGetInternalState,
  __testResetInternalState,
  canAttemptChannel,
  createFailoverStream,
  createMirrorModels,
  detectModelChanges,
  estimateContextTokens,
  estimateRequestCost,
  applyRouterRequestOptions,
  formatFooterStatus,
  formatRightAlignedStatusLine,
  generateSimpleTextSummary,
  getStreamEventFailure,
  isAbortError,
  shouldSummarizeForTarget,
  getAverageLatency,
  getChannelPricing,
  groupModelsByChannels,
  recordCircuitOutcome,
  recordFailure,
  recordLatency,
  resolveSummaryModel,
  sanitizeContextForSwitch,
  sortChannelsByCost,
  sortChannelsByLatency,
  updateFooterStatus,
  updateHealthStatus,
} from '../index.js';

afterEach(() => {
  __testResetInternalState();
});

describe('routing core helpers', () => {
  it('groups models by provider channels', () => {
    const groups = groupModelsByChannels([
      { id: 'm1', provider: 'Provider-A' } as any,
      { id: 'm1', provider: 'Provider-B' } as any,
      { id: 'm2', provider: 'Provider-C' } as any,
    ]);

    expect(groups.get('m1')).toEqual(['Provider-A', 'Provider-B']);
    expect(groups.get('m2')).toEqual(['Provider-C']);
  });

  it('detects added removed and modified model-channel mappings', () => {
    const config = {
      models: [
        { id: 'm1', channels: ['Provider-A'] },
        { id: 'm3', channels: ['Provider-Z'] },
      ],
    } as any;

    const diff = detectModelChanges(config, [
      { id: 'm1', provider: 'Provider-A' } as any,
      { id: 'm1', provider: 'Provider-B' } as any,
      { id: 'm2', provider: 'Provider-C' } as any,
    ]);

    expect(diff.added).toEqual([{ id: 'm2', channels: ['Provider-C'] }]);
    expect(diff.removed).toEqual([{ id: 'm3', channels: ['Provider-Z'] }]);
    expect(diff.modified).toEqual([
      {
        id: 'm1',
        channelsAdded: ['Provider-B'],
        channelsRemoved: [],
        propsChanged: [],
      },
    ]);
  });

  it('computes pricing and cost estimates', () => {
    const pricing = getChannelPricing('claude-opus-4-8', 'local');
    expect(pricing).not.toBeNull();
    expect(pricing?.input).toBe(0);
    expect(pricing?.output).toBe(0);

    const unknown = getChannelPricing('unknown-model', 'Provider-A');
    expect(unknown).toBeNull();

    const cost = estimateRequestCost('claude-opus-4-8', 'anthropic', 1_000_000, 500_000);
    expect(cost).toBeGreaterThan(0);
  });

  it('estimates context tokens from system prompt and messages', () => {
    const tokens = estimateContextTokens({
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'response text' },
      ],
    });

    expect(tokens).toBeGreaterThan(0);
  });

  it('decides whether summary is needed for target model window', () => {
    const smallContext = {
      messages: [{ role: 'user', content: 'short message' }],
    };
    const largeContext = {
      messages: [{ role: 'user', content: 'x'.repeat(1000) }],
    };

    expect(shouldSummarizeForTarget(smallContext, { contextWindow: 1000 } as any)).toBe(false);
    expect(shouldSummarizeForTarget(largeContext, { contextWindow: 100 } as any)).toBe(true);
    expect(shouldSummarizeForTarget(smallContext, {} as any)).toBe(true);
  });

  it('builds simple text summary with truncation', () => {
    const longText = 'x'.repeat(600);
    const summary = generateSimpleTextSummary(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: longText },
      ],
      { id: 'm-from', provider: 'Provider-A' } as any,
      { id: 'm-to', provider: 'Provider-B' } as any,
    );

    expect(summary).toContain('Switching from: m-from@Provider-A');
    expect(summary).toContain('Switching to: m-to@Provider-B');
    expect(summary).toContain('Latest user request:');
    expect(summary).toContain('...');
  });

  it('sanitizes context for none summary and full strategies', () => {
    const baseContext = {
      systemPrompt: 'system prompt',
      thinkingLevel: 'high',
      thinkingLevelMap: { high: 'high' },
      messages: [
        { role: 'developer', content: 'rules' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
        { role: 'user', content: 'again' },
      ],
    };

    const fromModel = { id: 'from', provider: 'Provider-A', contextWindow: 200, reasoning: true } as any;
    const toModel = {
      id: 'to',
      provider: 'Provider-B',
      contextWindow: 200,
      reasoning: false,
      compat: { supportsDeveloperRole: false },
    } as any;

    const noneResult = sanitizeContextForSwitch(baseContext, fromModel, toModel, 'none', 'summary text');
    expect(noneResult.messages).toEqual([]);
    expect(noneResult.systemPrompt).toContain('summary text');

    const summaryResult = sanitizeContextForSwitch(baseContext, fromModel, toModel, 'summary', 'summary text');
    expect(summaryResult.messages).toEqual([{ role: 'user', content: 'summary text' }]);

    const fullResult = sanitizeContextForSwitch(baseContext, fromModel, toModel, 'full');
    expect(fullResult.messages.length).toBe(4);
    expect(fullResult.messages[0].role).toBe('system');
    expect(fullResult.thinkingLevel).toBeUndefined();
    expect(fullResult.thinkingLevelMap).toBeUndefined();
  });

  it('resolves summary model by exact key, model id, or target fallback', () => {
    const target = { id: 'target', provider: 'Provider-T' } as any;
    const exact = { id: 'sum', provider: 'Provider-S' } as any;
    const other = { id: 'sum', provider: 'Provider-X' } as any;
    const modelMap = new Map<string, any>([
      ['sum@Provider-S', exact],
      ['sum@Provider-X', other],
      ['target@Provider-T', target],
    ]);

    expect(resolveSummaryModel('sum@Provider-S', modelMap, target)).toBe(exact);
    expect(resolveSummaryModel('sum', modelMap, target)).toBe(exact);
    expect(resolveSummaryModel(undefined, modelMap, target)).toBe(target);
    expect(resolveSummaryModel('missing', modelMap, target)).toBe(target);
  });
});

describe('routing state helpers', () => {
  it('records cooldowns on failure', () => {
    recordFailure(
      'm1',
      'Provider-A',
      'boom',
      { failover: { cooldownMs: 1234 } } as any,
      { id: 'm1', channels: ['Provider-A'] } as any,
    );

    const state = __testGetInternalState();
    expect(state.failures.get('m1')?.length).toBe(1);
    expect(state.cooldowns.has('m1@Provider-A')).toBe(true);
    expect((state.cooldowns.get('m1@Provider-A') ?? 0) - Date.now()).toBeGreaterThan(0);
  });

  it('tracks latency and sorts channels by measured latency', () => {
    recordLatency('m1', 'Provider-A', 300);
    recordLatency('m1', 'Provider-A', 100);
    recordLatency('m1', 'Provider-B', 50);

    expect(getAverageLatency('m1', 'Provider-A')).toBe(200);
    expect(getAverageLatency('m1', 'Provider-B')).toBe(50);
    expect(sortChannelsByLatency('m1', ['Provider-A', 'Provider-C', 'Provider-B'])).toEqual([
      'Provider-B',
      'Provider-A',
      'Provider-C',
    ]);
  });

  it('sorts channels by cost', () => {
    expect(sortChannelsByCost('claude-opus-4-8', ['anthropic', 'local', 'openrouter'])).toEqual([
      'local',
      'anthropic',
      'openrouter',
    ]);
  });

  it('marks health unhealthy after repeated failures and resets on success', () => {
    updateHealthStatus('m1', 'Provider-A', false);
    updateHealthStatus('m1', 'Provider-A', false);
    updateHealthStatus('m1', 'Provider-A', false);

    const state = __testGetInternalState();
    expect(state.health.get('m1@Provider-A')?.consecutiveFailures).toBe(3);

    updateHealthStatus('m1', 'Provider-A', true);
    expect(state.health.get('m1@Provider-A')?.consecutiveFailures).toBe(0);
    expect(state.health.get('m1@Provider-A')?.healthy).toBe(true);
  });

  it('opens and resets circuit breaker correctly', () => {
    for (let i = 0; i < 5; i++) {
      recordCircuitOutcome('m1', 'Provider-A', false);
    }

    const state = __testGetInternalState();
    expect(state.circuits.get('m1@Provider-A')?.state).toBe('open');
    expect(canAttemptChannel('m1', 'Provider-A')).toBe(false);

    const circuit = state.circuits.get('m1@Provider-A')!;
    circuit.nextRetryTime = Date.now() - 1;
    expect(canAttemptChannel('m1', 'Provider-A')).toBe(true);
    expect(circuit.state).toBe('half-open');

    recordCircuitOutcome('m1', 'Provider-A', true);
    expect(circuit.state).toBe('closed');
    expect(circuit.failureCount).toBe(0);
  });

  it('stores footer phase and renders attempted chain', () => {
    updateFooterStatus('claude-fable-5', 'lan', undefined, 'trying', ['lan']);
    updateFooterStatus('claude-fable-5', 'n1-claude', undefined, 'success', ['lan', 'n1-claude']);

    const state = __testGetInternalState();
    expect(state.lastStatusUpdate?.phase).toBe('success');
    expect(state.lastStatusUpdate?.attemptedChannels).toEqual(['lan', 'n1-claude']);

    const rendered = formatFooterStatus(
      { fg: (_name: string, text: string) => text },
      state.lastStatusUpdate as any,
    );
    expect(rendered).toContain('(router) claude-fable-5 → n1-claude');
    expect(rendered).not.toContain('[lan → n1-claude]');
  });

  it('right-aligns router status against other footer statuses', () => {
    const rendered = formatRightAlignedStatusLine(
      { fg: (_name: string, text: string) => text },
      80,
      'Claude cache 0/1 · 0M/0M tok',
      '(router) claude-fable-5 → failed pipi-cc [lan → n1-claude → pipi-cc]',
    );

    expect(rendered).toBeTruthy();
    expect(visibleWidth(rendered!)).toBeLessThanOrEqual(80);
    expect(rendered).toMatch(/ {2,}\(router\)/);
    expect(rendered).toContain('Claude');
  });
});

describe('provider registration helpers', () => {
  it('creates router mirror models with custom api dispatch', () => {
    const mirrors = createMirrorModels(
      [
        { id: 'm1', channels: ['bad', 'good'] },
      ] as any,
      new Map([
        ['m1@bad', { id: 'm1', name: 'Model One', provider: 'bad', api: 'anthropic-messages', reasoning: true, input: ['text'], contextWindow: 100, maxTokens: 10 }],
        ['m1@good', { id: 'm1', name: 'Model One', provider: 'good', api: 'anthropic-messages', reasoning: true, input: ['text'], contextWindow: 100, maxTokens: 10 }],
      ]) as any,
    );

    expect(mirrors.map((m: any) => m.id)).toEqual(['auto', 'm1']);
    expect(mirrors.every((m: any) => m.api === 'pi-router')).toBe(true);
  });
});

describe('request and event helpers', () => {
  it('defaults provider retries to zero so router failover owns retries', () => {
    expect(applyRouterRequestOptions({ maxRetries: 5 }, {} as any)?.maxRetries).toBe(0);
    expect(applyRouterRequestOptions(undefined, { request: { maxRetries: 2, timeoutMs: 123 } } as any)).toMatchObject({
      maxRetries: 2,
      timeoutMs: 123,
    });
  });

  it('extracts provider error events for failover', () => {
    const error = getStreamEventFailure({
      type: 'error',
      reason: 'error',
      error: {
        errorMessage: 'Connection error.',
      },
    } as any);

    expect(error).toBe('Connection error.');
    expect(getStreamEventFailure({ type: 'text_delta', delta: 'ok' } as any)).toBeUndefined();
  });

  it('recognizes abort errors so user cancellation does not pollute health', () => {
    expect(isAbortError('Request was aborted')).toBe(true);
    expect(isAbortError('AbortError: The operation was aborted')).toBe(true);
    expect(isAbortError('Connection error.')).toBe(false);
  });

  it('fails over when provider emits an error event instead of throwing', async () => {
    registerApiProvider({
      api: 'pi-router-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (model.provider === 'bad') {
            stream.push({
              type: 'error',
              reason: 'error',
              error: {
                role: 'assistant',
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: 'error',
                errorMessage: 'Connection error.',
                timestamp: Date.now(),
              },
            } as any);
            return;
          }

          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            api: model.api,
            provider: model.provider,
            model: model.id,
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

          stream.push({ type: 'start', partial: message } as any);
          stream.push({ type: 'text_start', contentIndex: 0, partial: message } as any);
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message } as any);
          stream.push({ type: 'text_end', contentIndex: 0, content: 'ok', partial: message } as any);
          stream.push({ type: 'done', reason: 'stop', message } as any);
        });
        return stream;
      },
    } as any, 'pi-router-test');

    const stream = createFailoverStream(
      'm1',
      ['bad', 'good'],
      { messages: [] } as any,
      undefined,
      {} as any,
      { id: 'm1', channels: ['bad', 'good'] } as any,
      new Map([
        ['m1@bad', { id: 'm1', name: 'm1', provider: 'bad', api: 'pi-router-test-api' }],
        ['m1@good', { id: 'm1', name: 'm1', provider: 'good', api: 'pi-router-test-api' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'text_delta' && e.delta === 'ok')).toBe(true);

    const state = __testGetInternalState();
    expect(state.failures.get('m1')?.[0].channel).toBe('bad');
    expect(state.lastStatusUpdate?.channel).toBe('good');
    expect(state.lastStatusUpdate?.attemptedChannels).toEqual(['bad', 'good']);
  });
});
