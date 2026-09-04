import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream, registerApiProvider } from '@earendil-works/pi-ai/compat';
import { visibleWidth } from '@earendil-works/pi-tui';
import routerExtension, {
  __testGetInternalState,
  __testResetInternalState,
  __testResetSessionProviderActiveFlag,
  __testRegisterRoutingAdapter,
  __testSetCurrentModelRegistry,
  __testSetPiConfigDir,
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
  applyUpstreamRequestAuth,
  formatUserFacingFailure,
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
  resetRoutingPointer,
  resolveSummaryModel,
  sanitizeContextForSwitch,
  sortChannelsByCost,
  sortChannelsByLatency,
  updateFooterStatus,
  updateHealthStatus,
} from '../index.js';

afterEach(() => {
  __testResetInternalState();
  delete (globalThis as any)[Symbol.for('pi.cache.hints.v1')];
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

  it('unions reasoning across mixed reasoning and non-reasoning routes', () => {
    const mirrors = createMirrorModels(
      [{ id: 'mixed', channels: ['plain', 'thinking'] }] as any,
      new Map([
        ['mixed@plain', { id: 'mixed', name: 'Plain', provider: 'plain', api: 'api-a', reasoning: false, input: ['text'], contextWindow: 100, maxTokens: 10 }],
        ['mixed@thinking', { id: 'mixed', name: 'Thinking', provider: 'thinking', api: 'api-b', reasoning: true, input: ['text'], contextWindow: 100, maxTokens: 10, thinkingLevelMap: { high: 'high' } }],
      ]) as any,
    );

    expect(mirrors.find((model: any) => model.id === 'mixed')).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { high: 'high' },
    });
  });

  it('unions thinkingLevelMap across the whole chain for auto', () => {
    const mirrors = createMirrorModels(
      [
        { id: 'm1', channels: ['primary', 'secondary'] },
        { id: 'm2', channels: ['tertiary'] },
      ] as any,
      new Map([
        ['m1@primary', { id: 'm1', name: 'Primary', provider: 'p1', api: 'api-a', reasoning: true, input: ['text'], contextWindow: 100, maxTokens: 10, thinkingLevelMap: { low: 'low', high: 'high', max: null } }],
        ['m1@secondary', { id: 'm1', name: 'Secondary', provider: 'p2', api: 'api-b', reasoning: true, input: ['text'], contextWindow: 100, maxTokens: 10, thinkingLevelMap: { off: null, high: 'high', max: 'max' } }],
        ['m2@tertiary', { id: 'm2', name: 'Tertiary', provider: 'p3', api: 'api-c', reasoning: true, input: ['text'], contextWindow: 100, maxTokens: 10, thinkingLevelMap: { xhigh: 'xhigh' } }],
      ]) as any,
    );

    const auto = mirrors.find((model: any) => model.id === 'auto');
    // "max" supported by a later channel must surface even though the first
    // channel explicitly marks it unsupported; same for another chain entry's xhigh.
    expect(auto?.thinkingLevelMap).toMatchObject({ low: 'low', high: 'high', max: 'max', xhigh: 'xhigh' });

    // Canonical mirror unions its own channels only.
    const m1 = mirrors.find((model: any) => model.id === 'm1');
    expect(m1?.thinkingLevelMap).toMatchObject({ high: 'high', max: 'max' });

    const m2 = mirrors.find((model: any) => model.id === 'm2');
    expect(m2?.thinkingLevelMap).toMatchObject({ xhigh: 'xhigh' });
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

  it('uses per-channel upstream model ids for canonical router mirror defaults', () => {
    const mirrors = createMirrorModels(
      [
        {
          id: 'deepseek-v4-flash',
          aliases: ['DeepSeek-V4-Flash', 'oc/deepseek-v4-flash-free'],
          channels: ['wx-api', 'abrdns-ds'],
          modelByChannel: {
            'wx-api': 'oc/deepseek-v4-flash-free',
            'abrdns-ds': 'DeepSeek-V4-Flash',
          },
        },
      ] as any,
      new Map([
        ['oc/deepseek-v4-flash-free@wx-api', { id: 'oc/deepseek-v4-flash-free', name: 'DeepSeek Flash Free', provider: 'wx-api', api: 'openai-completions', contextWindow: 123 }],
        ['DeepSeek-V4-Flash@abrdns-ds', { id: 'DeepSeek-V4-Flash', name: 'DeepSeek Flash', provider: 'abrdns-ds', api: 'openai-completions', contextWindow: 456 }],
      ]) as any,
    );

    const mirror = mirrors.find((m: any) => m.id === 'deepseek-v4-flash');
    expect(mirror).toMatchObject({
      id: 'deepseek-v4-flash',
      name: 'DeepSeek Flash Free (router)',
      contextWindow: 123,
      api: 'pi-router',
    });
  });

  it('folds configured aliases into sync diffs with upstream model overrides', () => {
    const diff = detectModelChanges(
      {
        models: [
          {
            id: 'deepseek-v4-flash',
            aliases: ['DeepSeek-V4-Flash', 'oc/deepseek-v4-flash-free'],
            channels: ['deepseek', 'abrdns-ds'],
            modelByChannel: { 'abrdns-ds': 'DeepSeek-V4-Flash' },
          },
        ],
      } as any,
      [
        { id: 'deepseek-v4-flash', provider: 'deepseek' } as any,
        { id: 'DeepSeek-V4-Flash', provider: 'abrdns-ds' } as any,
        { id: 'oc/deepseek-v4-flash-free', provider: 'wx-api' } as any,
      ],
    );

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([
      {
        id: 'deepseek-v4-flash',
        channelsAdded: ['wx-api'],
        channelsRemoved: [],
        propsChanged: ['modelByChannel'],
      },
    ]);
  });

  it('detects duplicate same-provider alias routes that require routes config', () => {
    const diff = detectModelChanges(
      {
        models: [
          {
            id: 'deepseek-v4-flash',
            aliases: ['oc/deepseek-v4-flash-free'],
            channels: ['wx-api'],
          },
        ],
      } as any,
      [
        { id: 'deepseek-v4-flash', provider: 'wx-api' } as any,
        { id: 'oc/deepseek-v4-flash-free', provider: 'wx-api' } as any,
      ],
    );

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([
      {
        id: 'deepseek-v4-flash',
        channelsAdded: [],
        channelsRemoved: [],
        propsChanged: ['routes'],
      },
    ]);
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

  it('does not send reasoning options to a non-reasoning selected route', async () => {
    let receivedReasoning: unknown = 'not-called';
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'upstream-key' }),
      getProvider: () => ({
        streamSimple: (_model: any, _context: any, options: any) => {
          receivedReasoning = options.reasoning;
          const stream = createAssistantMessageEventStream();
          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: 'plain route ok' }],
            api: 'plain-route-test-api',
            provider: 'plain',
            model: 'm1',
            usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          };
          queueMicrotask(() => {
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'plain route ok', partial: message } as any);
            stream.push({ type: 'done', reason: 'stop', message } as any);
            stream.end();
          });
          return stream;
        },
      }),
    });

    const stream = createFailoverStream(
      'm1',
      ['plain'],
      { messages: [] } as any,
      { reasoning: 'high' } as any,
      {} as any,
      { id: 'm1', channels: ['plain'] } as any,
      new Map([
        ['m1@plain', { id: 'm1', name: 'Plain', provider: 'plain', api: 'plain-route-test-api', reasoning: false }],
      ]) as any,
    );

    for await (const _event of stream) {
      // Drain the stream so the provider invocation completes.
    }

    expect(receivedReasoning).toBeUndefined();
  });

  it('uses the effective pi provider stream implementation when available', async () => {
    const calls: string[] = [];
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'upstream-key' }),
      getProvider: (provider: string) => provider === 'provider-a'
        ? {
            streamSimple: (model: any, _context: any, options: any) => {
              calls.push(`${model.provider}/${model.id}:${options.apiKey}`);
              const stream = createAssistantMessageEventStream();
              const message = {
                role: 'assistant',
                content: [{ type: 'text', text: 'provider stream ok' }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: 'stop',
                timestamp: Date.now(),
              };
              queueMicrotask(() => {
                stream.push({ type: 'text_delta', contentIndex: 0, delta: 'provider stream ok', partial: message } as any);
                stream.push({ type: 'done', reason: 'stop', message } as any);
                stream.end();
              });
              return stream;
            },
          }
        : undefined,
    });

    const stream = createFailoverStream(
      'm1',
      ['provider-a'],
      { messages: [] } as any,
      undefined,
      {} as any,
      { id: 'm1', channels: ['provider-a'] } as any,
      new Map([
        ['m1@provider-a', { id: 'm1', name: 'Model One', provider: 'provider-a', api: 'provider-stream-test-api' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) events.push(event);

    expect(calls).toEqual(['provider-a/m1:upstream-key']);
    expect(events.at(-1)?.message).toMatchObject({ provider: 'provider-a', model: 'm1' });
  });

  it('uses provider auth fallback and preserves auth-owned model endpoint', async () => {
    const calls: Array<{ provider: string; baseUrl: string; apiKey: string; env: Record<string, string> }> = [];
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: 'registry auth temporarily unavailable' }),
      getProviderAuth: async () => ({
        auth: {
          apiKey: 'oauth-access-token',
          baseUrl: 'https://oauth.example/v1',
        },
        env: { ACCOUNT_ID: 'account-1' },
      }),
      getProvider: (provider: string) => provider === 'provider-a'
        ? {
            streamSimple: (model: any, _context: any, options: any) => {
              calls.push({
                provider: model.provider,
                baseUrl: model.baseUrl,
                apiKey: options.apiKey,
                env: options.env,
              });
              const stream = createAssistantMessageEventStream();
              const message = {
                role: 'assistant',
                content: [{ type: 'text', text: 'provider auth fallback ok' }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: 'stop',
                timestamp: Date.now(),
              };
              queueMicrotask(() => {
                stream.push({ type: 'text_delta', contentIndex: 0, delta: 'provider auth fallback ok', partial: message } as any);
                stream.push({ type: 'done', reason: 'stop', message } as any);
                stream.end();
              });
              return stream;
            },
          }
        : undefined,
    });

    const stream = createFailoverStream(
      'm1',
      ['provider-a'],
      { messages: [] } as any,
      undefined,
      {} as any,
      { id: 'm1', channels: ['provider-a'] } as any,
      new Map([
        ['m1@provider-a', { id: 'm1', name: 'Model One', provider: 'provider-a', api: 'provider-auth-fallback-test-api', baseUrl: 'https://models.example/v1' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) events.push(event);

    expect(calls).toEqual([{
      provider: 'provider-a',
      baseUrl: 'https://oauth.example/v1',
      apiKey: 'oauth-access-token',
      env: { ACCOUNT_ID: 'account-1' },
    }]);
    expect(events.at(-1)?.message).toMatchObject({ provider: 'provider-a', model: 'm1' });
  });

  it('routes duplicate same-provider route variants independently', async () => {
    const attemptedModels: string[] = [];

    registerApiProvider({
      api: 'pi-router-duplicate-route-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model) => {
        attemptedModels.push(model.id);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (model.id === 'deepseek-v4-flash') {
            stream.push({
              type: 'error',
              reason: 'error',
              error: {
                role: 'assistant',
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: 'error',
                errorMessage: 'Connection error.',
                timestamp: Date.now(),
              },
            } as any);
            stream.end();
            return;
          }

          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: 'variant ok' }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          } as any;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'variant ok', partial: message } as any);
          stream.push({ type: 'done', reason: 'stop', message } as any);
          stream.end();
        });
        return stream;
      },
    } as any, 'pi-router-duplicate-route-test');

    const stream = createFailoverStream(
      'deepseek-v4-flash',
      ['wx-api', 'wx-api#oc/deepseek-v4-flash-free'],
      { messages: [] } as any,
      undefined,
      {} as any,
      {
        id: 'deepseek-v4-flash',
        aliases: ['oc/deepseek-v4-flash-free'],
        channels: ['wx-api'],
        routes: [
          { channel: 'wx-api' },
          { channel: 'wx-api', model: 'oc/deepseek-v4-flash-free' },
        ],
      } as any,
      new Map([
        ['deepseek-v4-flash@wx-api', { id: 'deepseek-v4-flash', name: 'DeepSeek Flash', provider: 'wx-api', api: 'pi-router-duplicate-route-test-api' }],
        ['oc/deepseek-v4-flash-free@wx-api', { id: 'oc/deepseek-v4-flash-free', name: 'DeepSeek Flash Free', provider: 'wx-api', api: 'pi-router-duplicate-route-test-api' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) events.push(event);

    expect(attemptedModels).toEqual(['deepseek-v4-flash', 'oc/deepseek-v4-flash-free']);
    expect(events.at(-1)?.message).toMatchObject({
      provider: 'wx-api',
      model: 'oc/deepseek-v4-flash-free',
    });
    expect(__testGetInternalState().failures.get('deepseek-v4-flash')?.[0].channel).toBe('wx-api');
  });

  it('routes canonical aliases to upstream ids, publishes route snapshots, and forwards cache hints', async () => {
    const calls: any[] = [];
    const hintInputs: any[] = [];

    (globalThis as any)[Symbol.for('pi.cache.hints.v1')] = {
      version: 1,
      getHints(input: any) {
        hintInputs.push(input);
        // First-turn router integrations may only have a virtual-model hint before
        // pi-router selects the real upstream provider/model. Exact upstream lookup
        // should miss, then virtual-only fallback should still deliver the hint.
        if (input.upstreamProvider) return undefined;
        return {
          systemPrompt: 'optimized system prompt',
          promptCacheKey: 'cache-session-key',
          cacheRetention: 'long',
        };
      },
    };

    __testRegisterRoutingAdapter();

    registerApiProvider({
      api: 'pi-router-alias-route-test-api',
      stream: (() => createAssistantMessageEventStream()) as any,
      streamSimple: (model, context, options) => {
        calls.push({ model, context, options });
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 2,
              cacheWrite: 0,
              totalTokens: 4,
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
      },
    } as any, 'pi-router-alias-route-test');

    const stream = createFailoverStream(
      'deepseek-v4-flash',
      ['wx-api'],
      { systemPrompt: 'original prompt', messages: [] } as any,
      undefined,
      {} as any,
      {
        id: 'deepseek-v4-flash',
        aliases: ['oc/deepseek-v4-flash-free'],
        channels: ['wx-api'],
        modelByChannel: { 'wx-api': 'oc/deepseek-v4-flash-free' },
      } as any,
      new Map([
        ['oc/deepseek-v4-flash-free@wx-api', { id: 'oc/deepseek-v4-flash-free', name: 'DeepSeek Flash Free', provider: 'wx-api', api: 'pi-router-alias-route-test-api' }],
      ]) as any,
    );

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(calls[0].model).toMatchObject({
      id: 'oc/deepseek-v4-flash-free',
      provider: 'wx-api',
      api: 'pi-router-alias-route-test-api',
    });
    expect(calls[0].context.systemPrompt).toBe('optimized system prompt');
    expect(calls[0].options).toMatchObject({
      sessionId: 'cache-session-key',
      cacheRetention: 'long',
    });
    expect(hintInputs[0]).toMatchObject({
      virtualProvider: 'router',
      virtualModelId: 'deepseek-v4-flash',
      upstreamProvider: 'wx-api',
      upstreamModelId: 'oc/deepseek-v4-flash-free',
      api: 'pi-router-alias-route-test-api',
    });
    expect(hintInputs[1]).toMatchObject({
      virtualProvider: 'router',
      virtualModelId: 'deepseek-v4-flash',
    });
    expect(hintInputs[1].upstreamProvider).toBeUndefined();
    expect(events.at(-1)?.message).toMatchObject({
      provider: 'wx-api',
      model: 'oc/deepseek-v4-flash-free',
    });

    const router = (globalThis as any)[Symbol.for('pi.routing.registry.v1')]?.getRouter('router');
    expect(router?.resolveActiveRoute('deepseek-v4-flash')).toMatchObject({
      virtualProvider: 'router',
      virtualModelId: 'deepseek-v4-flash',
      canonicalModelId: 'deepseek-v4-flash',
      provider: 'wx-api',
      modelId: 'oc/deepseek-v4-flash-free',
      status: 'success',
    });
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

describe('auth fallback (transient registry failures after reload)', () => {
  it('formats "No API key" errors as auth-unavailable, not a generic upstream error', () => {
    expect(formatUserFacingFailure('No API key for provider: zhipu')).toContain('认证');
  });

  it('uses the configured cooldown for a real missing API key failure', () => {
    recordFailure(
      'authm',
      'Provider-A',
      'No API key for provider: zhipu',
      { failover: { cooldownMs: 60000 } } as any,
      { id: 'authm', channels: ['Provider-A'] } as any,
    );
    const state = __testGetInternalState();
    const remaining = (state.cooldowns.get('authm@Provider-A') ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(59000);
    expect(remaining).toBeLessThanOrEqual(60000);
  });

  it('uses the configured cooldown for invalid tokens and unauthorized responses', () => {
    for (const error of ['401 invalid token', '401 invalid api key', '401 unauthorized']) {
      recordFailure(
        'authm',
        error,
        error,
        { failover: { cooldownMs: 60000 } } as any,
        { id: 'authm', channels: [error] } as any,
      );
      const remaining = (__testGetInternalState().cooldowns.get(`authm@${error}`) ?? 0) - Date.now();
      expect(remaining).toBeGreaterThan(59000);
      expect(remaining).toBeLessThanOrEqual(60000);
    }
  });

  it('uses a short cooldown only for explicit transient auth-resolution failures', () => {
    recordFailure(
      'authm',
      'Provider-A',
      'Registry auth temporarily unavailable',
      { failover: { cooldownMs: 60000 } } as any,
      { id: 'authm', channels: ['Provider-A'] } as any,
    );
    const remaining = (__testGetInternalState().cooldowns.get('authm@Provider-A') ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it('preserves an explicit real API key while merging registry request metadata', async () => {
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: 'registry-key',
        headers: { 'X-Registry': '1' },
        env: { ACCOUNT_ID: 'account-1' },
      }),
    });
    try {
      const options = await applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'zhipu', api: 'openai-completions' } as any,
        { apiKey: 'explicit-key' } as any,
      );
      expect(options).toMatchObject({
        apiKey: 'explicit-key',
        headers: { 'X-Registry': '1' },
        env: { ACCOUNT_ID: 'account-1' },
      });
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });

  it('uses explicit request credentials after both registry auth paths fail', async () => {
    let requestAuthCalls = 0;
    let providerAuthCalls = 0;
    const registry = {
      getApiKeyAndHeaders: async () => {
        requestAuthCalls++;
        return { ok: false as const, error: 'registry auth unavailable' };
      },
      getProviderAuth: async () => {
        providerAuthCalls++;
        return undefined;
      },
    };
    __testSetCurrentModelRegistry(registry);
    try {
      const withKey = await applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'zhipu', api: 'openai-completions' } as any,
        { apiKey: 'explicit-key' } as any,
      );
      expect((withKey as any).apiKey).toBe('explicit-key');

      const withHeader = await applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'zhipu', api: 'openai-completions' } as any,
        { headers: { Authorization: 'Bearer explicit-token' } } as any,
      );
      expect((withHeader as any).headers).toEqual({ Authorization: 'Bearer explicit-token' });
      expect(requestAuthCalls).toBe(4);
      expect(providerAuthCalls).toBe(2);
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });

  it('retries the model-aware registry auth path once after a transient failure', async () => {
    let requestAuthCalls = 0;
    let providerAuthCalls = 0;
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => {
        requestAuthCalls++;
        return requestAuthCalls === 1
          ? { ok: false as const, error: 'registry auth temporarily unavailable' }
          : {
              ok: true as const,
              apiKey: 'stored-or-oauth-access-token',
              headers: { Authorization: 'Bearer stored-or-oauth-access-token' },
              baseUrl: 'https://oauth-provider.example/v1',
              env: { ACCOUNT_ID: 'account-1' },
            };
      },
      getProviderAuth: async () => {
        providerAuthCalls++;
        return { auth: { apiKey: 'provider-wide-key' } };
      },
    });
    try {
      const options = await applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'zhipu', api: 'openai-completions' } as any,
        { apiKey: 'router', headers: { 'X-Request': '1' } } as any,
      );
      expect(requestAuthCalls).toBe(2);
      expect(providerAuthCalls).toBe(0);
      expect(options).toMatchObject({
        apiKey: 'stored-or-oauth-access-token',
        headers: {
          Authorization: 'Bearer stored-or-oauth-access-token',
          'X-Request': '1',
        },
        env: { ACCOUNT_ID: 'account-1' },
      });
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });

  it('fails accurately without a dummy key when provider auth is unavailable', async () => {
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: 'registry auth temporarily unavailable' }),
      getProviderAuth: async () => undefined,
    });
    try {
      await expect(applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'zhipu', api: 'openai-completions' } as any,
        { apiKey: 'router' } as any,
      )).rejects.toThrow('registry auth temporarily unavailable');
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });

  it('does not treat empty auth containers as resolved credentials', async () => {
    let providerAuthCalls = 0;
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: true as const, headers: {}, env: {} }),
      getProviderAuth: async () => {
        providerAuthCalls++;
        return { auth: { apiKey: 'fallback-key' } };
      },
    });
    try {
      const options = await applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'zhipu', api: 'openai-completions' } as any,
        { apiKey: 'router' } as any,
      );
      expect(providerAuthCalls).toBe(1);
      expect((options as any).apiKey).toBe('fallback-key');
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });

  it('accepts an authless or ambient provider reported by the model-aware facade', async () => {
    __testSetCurrentModelRegistry({
      // Ambient providers such as Amazon Bedrock can resolve through SDK state
      // without returning request fields from this compatibility facade.
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    });
    try {
      const options = await applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'amazon-bedrock', api: 'bedrock-converse-stream' } as any,
        { apiKey: 'router' } as any,
      );
      expect((options as any).apiKey).toBeUndefined();
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });

  it('accepts a successful ambient credential result from a legacy registry', async () => {
    let providerAuthCalls = 0;
    __testSetCurrentModelRegistry({
      getProviderAuth: async () => {
        providerAuthCalls++;
        return { auth: {}, source: 'ECS task role' };
      },
    });
    try {
      const options = await applyUpstreamRequestAuth(
        { id: 'm1', name: 'm1', provider: 'amazon-bedrock', api: 'bedrock-converse-stream' } as any,
        { apiKey: 'router' } as any,
      );
      expect(providerAuthCalls).toBe(1);
      expect((options as any).apiKey).toBeUndefined();
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });

  it('does not dispatch to a provider after required auth resolution fails', async () => {
    let providerCalls = 0;
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: 'No API key for provider: provider-a' }),
      getProviderAuth: async () => undefined,
      getProvider: () => ({
        streamSimple: () => {
          providerCalls++;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({
              type: 'error',
              reason: 'error',
              error: { errorMessage: 'unexpected provider dispatch' },
            } as any);
            stream.end();
          });
          return stream;
        },
      }),
    });
    try {
      const stream = createFailoverStream(
        'm1',
        ['provider-a'],
        { messages: [] } as any,
        undefined,
        {} as any,
        { id: 'm1', channels: ['provider-a'] } as any,
        new Map([
          ['m1@provider-a', { id: 'm1', name: 'Model One', provider: 'provider-a', api: 'openai-completions' }],
        ]) as any,
      );
      const events: any[] = [];
      for await (const event of stream) events.push(event);

      expect(providerCalls).toBe(0);
      expect(__testGetInternalState().failures.get('m1')?.[0]?.error).toContain('No API key for provider');
      expect(events.some(event => getStreamEventFailure(event)?.includes('认证不可用'))).toBe(true);
    } finally {
      __testSetCurrentModelRegistry(undefined);
    }
  });
});

describe('request-scoped auth resolution', () => {
  it('does not replay credentials from an earlier request', async () => {
    let unavailable = false;
    const registry = {
      getApiKeyAndHeaders: async () => unavailable
        ? { ok: false as const, error: 'credential removed' }
        : { ok: true as const, apiKey: 'old-key' },
      getProviderAuth: async () => undefined,
    };
    __testSetCurrentModelRegistry(registry);

    const first = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect((first as any).apiKey).toBe('old-key');

    unavailable = true;
    await expect(applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    )).rejects.toThrow('credential removed');
  });

  it('discards auth resolved by a registry that changed while lookup was pending', async () => {
    let finishLookup: ((value: any) => void) | undefined;
    const firstRegistry = {
      getApiKeyAndHeaders: () => new Promise(resolve => {
        finishLookup = resolve;
      }),
    };
    const secondRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: 'new-session-key' }),
    };
    __testSetCurrentModelRegistry(firstRegistry);

    const pending = applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    __testSetCurrentModelRegistry(secondRegistry);
    finishLookup?.({ ok: true as const, apiKey: 'stale-session-key' });

    await expect(pending).rejects.toThrow('session registry changed');
  });

  it('discards legacy provider auth resolved after the session registry changes', async () => {
    let finishLookup: ((value: any) => void) | undefined;
    const firstRegistry = {
      getProviderAuth: () => new Promise(resolve => {
        finishLookup = resolve;
      }),
    };
    __testSetCurrentModelRegistry(firstRegistry);

    const pending = applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    __testSetCurrentModelRegistry({ getProviderAuth: async () => undefined });
    finishLookup?.({ auth: { apiKey: 'stale-session-key' } });

    await expect(pending).rejects.toThrow('session registry changed');
  });

  it('allows an authless provider that resolves a successful empty ModelAuth', async () => {
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
      getProviderAuth: async () => ({ auth: {}, source: 'authless provider' }),
    });

    const options = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'local', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect((options as any).apiKey).toBeUndefined();
  });

  it('rejects an empty facade result when the modern provider-auth path finds no credential', async () => {
    let requestAuthCalls = 0;
    const registry = {
      getApiKeyAndHeaders: async () => {
        requestAuthCalls++;
        return { ok: true as const };
      },
      getProviderAuth: async () => undefined,
    };
    __testSetCurrentModelRegistry(registry);

    await expect(applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    )).rejects.toThrow('No API key for provider: provider-a');
    expect(requestAuthCalls).toBe(1);

    const explicit = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'explicit-key' } as any,
    );
    expect((explicit as any).apiKey).toBe('explicit-key');
    expect(requestAuthCalls).toBe(2);
  });

  it('preserves an authless success from a legacy facade without getProviderAuth', async () => {
    __testSetCurrentModelRegistry({
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    });

    const options = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'local', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect((options as any).apiKey).toBeUndefined();
  });

  it('fails closed when a legacy registry exposes neither auth API', async () => {
    __testSetCurrentModelRegistry({});

    await expect(applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    )).rejects.toThrow('No API key for provider: provider-a');
  });
});

describe('extension reload lifecycle', () => {
  let testConfigDir: string;

  beforeEach(() => {
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-lifecycle-'));
    __testSetPiConfigDir(testConfigDir);
    fs.writeFileSync(path.join(testConfigDir, 'pi-router.json'), JSON.stringify({
      auto: false,
      autoSync: false,
      healthProbe: { enabled: false },
      models: [{ id: 'm1', channels: ['provider-a'] }],
    }));
    fs.writeFileSync(path.join(testConfigDir, 'models.json'), JSON.stringify({
      providers: {
        'provider-a': {
          api: 'openai-completions',
          baseUrl: 'https://provider-a.test',
          models: [{
            id: 'm1',
            name: 'm1',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          }],
        },
      },
    }));
  });

  afterEach(() => {
    __testSetPiConfigDir(null);
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  function createExtensionHarness() {
    const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
    const providers = new Map<string, any>();
    const providerEvents: string[] = [];
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
        const eventHandlers = handlers.get(event) || [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
      registerProvider(name: string, config: any) {
        providerEvents.push(`register:${name}`);
        providers.set(name, config);
      },
      unregisterProvider(name: string) {
        providerEvents.push(`unregister:${name}`);
        providers.delete(name);
      },
      registerCommand() {},
      getThinkingLevel() { return 'off'; },
    };
    const emit = async (event: string, ctx: any = {}) => {
      for (const handler of handlers.get(event) || []) {
        await handler({ type: event, reason: event === 'session_shutdown' ? 'reload' : 'reload' }, ctx);
      }
    };
    return { pi: pi as any, providers, providerEvents, emit };
  }

  function createSessionContext(apiKey: string) {
    const upstreamModel = {
      id: 'm1',
      name: 'm1',
      provider: 'provider-a',
      api: 'openai-completions',
      baseUrl: 'https://provider-a.test',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
    return {
      modelRegistry: {
        getAvailable: () => [upstreamModel],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
      },
      model: { id: 'm1', provider: 'router' },
      sessionManager: { getSessionId: () => `session-${apiKey}` },
      getContextUsage: () => undefined,
      ui: {
        theme: {},
        setStatus() {},
        setFooter() {},
        notify() {},
      },
    };
  }

  it('registers providers eagerly at factory time when no session is active; re-binds on session_start and unregisters on shutdown', async () => {
    // pi resolves settings.defaultProvider/defaultModel BEFORE session_start,
    // so the factory must register the provider while no session owns it.
    __testResetSessionProviderActiveFlag();
    const harness = createExtensionHarness();
    routerExtension(harness.pi);

    expect(harness.providers.has('router')).toBe(true);
    expect(harness.providerEvents).toEqual(['register:router']);

    await harness.emit('session_start', createSessionContext('session-a-key'));

    expect(harness.providerEvents).toEqual(['register:router', 'unregister:router', 'register:router']);
    expect(harness.providers.get('router')).toBeDefined();

    await harness.emit('session_shutdown');

    expect(harness.providers.has('router')).toBe(false);
    expect(harness.providerEvents.at(-1)).toBe('unregister:router');
  });

  it('does not let a late session-less duplicate replace the active provider or routing adapter', async () => {
    const sharedProviders = new Map<string, any>();
    const session = createExtensionHarness();
    session.pi.registerProvider = (name: string, config: any) => sharedProviders.set(name, config);
    session.pi.unregisterProvider = (name: string) => sharedProviders.delete(name);
    routerExtension(session.pi);
    await session.emit('session_start', createSessionContext('session-a-key'));
    const activeProvider = sharedProviders.get('router');
    const routingRegistry = (globalThis as any)[Symbol.for('pi.routing.registry.v1')];
    const activeAdapter = routingRegistry.getRouter('router');

    const duplicate = createExtensionHarness();
    duplicate.pi.registerProvider = (name: string, config: any) => sharedProviders.set(name, config);
    duplicate.pi.unregisterProvider = (name: string) => sharedProviders.delete(name);
    routerExtension(duplicate.pi);

    expect(duplicate.providerEvents).toEqual([]);
    expect(sharedProviders.get('router')).toBe(activeProvider);
    expect(routingRegistry.getRouter('router')).toBe(activeAdapter);

    await session.emit('session_shutdown');
  });

  it('drops stale session references and routing adapters before the replacement instance starts', async () => {
    const first = createExtensionHarness();
    routerExtension(first.pi);
    const routingRegistry = (globalThis as any)[Symbol.for('pi.routing.registry.v1')];
    expect(routingRegistry.getRouter('router')).toBeUndefined();

    await first.emit('session_start', createSessionContext('session-a-key'));
    const firstAdapter = routingRegistry.getRouter('router');
    expect(firstAdapter).toBeDefined();
    const authenticated = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect(authenticated?.apiKey).toBe('session-a-key');

    await first.emit('session_shutdown');
    expect(routingRegistry.getRouter('router')).toBeUndefined();

    const afterShutdown = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect(afterShutdown?.apiKey).toBeUndefined();

    const second = createExtensionHarness();
    routerExtension(second.pi);
    expect(routingRegistry.getRouter('router')).toBeUndefined();

    await second.emit('session_start', createSessionContext('session-b-key'));
    const secondAdapter = routingRegistry.getRouter('router');
    expect(secondAdapter).toBeDefined();
    expect(secondAdapter).not.toBe(firstAdapter);
    const replacementAuth = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect(replacementAuth?.apiKey).toBe('session-b-key');
    await second.emit('session_shutdown');
  });

  it('keeps the authenticated registry when footer events deliver a context without one', async () => {
    const harness = createExtensionHarness();
    routerExtension(harness.pi);
    await harness.emit('session_start', createSessionContext('session-a-key'));

    // Regression: footer-driving events (turn_start/message_update/...) can
    // deliver contexts without a model registry; refreshFooterContext used to
    // clobber the authenticated registry, so every routed request failed with
    // "No API key for provider: ..." until /reload.
    const footerCtx = createSessionContext('session-a-key') as any;
    delete footerCtx.modelRegistry;
    await harness.emit('turn_start', footerCtx);

    const authenticated = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect(authenticated?.apiKey).toBe('session-a-key');
  });

  it('does not reuse or reconstruct credentials after the active registry is released', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'auth.json'), JSON.stringify({
      'provider-a': { type: 'api_key', key: 'must-not-be-read-directly' },
    }));
    const harness = createExtensionHarness();
    routerExtension(harness.pi);
    await harness.emit('session_start', createSessionContext('session-a-key'));

    __testSetCurrentModelRegistry(undefined);
    const withoutRegistry = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect(withoutRegistry?.apiKey).toBeUndefined();

    await harness.emit('session_shutdown');
    const afterShutdown = await applyUpstreamRequestAuth(
      { id: 'm1', name: 'm1', provider: 'provider-a', api: 'openai-completions' } as any,
      { apiKey: 'router' } as any,
    );
    expect(afterShutdown?.apiKey).toBeUndefined();
  });

  it('rebinds footer session stats from registry-less contexts but never the registry', async () => {
    const harness = createExtensionHarness();
    routerExtension(harness.pi);
    await harness.emit('session_start', createSessionContext('session-a-key'));
    const before = __testGetInternalState();
    expect(before.currentModelRegistry).toBeDefined();

    // Footer-driving context without a model registry: the stats line must
    // keep following the live session, while the authenticated registry stays
    // untouched (this combination is what keeps the footer working after
    // /router sticky clear without reopening the No-API-key bug).
    const footerCtx: any = createSessionContext('session-a-key');
    const freshSessionManager = { getSessionId: () => 'session-footer' };
    delete footerCtx.modelRegistry;
    footerCtx.sessionManager = freshSessionManager;
    await harness.emit('turn_start', footerCtx);

    const after = __testGetInternalState();
    expect(after.currentSessionManager).toBe(freshSessionManager);
    expect(after.currentModelRegistry).toBe(before.currentModelRegistry);
  });
});

describe('resetRoutingPointer', () => {
  // resetRoutingPointer persists sticky removal via saveConfig — isolate the
  // pi config dir so tests can NEVER overwrite the real user config.
  // Re-applied in beforeEach: any file-level hook that clears the override
  // (e.g. __testResetInternalState) runs before describe-level beforeEach.
  let testConfigDir: string;

  beforeEach(() => {
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-cfg-'));
    __testSetPiConfigDir(testConfigDir);
  });

  afterEach(() => {
    __testSetPiConfigDir(null);
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  it('resets one model dimension: sticky, active channel, cooldowns, failures; leaves others intact', () => {
    const cfg = { sticky: true, models: [{ id: 'rm1', channels: ['c1', 'c2'] }, { id: 'rm9', channels: ['c9'] }] } as any;
    recordFailure('rm1', 'c1', 'boom', cfg, { id: 'rm1', channels: ['c1'] } as any);
    recordFailure('rm9', 'c9', 'boom', cfg, { id: 'rm9', channels: ['c9'] } as any);
    __testGetInternalState().activeChannels.set('rm1', 'c2');
    __testGetInternalState().activeChannels.set('rm9', 'c9');

    const result = resetRoutingPointer(cfg, 'rm1');

    expect(result.scope).toBe('rm1');
    expect(__testGetInternalState().cooldowns.has('rm1@c1')).toBe(false);
    expect(__testGetInternalState().cooldowns.has('rm9@c9')).toBe(true);
    expect(__testGetInternalState().activeChannels.has('rm1')).toBe(false);
    expect(__testGetInternalState().activeChannels.has('rm9')).toBe(true);
    expect(__testGetInternalState().failures.has('rm1')).toBe(false);
    expect(__testGetInternalState().failures.has('rm9')).toBe(true);
  });

  it('reset sends the chain back to index 0 (no sticky-first ordering)', () => {
    const modelConfig = { id: 'rm2', channels: ['c1', 'c2'] } as any;
    const cfg = { sticky: true, models: [modelConfig] } as any;
    __testGetInternalState().activeChannels.set('rm2', 'c2');
    expect(determineChannelOrder('rm2', modelConfig, cfg)[0]).toBe('c2');

    resetRoutingPointer(cfg, 'rm2');

    expect(determineChannelOrder('rm2', modelConfig, cfg)[0]).toBe('c1');
  });

  it('auto scope clears the whole auto chain state', () => {
    const cfg = { sticky: true, models: [{ id: 'a1', channels: ['x'] }, { id: 'a2', channels: ['y'] }] } as any;
    recordFailure('a1', 'x', 'No API key for provider: x', cfg, { id: 'a1', channels: ['x'] } as any);
    recordFailure('a2', 'y', 'No API key for provider: y', cfg, { id: 'a2', channels: ['y'] } as any);
    expect(__testGetInternalState().cooldowns.size).toBeGreaterThan(0);

    const result = resetRoutingPointer(cfg, 'auto');

    expect(result.scope).toBe('auto');
    expect(__testGetInternalState().cooldowns.size).toBe(0);
  });

  it('all scope also clears the auto sticky record', () => {
    const cfg = {
      sticky: true,
      models: [{ id: 'a1', channels: ['x'] }],
      stickyRecords: { auto: { modelId: 'a1', channel: 'x', successCount: 1, lastSuccess: Date.now(), lastUpdate: Date.now() } },
    } as any;

    const result = resetRoutingPointer(cfg);

    expect(result.scope).toBe('all');
    expect(result.stickyCleared).toEqual(['auto']);
    expect(cfg.stickyRecords?.['auto']).toBeUndefined();
  });
});
