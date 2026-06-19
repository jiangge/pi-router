import { describe, expect, it } from 'vitest';
import { FlatOrderEditor } from '../config-wizard-flat.js';
import { buildEditableModelsFromConfig, hasExistingRouterModelConfig, runConfigOrderWizard, runConfigWizard } from '../config-wizard-flow.js';
import { TwoTierOrderEditor } from '../config-wizard-two-tier.js';
import { ChannelOrderEditor, createStepComponent } from '../config-wizard-ui.js';
import { scanAndClassifyChannels, smartSortChannels } from '../config-wizard.js';

describe('config wizard channel classification', () => {
  it('classifies oauth, local, official api-key, and aggregator channels', () => {
    const authJson = {
      kiro: { type: 'oauth' },
      deepseek: { type: 'api_key', key: 'sk-test' },
    };

    const models = [
      { id: 'm1', provider: 'kiro', baseUrl: 'https://service.example.com/v1' },
      { id: 'm2', provider: 'local-proxy', baseUrl: 'http://localhost:7071/v1' },
      { id: 'm3', provider: 'deepseek', baseUrl: 'https://api.deepseek.com' },
      { id: 'm4', provider: 'hyb-gpt', baseUrl: 'https://ai.hybgzs.com/v1' },
    ];

    const result = scanAndClassifyChannels(models, authJson);

    expect(result.get('kiro')).toEqual({ category: 'oauth', reason: 'OAuth official auth' });
    expect(result.get('local-proxy')).toEqual({ category: 'free', reason: 'Local deployment' });
    expect(result.get('deepseek')).toEqual({ category: 'oauth', reason: 'Official API' });
    expect(result.get('hyb-gpt')).toEqual({ category: 'aggregator', reason: 'Third-party platform' });
  });

  it('includes auth-only channels even when absent from models list', () => {
    const result = scanAndClassifyChannels([], { 'openai-codex': { type: 'oauth' } });

    expect(result.get('openai-codex')).toEqual({ category: 'oauth', reason: 'OAuth official auth' });
  });
});

describe('config wizard smart sorting', () => {
  const classifications = new Map([
    ['Provider-A', { category: 'aggregator', reason: '第三方平台' }],
    ['Provider-B', { category: 'oauth', reason: '官方API' }],
    ['Provider-C', { category: 'free', reason: '本地部署' }],
  ]);

  it('sorts by latency as aggregator > oauth > free', () => {
    const result = smartSortChannels(['Provider-C', 'Provider-B', 'Provider-A'], classifications, 'latency');
    expect(result.map(r => r.channel)).toEqual(['Provider-A', 'Provider-B', 'Provider-C']);
  });

  it('sorts by capability as oauth > aggregator > free', () => {
    const result = smartSortChannels(['Provider-C', 'Provider-A', 'Provider-B'], classifications, 'capabilityFirst');
    expect(result.map(r => r.channel)).toEqual(['Provider-B', 'Provider-A', 'Provider-C']);
  });

  it('sorts by cost as free > aggregator > oauth', () => {
    const result = smartSortChannels(['Provider-B', 'Provider-C', 'Provider-A'], classifications, 'cost');
    expect(result.map(r => r.channel)).toEqual(['Provider-C', 'Provider-A', 'Provider-B']);
  });

  it('keeps relative order when strategy is manual', () => {
    const input = ['Provider-B', 'Provider-C', 'Provider-A'];
    const result = smartSortChannels(input, classifications, 'manual');
    expect(result.map(r => r.channel)).toEqual(input);
  });
});

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

const key = {
  up: '\x1b[A',
  down: '\x1b[B',
  shiftUp: '\x1b[1;2A',
  shiftDown: '\x1b[1;2B',
  enter: '\r',
  escape: '\x1b',
  delete: '\x1b[3~',
  space: ' ',
  tab: '\t',
};

function groupByModel(models: Array<{ id: string; provider: string }>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const model of models) {
    grouped.set(model.id, [...(grouped.get(model.id) || []), model.provider]);
  }
  return grouped;
}

function createQueuedCtx(results: any[]) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      custom: async () => results.shift(),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };
}

function createInteractiveCtx(scripts: string[][]) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      custom: async (factory: any) => {
        const script = scripts.shift();
        if (!script) throw new Error('missing UI script');

        const unset = Symbol('unset');
        let result: any = unset;
        const component = factory(
          { requestRender: () => {} },
          theme,
          {},
          (value: any) => {
            result = value;
          },
        );

        component.render?.(80);
        for (const input of script) {
          component.handleInput?.(input);
          component.render?.(80);
          if (result !== unset) break;
        }

        if (result === unset) throw new Error('UI script did not complete step');
        return result;
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };
}

describe('config order adjustment helpers', () => {
  it('detects whether an existing router config can be reordered', () => {
    expect(hasExistingRouterModelConfig({ models: [{ id: 'm1', channels: ['a'] }] } as any)).toBe(true);
    expect(hasExistingRouterModelConfig({ models: [] } as any)).toBe(false);
    expect(hasExistingRouterModelConfig({} as any)).toBe(false);
  });

  it('runs the full wizard through keyboard-driven UI components', async () => {
    const ctx = createInteractiveCtx([
      [key.down, key.enter],
      [key.down, key.down, key.down, key.enter],
      [key.enter],
      [key.down, key.enter],
      [key.enter],
      [key.down, key.enter, key.up, key.enter, 'c'],
    ]);
    let savedConfig: any;

    await runConfigWizard(
      ctx,
      () => [
        { id: 'm1', provider: 'a', baseUrl: 'https://a.example/v1' },
        { id: 'm1', provider: 'b', baseUrl: 'https://b.example/v1' },
      ],
      groupByModel,
      (config) => {
        savedConfig = config;
      },
      () => 'models-hash',
      () => '/tmp/models.json',
    );

    expect(savedConfig).toMatchObject({
      strategy: 'custom',
      sortBy: 'manual',
      autoSync: true,
      sticky: true,
      healthProbe: { enabled: false },
      customOrder: ['m1@b', 'm1@a'],
    });
    expect(ctx.notifications.at(-1)?.message).toContain('Configuration Complete');
  });

  it('runs the full wizard and saves custom order config', async () => {
    const ctx = createQueuedCtx([
      'custom',
      'manual',
      'true',
      'disabled',
      'true',
      ['m1@b', 'm1@a'],
    ]);
    let savedConfig: any;

    await runConfigWizard(
      ctx,
      () => [
        { id: 'm1', provider: 'a', baseUrl: 'https://a.example/v1' },
        { id: 'm1', provider: 'b', baseUrl: 'https://b.example/v1' },
        { id: 'm2', provider: 'solo', baseUrl: 'https://solo.example/v1' },
      ],
      groupByModel,
      (config) => {
        savedConfig = config;
      },
      () => 'models-hash',
      () => '/tmp/models.json',
    );

    expect(savedConfig).toMatchObject({
      strategy: 'custom',
      sortBy: 'manual',
      autoSync: true,
      sticky: true,
      healthProbe: { enabled: false },
      contextTransfer: 'summary',
      lastSyncHash: 'models-hash',
      models: [{ id: 'm1', channels: ['b', 'a'] }],
      customOrder: ['m1@b', 'm1@a'],
    });
    expect(ctx.notifications.at(-1)?.message).toContain('Configuration Complete');
  });

  it('notifies instead of saving when wizard finds no multi-channel models', async () => {
    const ctx = createQueuedCtx([
      'channelFirst',
      'manual',
      'true',
      'disabled',
      'true',
    ]);
    let saved = false;

    await runConfigWizard(
      ctx,
      () => [{ id: 'm1', provider: 'solo', baseUrl: 'https://solo.example/v1' }],
      groupByModel,
      () => {
        saved = true;
      },
      () => 'models-hash',
      () => '/tmp/models.json',
    );

    expect(saved).toBe(false);
    expect(ctx.notifications.at(-1)).toMatchObject({ level: 'warning' });
    expect(ctx.notifications.at(-1)?.message).toContain('No multi-channel models found');
  });

  it('runs order wizard and preserves existing non-order config', async () => {
    const ctx = createQueuedCtx([
      [{ id: 'm1', channels: ['b', 'a'] }],
    ]);
    const originalConfig = {
      strategy: 'channelFirst',
      sortBy: 'manual',
      autoSync: false,
      request: { timeoutMs: 1234 },
      footer: { rightAlignRoute: false, statusLine: false },
      models: [{ id: 'm1', channels: ['a', 'b'] }],
    } as any;
    let savedConfig: any;

    await runConfigOrderWizard(
      ctx,
      originalConfig,
      () => [
        { id: 'm1', provider: 'a', baseUrl: 'https://a.example/v1' },
        { id: 'm1', provider: 'b', baseUrl: 'https://b.example/v1' },
      ],
      (config) => {
        savedConfig = config;
      },
    );

    expect(savedConfig).toMatchObject({
      strategy: 'channelFirst',
      sortBy: 'manual',
      autoSync: false,
      request: { timeoutMs: 1234 },
      footer: { rightAlignRoute: false, statusLine: false },
      models: [{ id: 'm1', channels: ['b', 'a'] }],
    });
    expect(ctx.notifications.at(-1)?.message).toContain('Order Updated');
  });

  it('runs order wizard and preserves duplicate-provider routes in channel-first config', async () => {
    const ctx = createInteractiveCtx([
      ['c'],
    ]);
    const originalConfig = {
      strategy: 'channelFirst',
      sortBy: 'manual',
      autoSync: false,
      request: { timeoutMs: 1234 },
      models: [
        {
          id: 'deepseek-v4-flash',
          aliases: ['oc/deepseek-v4-flash-free'],
          channels: ['wx-api'],
          routes: [
            { channel: 'wx-api' },
            { channel: 'wx-api', model: 'oc/deepseek-v4-flash-free' },
          ],
        },
      ],
    } as any;
    let savedConfig: any;

    await runConfigOrderWizard(
      ctx,
      originalConfig,
      () => [
        { id: 'deepseek-v4-flash', provider: 'wx-api', baseUrl: 'https://agg.example.com/v1' },
        { id: 'oc/deepseek-v4-flash-free', provider: 'wx-api', baseUrl: 'https://agg.example.com/v1' },
      ],
      (config) => {
        savedConfig = config;
      },
    );

    expect(savedConfig.models).toEqual([
      {
        id: 'deepseek-v4-flash',
        aliases: ['oc/deepseek-v4-flash-free'],
        channels: ['wx-api'],
        routes: [
          { channel: 'wx-api' },
          { channel: 'wx-api', model: 'oc/deepseek-v4-flash-free' },
        ],
      },
    ]);
    expect(ctx.notifications.at(-1)?.message).toContain('Order Updated');
  });

  it('deletes multiple selected model/channel pairs in channel-first order wizard', async () => {
    const ctx = createInteractiveCtx([
      [key.tab, key.space, key.down, key.space, key.delete, key.enter, 'c'],
    ]);
    const originalConfig = {
      strategy: 'channelFirst',
      sortBy: 'manual',
      models: [{ id: 'm1', channels: ['a', 'b', 'c'] }],
    } as any;
    let savedConfig: any;

    await runConfigOrderWizard(
      ctx,
      originalConfig,
      () => [
        { id: 'm1', provider: 'a', baseUrl: 'https://a.example/v1' },
        { id: 'm1', provider: 'b', baseUrl: 'https://b.example/v1' },
        { id: 'm1', provider: 'c', baseUrl: 'https://c.example/v1' },
      ],
      (config) => {
        savedConfig = config;
      },
    );

    expect(savedConfig.models).toEqual([{ id: 'm1', channels: ['c'] }]);
  });

  it('runs order wizard and saves customRoutes for duplicate-provider variants', async () => {
    const ctx = createInteractiveCtx([
      ['c'],
    ]);
    const originalConfig = {
      strategy: 'custom',
      sortBy: 'manual',
      autoSync: false,
      models: [
        {
          id: 'deepseek-v4-flash',
          aliases: ['oc/deepseek-v4-flash-free'],
          channels: ['wx-api'],
          routes: [
            { channel: 'wx-api' },
            { channel: 'wx-api', model: 'oc/deepseek-v4-flash-free' },
          ],
        },
      ],
      customRoutes: [
        { model: 'deepseek-v4-flash', channel: 'wx-api', upstreamModel: 'oc/deepseek-v4-flash-free' },
        { model: 'deepseek-v4-flash', channel: 'wx-api' },
      ],
    } as any;
    let savedConfig: any;

    await runConfigOrderWizard(
      ctx,
      originalConfig,
      () => [
        { id: 'deepseek-v4-flash', provider: 'wx-api', baseUrl: 'https://agg.example.com/v1' },
        { id: 'oc/deepseek-v4-flash-free', provider: 'wx-api', baseUrl: 'https://agg.example.com/v1' },
      ],
      (config) => {
        savedConfig = config;
      },
    );

    expect(savedConfig.customOrder).toEqual([
      'deepseek-v4-flash@wx-api#oc/deepseek-v4-flash-free',
      'deepseek-v4-flash@wx-api',
    ]);
    expect(savedConfig.customRoutes).toEqual([
      { model: 'deepseek-v4-flash', channel: 'wx-api', upstreamModel: 'oc/deepseek-v4-flash-free' },
      { model: 'deepseek-v4-flash', channel: 'wx-api' },
    ]);
    expect(savedConfig.models[0]).toMatchObject({
      id: 'deepseek-v4-flash',
      aliases: ['oc/deepseek-v4-flash-free'],
      channels: ['wx-api'],
      routes: [
        { channel: 'wx-api', model: 'oc/deepseek-v4-flash-free' },
        { channel: 'wx-api' },
      ],
    });
  });

  it('deletes multiple selected model/channel pairs in custom order wizard', async () => {
    const ctx = createInteractiveCtx([
      [key.space, key.down, key.space, key.delete, key.enter, 'c'],
    ]);
    const originalConfig = {
      strategy: 'custom',
      sortBy: 'manual',
      models: [
        { id: 'm1', channels: ['a', 'b'] },
      ],
      customOrder: ['m1@a', 'm1@b'],
    } as any;
    let savedConfig: any;

    await runConfigOrderWizard(
      ctx,
      originalConfig,
      () => [
        { id: 'm1', provider: 'a', baseUrl: 'https://a.example/v1' },
        { id: 'm1', provider: 'b', baseUrl: 'https://b.example/v1' },
      ],
      (config) => {
        savedConfig = config;
      },
    );

    expect(savedConfig.customOrder).toEqual([]);
    expect(savedConfig.customRoutes).toEqual([]);
    expect(savedConfig.models).toEqual([]);
  });

  it('moves a shift-selected channel range as a group', () => {
    const editor = new TwoTierOrderEditor(
      [
        {
          id: 'm1',
          channels: [
            { channel: 'a', score: 50, reason: 'r', category: 'aggregator' },
            { channel: 'b', score: 50, reason: 'r', category: 'aggregator' },
            { channel: 'c', score: 50, reason: 'r', category: 'aggregator' },
            { channel: 'd', score: 50, reason: 'r', category: 'aggregator' },
          ],
        },
      ],
      theme,
    );

    editor.handleInput(key.tab);
    editor.handleInput(key.shiftDown);
    editor.handleInput(key.enter);
    editor.handleInput(key.down);
    editor.handleInput(key.enter);

    expect(editor.getResult()[0].channels).toEqual(['c', 'a', 'b', 'd']);
  });

  it('builds editable models from current config order and appends discovered channels', () => {
    const editable = buildEditableModelsFromConfig(
      {
        models: [
          { id: 'gpt-5.5', channels: ['xiaojimao', 'pipi', 'router', 'openai'] },
          { id: 'deepseek-v4-flash', channels: ['deepseek'] },
        ],
      } as any,
      [
        { id: 'gpt-5.5', provider: 'pipi', baseUrl: 'https://agg.example.com/v1' },
        { id: 'gpt-5.5', provider: 'xiaojimao', baseUrl: 'https://agg.example.com/v1' },
        { id: 'gpt-5.5', provider: 'wong', baseUrl: 'https://agg.example.com/v1' },
        { id: 'deepseek-v4-flash', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' },
      ],
    );

    expect(editable.map(model => model.id)).toEqual(['gpt-5.5', 'deepseek-v4-flash']);
    expect(editable[0].channels.map(channel => channel.channel)).toEqual(['xiaojimao', 'pipi', 'openai', 'wong']);
    expect(editable[0].channels[0].reason).toBe('Third-party platform');
    expect(editable[0].channels[2].reason).toBe('Configured channel (currently unavailable)');
    expect(editable[1].channels[0].reason).toBe('Official API');
  });

  it('builds editable duplicate-provider routes with display-only upstream labels', () => {
    const editable = buildEditableModelsFromConfig(
      {
        models: [
          {
            id: 'deepseek-v4-flash',
            aliases: ['oc/deepseek-v4-flash-free'],
            channels: ['wx-api'],
            routes: [
              { channel: 'wx-api' },
              { channel: 'wx-api', model: 'oc/deepseek-v4-flash-free' },
            ],
          },
        ],
      } as any,
      [
        { id: 'deepseek-v4-flash', provider: 'wx-api', baseUrl: 'https://agg.example.com/v1' },
        { id: 'oc/deepseek-v4-flash-free', provider: 'wx-api', baseUrl: 'https://agg.example.com/v1' },
      ],
    );

    expect(editable[0].channels.map(channel => channel.channel)).toEqual(['wx-api', 'wx-api']);
    expect(editable[0].channels.map(channel => channel.label)).toEqual([
      'wx-api',
      'wx-api (oc/deepseek-v4-flash-free)',
    ]);
    expect(editable[0].channels.map(channel => channel.routeKey)).toEqual([
      'wx-api',
      'wx-api#oc/deepseek-v4-flash-free',
    ]);
  });

  it('keeps saved custom order and appends newly discovered pairs in flat editor', () => {
    const editor = new FlatOrderEditor(
      [
        {
          id: 'gpt-5.5',
          channels: [
            { channel: 'xiaojimao', score: 50, reason: '第三方平台', category: 'aggregator' },
            { channel: 'pipi', score: 50, reason: '第三方平台', category: 'aggregator' },
          ],
        },
        {
          id: 'deepseek-v4-flash',
          channels: [
            { channel: 'deepseek', score: 50, reason: '官方API', category: 'oauth' },
          ],
        },
      ],
      {} as any,
      ['deepseek-v4-flash@deepseek'],
    );

    expect(editor.getResult()).toEqual([
      'deepseek-v4-flash@deepseek',
      'gpt-5.5@xiaojimao',
      'gpt-5.5@pipi',
    ]);
  });

  it('reorders and cancels moves in flat custom editor', () => {
    const editor = new FlatOrderEditor(
      [
        {
          id: 'm1',
          channels: [
            { channel: 'a', score: 50, reason: 'A', category: 'aggregator' },
            { channel: 'b', score: 50, reason: 'B', category: 'oauth' },
            { channel: 'c', score: 50, reason: 'C', category: 'free' },
          ],
        },
      ],
      theme,
    );

    editor.handleInput(key.down);
    editor.handleInput(key.enter);
    expect(editor.render(80).join('\n')).toContain('[MOVING current]');
    editor.handleInput(key.up);
    editor.handleInput(key.enter);
    expect(editor.getResult()).toEqual(['m1@b', 'm1@a', 'm1@c']);

    editor.handleInput(key.enter);
    editor.handleInput(key.down);
    editor.handleInput(key.enter);
    expect(editor.getResult()).toEqual(['m1@a', 'm1@b', 'm1@c']);

    editor.handleInput(key.down);
    editor.handleInput(key.down);
    editor.handleInput(key.enter);
    editor.handleInput(key.up);
    editor.handleInput(key.escape);
    expect(editor.getResult()).toEqual(['m1@a', 'm1@b', 'm1@c']);
  });

  it('keeps duplicate-provider variants distinct in flat custom editor', () => {
    const editor = new FlatOrderEditor(
      [
        {
          id: 'deepseek-v4-flash',
          channels: [
            { channel: 'wx-api', score: 50, reason: '第三方平台', category: 'aggregator', label: 'wx-api', routeKey: 'wx-api' },
            {
              channel: 'wx-api',
              score: 50,
              reason: '第三方平台',
              category: 'aggregator',
              label: 'wx-api (oc/deepseek-v4-flash-free)',
              routeKey: 'wx-api#oc/deepseek-v4-flash-free',
              upstreamModel: 'oc/deepseek-v4-flash-free',
            },
          ],
        },
      ],
      theme,
      ['deepseek-v4-flash@wx-api#oc/deepseek-v4-flash-free'],
    );

    expect(editor.render(80).join('\n')).toContain('deepseek-v4-flash@wx-api (oc/deepseek-v4-flash-free)');
    expect(editor.getResult()).toEqual([
      'deepseek-v4-flash@wx-api#oc/deepseek-v4-flash-free',
      'deepseek-v4-flash@wx-api',
    ]);
  });

  it('supports basic two-tier editor completion and preserves configured order', () => {
    const editor = new TwoTierOrderEditor(
      [
        {
          id: 'gpt-5.5',
          channels: [
            { channel: 'xiaojimao', score: 50, reason: '第三方平台', category: 'aggregator' },
            { channel: 'pipi', score: 50, reason: '第三方平台', category: 'aggregator' },
          ],
        },
      ],
      theme,
    );

    let completed = false;
    editor.onComplete = () => {
      completed = true;
    };

    editor.handleInput('c');
    expect(completed).toBe(true);
    expect(editor.render(80).join('\n')).toContain('Step 6/6');
    expect(editor.getResult()).toEqual([{ id: 'gpt-5.5', channels: ['xiaojimao', 'pipi'] }]);
  });

  it('serializes duplicate-provider variants as routes in two-tier editor', () => {
    const editor = new TwoTierOrderEditor(
      [
        {
          id: 'deepseek-v4-flash',
          channels: [
            { channel: 'wx-api', score: 50, reason: '第三方平台', category: 'aggregator', label: 'wx-api', routeKey: 'wx-api' },
            {
              channel: 'wx-api',
              score: 50,
              reason: '第三方平台',
              category: 'aggregator',
              label: 'wx-api (oc/deepseek-v4-flash-free)',
              routeKey: 'wx-api#oc/deepseek-v4-flash-free',
              upstreamModel: 'oc/deepseek-v4-flash-free',
            },
          ],
        },
      ],
      theme,
    );

    expect(editor.render(80).join('\n')).toContain('2 channels');
    editor.handleInput(key.tab);
    expect(editor.render(80).join('\n')).toContain('wx-api (oc/deepseek-v4-flash-free)');
    expect(editor.getResult()).toEqual([
      {
        id: 'deepseek-v4-flash',
        channels: ['wx-api'],
        routes: [
          { channel: 'wx-api' },
          { channel: 'wx-api', model: 'oc/deepseek-v4-flash-free' },
        ],
      },
    ]);
  });

  it('restores cancelled two-tier model and channel moves', () => {
    const editor = new TwoTierOrderEditor(
      [
        {
          id: 'm1',
          channels: [
            { channel: 'a', score: 50, reason: 'A', category: 'aggregator' },
            { channel: 'b', score: 50, reason: 'B', category: 'oauth' },
          ],
        },
        {
          id: 'm2',
          channels: [{ channel: 'c', score: 50, reason: 'C', category: 'free' }],
        },
      ],
      theme,
    );

    editor.handleInput(key.enter);
    editor.handleInput(key.down);
    editor.handleInput(key.escape);
    expect(editor.getResult().map(model => model.id)).toEqual(['m1', 'm2']);

    editor.handleInput(key.tab);
    editor.handleInput(key.down);
    editor.handleInput(key.enter);
    editor.handleInput(key.up);
    editor.handleInput(key.escape);
    expect(editor.getResult()[0].channels).toEqual(['a', 'b']);
  });

  it('reorders models and per-model channels in two-tier editor', () => {
    const modelEditor = new TwoTierOrderEditor(
      [
        {
          id: 'm1',
          channels: [{ channel: 'a', score: 50, reason: 'A', category: 'aggregator' }],
        },
        {
          id: 'm2',
          channels: [{ channel: 'b', score: 50, reason: 'B', category: 'oauth' }],
        },
      ],
      theme,
    );

    modelEditor.handleInput(key.down);
    modelEditor.handleInput(key.enter);
    modelEditor.handleInput(key.up);
    modelEditor.handleInput(key.enter);
    expect(modelEditor.getResult().map(model => model.id)).toEqual(['m2', 'm1']);

    const channelEditor = new TwoTierOrderEditor(
      [
        {
          id: 'm1',
          channels: [
            { channel: 'a', score: 50, reason: 'A', category: 'aggregator' },
            { channel: 'b', score: 50, reason: 'B', category: 'oauth' },
            { channel: 'c', score: 50, reason: 'C', category: 'free' },
          ],
        },
      ],
      theme,
    );

    channelEditor.handleInput(key.tab);
    expect(channelEditor.render(80).join('\n')).toContain('Layer 2: Channel Order');
    channelEditor.handleInput(key.enter);
    channelEditor.handleInput(key.down);
    channelEditor.handleInput(key.enter);
    expect(channelEditor.getResult()).toEqual([{ id: 'm1', channels: ['b', 'a', 'c'] }]);
  });

  it('supports basic channel order editor completion', () => {
    const editor = new ChannelOrderEditor(
      [
        {
          id: 'gpt-5.5',
          channels: [
            { channel: 'xiaojimao', score: 50, reason: '第三方平台', category: 'aggregator' },
            { channel: 'pipi', score: 50, reason: '第三方平台', category: 'aggregator' },
          ],
        },
      ],
      theme,
    );

    let completed = false;
    editor.onComplete = () => {
      completed = true;
    };

    editor.handleInput('c');
    expect(completed).toBe(true);
    expect(editor.render(80).join('\n')).toContain('Adjust Channel Order');
    expect(editor.getResult()).toEqual([{ id: 'gpt-5.5', channels: ['xiaojimao', 'pipi'] }]);
  });

  it('reorders a selected channel upward in the channel editor', () => {
    const editor = new ChannelOrderEditor(
      [
        {
          id: 'm1',
          channels: [
            { channel: 'a', score: 50, reason: 'A', category: 'aggregator' },
            { channel: 'b', score: 50, reason: 'B', category: 'oauth' },
          ],
        },
      ],
      theme,
    );

    editor.handleInput(key.down);
    editor.handleInput(key.enter);
    editor.handleInput(key.up);
    editor.handleInput(key.enter);

    expect(editor.getResult()).toEqual([{ id: 'm1', channels: ['b', 'a'] }]);
  });

  it('reorders channels across navigation and restores cancelled moves', () => {
    const editor = new ChannelOrderEditor(
      [
        {
          id: 'm1',
          channels: [
            { channel: 'a', score: 50, reason: 'A', category: 'aggregator' },
            { channel: 'b', score: 50, reason: 'B', category: 'oauth' },
          ],
        },
        {
          id: 'm2',
          channels: [
            { channel: 'c', score: 50, reason: 'C', category: 'free' },
            { channel: 'd', score: 50, reason: 'D', category: 'aggregator' },
          ],
        },
      ],
      theme,
    );

    editor.handleInput(key.down);
    editor.handleInput(key.down);
    expect(editor.render(80).join('\n')).toContain('Model 2/2: m2');

    editor.handleInput(key.enter);
    editor.handleInput(key.down);
    editor.handleInput(key.escape);
    expect(editor.getResult()).toEqual([
      { id: 'm1', channels: ['a', 'b'] },
      { id: 'm2', channels: ['c', 'd'] },
    ]);

    editor.handleInput(key.enter);
    editor.handleInput(key.down);
    editor.handleInput(key.enter);
    expect(editor.getResult()).toEqual([
      { id: 'm1', channels: ['a', 'b'] },
      { id: 'm2', channels: ['d', 'c'] },
    ]);
  });

  it('builds reusable step components with select and cancel hooks', () => {
    const selected: string[] = [];
    let cancelled = false;
    const { container, selectList } = createStepComponent(
      1,
      6,
      'Choose Routing Strategy',
      [{ value: 'channelFirst', label: 'channelFirst', description: 'Try channels first' }],
      theme,
      (value) => selected.push(value),
      () => {
        cancelled = true;
      },
    );

    selectList.onSelect?.({ value: 'channelFirst' } as any);
    selectList.onCancel?.();

    expect(selected).toEqual(['channelFirst']);
    expect(cancelled).toBe(true);
    expect(container.render(80).join('\n')).toContain('Choose Routing Strategy');
  });
});
