import { describe, expect, it } from 'vitest';
import { FlatOrderEditor } from '../config-wizard-flat.js';
import { buildEditableModelsFromConfig, hasExistingRouterModelConfig } from '../config-wizard-flow.js';
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
  bold: (text: string) => text,
};

describe('config order adjustment helpers', () => {
  it('detects whether an existing router config can be reordered', () => {
    expect(hasExistingRouterModelConfig({ models: [{ id: 'm1', channels: ['a'] }] } as any)).toBe(true);
    expect(hasExistingRouterModelConfig({ models: [] } as any)).toBe(false);
    expect(hasExistingRouterModelConfig({} as any)).toBe(false);
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
