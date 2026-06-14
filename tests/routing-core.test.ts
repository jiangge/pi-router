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
  determineChannelOrder,
  expandProviderModels,
  estimateContextTokens,
  filterConfigurableModels,
  modelsFromRegistry,
  buildModelMap,
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
  it('moves the last successful sticky channel to the front of configured order', () => {
    const state = __testGetInternalState();
    state.activeChannels.set('m1', 'Provider-B');

    expect(determineChannelOrder(
      'm1',
      { id: 'm1', channels: ['Provider-A', 'Provider-B', 'Provider-C'] } as any,
      { sticky: true } as any,
    )).toEqual(['Provider-B', 'Provider-A', 'Provider-C']);

    expect(determineChannelOrder(
      'm1',
      { id: 'm1', channels: ['Provider-A', 'Provider-B'], sticky: false } as any,
      { sticky: true } as any,
    )).toEqual(['Provider-A', 'Provider-B']);

    expect(determineChannelOrder(
      'm1',
      { id: 'm1', channels: ['Provider-A', 'Provider-B'] } as any,
      { sticky: false } as any,
    )).toEqual(['Provider-A', 'Provider-B']);
  });

  it('sorts channel order by latency and cost when configured', () => {
    recordLatency('m1', 'Provider-A', 200);
    recordLatency('m1', 'Provider-B', 50);

    expect(determineChannelOrder(
      'm1',
      { id: 'm1', channels: ['Provider-A', 'Provider-B'], sortBy: 'latency' } as any,
      {} as any,
    )).toEqual(['Provider-B', 'Provider-A']);

    expect(determineChannelOrder(
      'claude-opus-4-8',
      { id: 'claude-opus-4-8', channels: ['anthropic', 'local'], sortBy: 'cost' } as any,
      {} as any,
    )).toEqual(['local', 'anthropic']);
  });

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
  it('uses the first configured available channel for mirror defaults', () => {
    const mirrors = createMirrorModels(
      [
        { id: 'm1', channels: ['primary', 'secondary'] },
      ] as any,
      new Map([
        ['m1@primary', { id: 'm1', name: 'Primary', provider: 'primary', api: 'api-a', reasoning: true, input: ['text'], contextWindow: 100, maxTokens: 10, compat: { a: true }, thinkingLevelMap: { low: 'low' } }],
        ['m1@secondary', { id: 'm1', name: 'Secondary', provider: 'secondary', api: 'api-b', reasoning: false, input: ['text'], contextWindow: 999, maxTokens: 999 }],
      ]) as any,
    );

    const auto = mirrors.find((model: any) => model.id === 'auto');
    const mirror = mirrors.find((model: any) => model.id === 'm1');

    expect(auto).toMatchObject({
      api: 'pi-router',
      reasoning: true,
      contextWindow: 100,
      maxTokens: 10,
      compat: { a: true },
      thinkingLevelMap: { low: 'low' },
    });
    expect(mirror).toMatchObject({
      name: 'Primary (router)',
      api: 'pi-router',
      reasoning: true,
      contextWindow: 100,
      maxTokens: 10,
    });
  });

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

  it('lets explicit provider models override provider-level headers and compat', () => {
    const models = expandProviderModels('custom-provider', {
      api: 'custom-api',
      baseUrl: 'https://provider.example/v1',
      headers: {
        'x-shared': 'provider',
        'x-provider-only': 'provider-only',
      },
      compat: {
        stream: 'provider',
        providerOnly: true,
      },
      models: [
        {
          id: 'm1',
          name: 'Model One',
          headers: {
            'x-shared': 'model',
            'x-model-only': 'model-only',
          },
          compat: {
            stream: 'model',
            modelOnly: true,
          },
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'm1',
      provider: 'custom-provider',
      api: 'custom-api',
      baseUrl: 'https://provider.example/v1',
      headers: {
        'x-shared': 'model',
        'x-provider-only': 'provider-only',
        'x-model-only': 'model-only',
      },
      compat: {
        stream: 'model',
        providerOnly: true,
        modelOnly: true,
      },
    });
  });

  it('expands modelOverrides-based providers such as openai-codex', () => {
    const models = expandProviderModels('openai-codex', {
      modelOverrides: {
        'gpt-5.5': {
          name: 'GPT-5.5 (high)',
        },
      },
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      name: 'GPT-5.5 (high)',
    });
    expect(models[0].baseUrl).toBeTruthy();
  });

  it('prefers modelRegistry.getAvailable so unauthed oauth providers are excluded', () => {
    const models = modelsFromRegistry({
      getAvailable: () => [
        { id: 'gpt-5.5', name: 'Codex GPT', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text'], contextWindow: 1, maxTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
      getAll: () => [
        { id: 'gpt-5.5', name: 'OpenAI GPT', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', reasoning: true, input: ['text'], contextWindow: 1, maxTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    } as any);

    expect(models?.map(model => model.provider)).toEqual(['openai-codex']);
  });

  it('filters config candidates to configured providers and excludes router pseudo models', () => {
    const models = filterConfigurableModels([
      { id: 'gpt-5.5', name: 'Codex GPT', provider: 'openai-codex', api: 'openai-codex-responses' },
      { id: 'gpt-5.5', name: 'OpenAI GPT', provider: 'openai', api: 'openai-responses' },
      { id: 'gpt-5.5', name: 'Router GPT', provider: 'router', api: 'pi-router' },
      { id: 'claude-opus-4-7', name: 'Anthropic', provider: 'anthropic', api: 'anthropic-messages' },
    ] as any, new Set(['openai-codex', 'anthropic']));

    expect(models.map(model => `${model.id}@${model.provider}`)).toEqual([
      'gpt-5.5@openai-codex',
      'claude-opus-4-7@anthropic',
    ]);
  });

  it('buildModelMap excludes router pseudo models to avoid recursive routing', () => {
    const map = buildModelMap([
      { id: 'gpt-5.5', name: 'Codex GPT', provider: 'openai-codex', api: 'openai-codex-responses' },
      { id: 'gpt-5.5', name: 'Router GPT', provider: 'router', api: 'pi-router' },
    ] as any);

    expect(Array.from(map.keys())).toEqual(['gpt-5.5@openai-codex']);
    expect(map.has('gpt-5.5@router')).toBe(false);
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

  it('caps inherited maxTokens and preserves explicit router request overrides', () => {
    expect(applyRouterRequestOptions({ maxTokens: 999999 }, {} as any)?.maxTokens).toBe(32768);

    const configured = applyRouterRequestOptions(
      { maxTokens: 999999, timeoutMs: 10 },
      { request: { maxTokens: 456, timeoutMs: 0, maxRetryDelayMs: 789 } } as any,
    );

    expect(configured).toMatchObject({
      maxRetries: 0,
      maxTokens: 456,
      maxRetryDelayMs: 789,
    });
    expect(configured?.timeoutMs).toBeUndefined();
  });

  it('uses a short cooldown for fast connection failures', () => {
    recordFailure(
      'm1',
      'Provider-A',
      'ECONNREFUSED connection error',
      { failover: { cooldownMs: 60000 } } as any,
      { id: 'm1', channels: ['Provider-A'], failover: { cooldownMs: 60000 } } as any,
    );

    const cooldown = __testGetInternalState().cooldowns.get('m1@Provider-A') ?? 0;
    const remainingMs = cooldown - Date.now();
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(5000);
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

  it('summarizes exhausted channels with user-facing diagnostics', async () => {
    registerApiProvider({
      api: 'pi-router-exhausted-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
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
            errorMessage: model.provider === 'auth' ? '401 invalid token' : '429 rate limit exceeded',
            timestamp: Date.now(),
          } as any;
          stream.push({ type: 'error', reason: 'error', error: message } as any);
          stream.end();
        });
        return stream;
      },
    } as any, 'pi-router-exhausted-test');

    const stream = createFailoverStream(
      'm1',
      ['auth', 'quota'],
      { messages: [] } as any,
      undefined,
      {} as any,
      { id: 'm1', channels: ['auth', 'quota'] } as any,
      new Map([
        ['m1@auth', { id: 'm1', name: 'm1', provider: 'auth', api: 'pi-router-exhausted-test-api' }],
        ['m1@quota', { id: 'm1', name: 'm1', provider: 'quota', api: 'pi-router-exhausted-test-api' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errorMessage = events.find(e => e.type === 'error')?.error?.errorMessage;
    expect(errorMessage).toContain('All channels failed for m1');
    expect(errorMessage).toContain('auth: 认证失败（401/token 无效）');
    expect(errorMessage).toContain('quota: 触发限流（429）');
    expect(errorMessage).toContain('Configure fallback models');
  });

  it('does not fail over after a provider has committed response content', async () => {
    registerApiProvider({
      api: 'pi-router-committed-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: model.provider === 'good' ? 'good' : 'partial' }],
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
            stopReason: model.provider === 'good' ? 'stop' : 'error',
            timestamp: Date.now(),
          } as any;

          if (model.provider === 'bad') {
            stream.push({ type: 'start', partial: message } as any);
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'partial', partial: message } as any);
            stream.push({ type: 'error', reason: 'error', error: { ...message, errorMessage: '500 after partial output' } } as any);
            stream.end();
            return;
          }

          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'good', partial: message } as any);
          stream.push({ type: 'done', reason: 'stop', message } as any);
          stream.end();
        });
        return stream;
      },
    } as any, 'pi-router-committed-test');

    const stream = createFailoverStream(
      'm1',
      ['bad', 'good'],
      { messages: [] } as any,
      undefined,
      {} as any,
      { id: 'm1', channels: ['bad', 'good'] } as any,
      new Map([
        ['m1@bad', { id: 'm1', name: 'm1', provider: 'bad', api: 'pi-router-committed-test-api' }],
        ['m1@good', { id: 'm1', name: 'm1', provider: 'good', api: 'pi-router-committed-test-api' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'text_delta' && e.delta === 'partial')).toBe(true);
    expect(events.some(e => e.type === 'text_delta' && e.delta === 'good')).toBe(false);
    expect(events.at(-1)?.type).toBe('error');
    expect(events.at(-1)?.error?.errorMessage).toBe('上游服务错误（500）');
  });

  it('skips channels in cooldown and retries them after cooldown expires', async () => {
    const attemptedProviders: string[] = [];

    registerApiProvider({
      api: 'pi-router-cooldown-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model) => {
        attemptedProviders.push(model.provider);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: model.provider }],
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
          stream.push({ type: 'text_delta', contentIndex: 0, delta: model.provider, partial: message } as any);
          stream.push({ type: 'done', reason: 'stop', message } as any);
          stream.end();
        });
        return stream;
      },
    } as any, 'pi-router-cooldown-test');

    const modelMap = new Map([
      ['m1@cold', { id: 'm1', name: 'm1', provider: 'cold', api: 'pi-router-cooldown-test-api' }],
      ['m1@warm', { id: 'm1', name: 'm1', provider: 'warm', api: 'pi-router-cooldown-test-api' }],
    ]) as any;

    __testGetInternalState().cooldowns.set('m1@cold', Date.now() + 60_000);
    const skippedStream = createFailoverStream(
      'm1',
      ['cold', 'warm'],
      { messages: [] } as any,
      undefined,
      {} as any,
      { id: 'm1', channels: ['cold', 'warm'] } as any,
      modelMap,
    );
    for await (const _event of skippedStream) {
      // drain stream
    }
    expect(attemptedProviders).toEqual(['warm']);

    attemptedProviders.length = 0;
    __testGetInternalState().cooldowns.set('m1@cold', Date.now() - 1);
    const expiredStream = createFailoverStream(
      'm1',
      ['cold', 'warm'],
      { messages: [] } as any,
      undefined,
      {} as any,
      { id: 'm1', channels: ['cold', 'warm'] } as any,
      modelMap,
    );
    for await (const _event of expiredStream) {
      // drain stream
    }
    expect(attemptedProviders).toEqual(['cold']);
  });

  it('summarizes context before switching to a fallback model when needed', async () => {
    const contextsByProvider = new Map<string, any>();

    registerApiProvider({
      api: 'pi-router-summary-fallback-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model, context) => {
        contextsByProvider.set(model.provider, context);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: model.provider === 'sum' ? 'summarized context' : 'fallback ok' }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: model.provider === 'primary' ? 'error' : 'stop',
            timestamp: Date.now(),
          } as any;

          if (model.provider === 'primary') {
            stream.push({ type: 'error', reason: 'error', error: { ...message, errorMessage: 'primary failed' } } as any);
            stream.end();
            return;
          }

          if (model.provider === 'sum') {
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summarized context', partial: message } as any);
            stream.push({ type: 'done', reason: 'stop', message } as any);
            stream.end();
            return;
          }

          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'fallback ok', partial: message } as any);
          stream.push({ type: 'done', reason: 'stop', message } as any);
          stream.end();
        });
        return stream;
      },
    } as any, 'pi-router-summary-fallback-test');

    const stream = createFailoverStream(
      'm1',
      ['primary'],
      { messages: [{ role: 'user', content: 'long request '.repeat(200) }] } as any,
      undefined,
      { contextTransfer: 'summary', summaryModel: 'sum@sum', summaryMaxTokens: 50 } as any,
      {
        id: 'm1',
        channels: ['primary'],
        fallbackModels: [{ id: 'fb', channels: ['fb'] }],
      } as any,
      new Map([
        ['m1@primary', { id: 'm1', name: 'm1', provider: 'primary', api: 'pi-router-summary-fallback-test-api', contextWindow: 100000 }],
        ['fb@fb', { id: 'fb', name: 'fb', provider: 'fb', api: 'pi-router-summary-fallback-test-api', contextWindow: 1 }],
        ['sum@sum', { id: 'sum', name: 'sum', provider: 'sum', api: 'pi-router-summary-fallback-test-api', contextWindow: 100000 }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'text_delta' && e.delta === 'fallback ok')).toBe(true);
    expect(contextsByProvider.get('sum')?.messages?.[0]?.content).toContain('Conversation to summarize');
    expect(contextsByProvider.get('sum')?.messages?.[0]?.content).toContain('long request');
    expect(contextsByProvider.get('fb')?.messages).toEqual([{ role: 'user', content: 'summarized context' }]);
  });

  it('does not leak uncommitted fallback events before trying the next fallback', async () => {
    registerApiProvider({
      api: 'pi-router-fallback-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: model.provider === 'fb2' ? 'ok' : '' }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: model.provider === 'fb2' ? 1 : 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: model.provider === 'fb2' ? 1 : 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: model.provider === 'fb2' ? 'stop' : 'error',
            timestamp: Date.now(),
          } as any;

          if (model.provider === 'primary') {
            stream.push({
              type: 'error',
              reason: 'error',
              error: { ...message, errorMessage: 'primary failed' },
            } as any);
            return;
          }

          if (model.provider === 'fb1') {
            stream.push({ type: 'start', partial: message } as any);
            stream.push({ type: 'text_start', contentIndex: 0, partial: message } as any);
            stream.push({
              type: 'error',
              reason: 'error',
              error: { ...message, errorMessage: 'fallback failed before content' },
            } as any);
            return;
          }

          stream.push({ type: 'start', partial: message } as any);
          stream.push({ type: 'text_start', contentIndex: 0, partial: message } as any);
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message } as any);
          stream.push({ type: 'text_end', contentIndex: 0, content: 'ok', partial: message } as any);
          stream.push({ type: 'done', reason: 'stop', message } as any);
        });
        return stream;
      },
    } as any, 'pi-router-fallback-test');

    const stream = createFailoverStream(
      'm1',
      ['primary'],
      { messages: [] } as any,
      undefined,
      { contextTransfer: 'full' } as any,
      {
        id: 'm1',
        channels: ['primary'],
        fallbackModels: [
          { id: 'fb', channels: ['fb1'] },
          { id: 'fb', channels: ['fb2'] },
        ],
      } as any,
      new Map([
        ['m1@primary', { id: 'm1', name: 'm1', provider: 'primary', api: 'pi-router-fallback-test-api' }],
        ['fb@fb1', { id: 'fb', name: 'fb', provider: 'fb1', api: 'pi-router-fallback-test-api' }],
        ['fb@fb2', { id: 'fb', name: 'fb', provider: 'fb2', api: 'pi-router-fallback-test-api' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some(e => e.partial?.provider === 'fb1')).toBe(false);
    expect(events.some(e => e.type === 'text_delta' && e.delta === 'ok' && e.partial?.provider === 'fb2')).toBe(true);
  });
});
