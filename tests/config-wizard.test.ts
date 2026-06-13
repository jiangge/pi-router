import { describe, expect, it } from 'vitest';
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

    expect(result.get('kiro')).toEqual({ category: 'oauth', reason: 'OAuth官方认证' });
    expect(result.get('local-proxy')).toEqual({ category: 'free', reason: '本地部署' });
    expect(result.get('deepseek')).toEqual({ category: 'oauth', reason: '官方API' });
    expect(result.get('hyb-gpt')).toEqual({ category: 'aggregator', reason: '第三方平台' });
  });

  it('includes auth-only channels even when absent from models list', () => {
    const result = scanAndClassifyChannels([], { 'openai-codex': { type: 'oauth' } });

    expect(result.get('openai-codex')).toEqual({ category: 'oauth', reason: 'OAuth官方认证' });
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
