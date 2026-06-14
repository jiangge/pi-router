import { describe, expect, it } from 'vitest';
import { FlatOrderEditor } from '../config-wizard-flat.js';
import { buildEditableModelsFromConfig, hasExistingRouterModelConfig } from '../config-wizard-flow.js';
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
    expect(editable[0].channels.map(channel => channel.channel)).toEqual(['xiaojimao', 'pipi', 'wong']);
    expect(editable[0].channels[0].reason).toBe('Third-party platform');
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
});
