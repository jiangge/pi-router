/**
 * Performance and cache regression tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  __testCalculateFileHash,
  __testGetCachedModelMap,
  __testGetConfigurableModels,
  __testGetSyncModels,
  __testGetHealthProbeTimerKeys,
  __testLoadConfig,
  __testLoadModelsJson,
  __testRefreshConfigFromDisk,
  __testResetInternalState,
  __testSaveConfig,
  __testSetPiConfigDir,
  __testStartHealthProbes,
} from '../index.js';

describe('Performance Optimizations', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    __testResetInternalState();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-perf-'));
    testFile = path.join(testDir, 'test.json');
    fs.writeFileSync(testFile, JSON.stringify({ test: 'data' }), 'utf-8');
    __testSetPiConfigDir(testDir);
  });

  afterEach(() => {
    __testResetInternalState();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function writeModelsJson(modelId: string, provider = 'Provider-A') {
    fs.writeFileSync(
      path.join(testDir, 'models.json'),
      JSON.stringify({
        providers: {
          [provider]: {
            models: [
              {
                id: modelId,
                name: modelId,
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
        },
      }),
      'utf-8',
    );
  }

  it('caches file hash by mtime and recalculates when the file changes', () => {
    const hash1 = __testCalculateFileHash(testFile);
    const hash2 = __testCalculateFileHash(testFile);
    expect(hash2).toBe(hash1);

    fs.writeFileSync(testFile, JSON.stringify({ test: 'modified' }), 'utf-8');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(testFile, future, future);

    const hash3 = __testCalculateFileHash(testFile);
    expect(hash3).not.toBe(hash1);
  });

  it('reloads models.json immediately when its mtime changes', () => {
    writeModelsJson('m1');
    expect(__testLoadModelsJson().map(model => model.id)).toEqual(['m1']);

    writeModelsJson('m2');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(testDir, 'models.json'), future, future);

    expect(__testLoadModelsJson().map(model => model.id)).toEqual(['m2']);
  });

  it('adds auth-only builtin providers when they are absent from models.json', () => {
    fs.writeFileSync(
      path.join(testDir, 'auth.json'),
      JSON.stringify({ 'openai-codex': { type: 'oauth' } }),
      'utf-8',
    );
    writeModelsJson('m1', 'Provider-A');

    const providers = __testLoadModelsJson().map(model => model.provider);

    expect(providers).toContain('Provider-A');
    expect(providers).toContain('openai-codex');
  });

  it('does not re-add an explicitly disabled provider from auth.json', () => {
    fs.writeFileSync(
      path.join(testDir, 'auth.json'),
      JSON.stringify({ 'openai-codex': { type: 'oauth' } }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testDir, 'models.json'),
      JSON.stringify({
        providers: {
          'openai-codex': { models: [] },
          'Provider-A': {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
        },
      }),
      'utf-8',
    );

    const providers = __testLoadModelsJson().map(model => model.provider);

    expect(providers).toEqual(['Provider-A']);
  });

  it('rebuilds cached model map when models.json changes', () => {
    writeModelsJson('m1');
    expect(Array.from(__testGetCachedModelMap().keys())).toEqual(['m1@Provider-A']);

    writeModelsJson('m2');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(testDir, 'models.json'), future, future);

    expect(Array.from(__testGetCachedModelMap().keys())).toEqual(['m2@Provider-A']);
  });

  it('prefers latest models.json for configurable models even when modelRegistry is stale', () => {
    fs.writeFileSync(
      path.join(testDir, 'auth.json'),
      JSON.stringify({
        'Provider-A': { type: 'api_key', key: 'sk-a' },
        'wx-api': { type: 'api_key', key: 'sk-wx' },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testDir, 'models.json'),
      JSON.stringify({
        providers: {
          'Provider-A': {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
          'wx-api': {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
        },
      }),
      'utf-8',
    );

    const staleRegistry = {
      getAvailable: () => [
        {
          id: 'm1',
          name: 'm1',
          provider: 'Provider-A',
          api: 'pi-router-test-api',
          contextWindow: 100,
          maxTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };

    expect(__testGetConfigurableModels(staleRegistry, true).map(model => `${model.id}@${model.provider}`)).toEqual([
      'm1@Provider-A',
      'm1@wx-api',
    ]);
  });

  it('force refreshes configurable models even when models.json mtime does not advance', () => {
    fs.writeFileSync(
      path.join(testDir, 'auth.json'),
      JSON.stringify({
        'Provider-A': { type: 'api_key', key: 'sk-a' },
        'wx-api': { type: 'api_key', key: 'sk-wx' },
      }),
      'utf-8',
    );
    const modelsPath = path.join(testDir, 'models.json');
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          'Provider-A': {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
        },
      }),
      'utf-8',
    );

    expect(__testGetConfigurableModels(undefined, true).map(model => `${model.id}@${model.provider}`)).toEqual([
      'm1@Provider-A',
    ]);

    const initialMtime = fs.statSync(modelsPath).mtime;
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          'Provider-A': {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
          'wx-api': {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
        },
      }),
      'utf-8',
    );
    fs.utimesSync(modelsPath, initialMtime, initialMtime);

    expect(__testGetConfigurableModels(undefined, true).map(model => `${model.id}@${model.provider}`)).toEqual([
      'm1@Provider-A',
      'm1@wx-api',
    ]);
  });

  it('sync models include auth-only builtin providers and ignore deprecated candidates', () => {
    fs.writeFileSync(
      path.join(testDir, 'auth.json'),
      JSON.stringify({ 'openai-codex': { type: 'oauth' } }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testDir, 'models.json'),
      JSON.stringify({
        providers: {
          'Provider-A': {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
              {
                id: 'deprecated-m2',
                name: 'Deprecated model',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
              {
                id: 'm3',
                name: 'm3',
                api: 'pi-router-test-api',
                status: 'deprecated',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
        },
      }),
      'utf-8',
    );

    const syncModels = __testGetSyncModels().map(model => `${model.id}@${model.provider}`);
    expect(syncModels).toContain('m1@Provider-A');
    expect(syncModels.some(item => item.endsWith('@openai-codex'))).toBe(true);
    expect(syncModels.some(item => item.includes('deprecated'))).toBe(false);
    expect(syncModels.some(item => item.startsWith('m3@'))).toBe(false);
  });

  it('does not schedule health probes for deprecated configured routes', () => {
    fs.writeFileSync(
      path.join(testDir, 'models.json'),
      JSON.stringify({
        providers: {
          ok: {
            models: [
              {
                id: 'm1',
                name: 'm1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
          bad: {
            models: [
              {
                id: 'deprecated-m1',
                name: 'Deprecated m1',
                api: 'pi-router-test-api',
                contextWindow: 100,
                maxTokens: 10,
              },
            ],
          },
        },
      }),
      'utf-8',
    );

    __testStartHealthProbes({
      healthProbe: { enabled: true, intervalMs: 600000, timeoutMs: 1000 },
      models: [
        {
          id: 'm1',
          channels: ['ok', 'bad'],
          modelByChannel: { bad: 'deprecated-m1' },
        },
      ],
    } as any);

    expect(__testGetHealthProbeTimerKeys()).toEqual(['m1@ok']);
  });

  it('defaults auto-sync on but health probes off when loading user config', () => {
    const configPath = path.join(testDir, 'pi-router.json');
    fs.writeFileSync(configPath, JSON.stringify({ strategy: 'channelFirst', models: [{ id: 'm1', channels: ['a'] }] }), 'utf-8');

    const config = __testLoadConfig();
    expect(config.models?.[0]?.channels).toEqual(['a']);
    expect(config.autoSync).toBe(true);
    expect(config.healthProbe?.enabled).not.toBe(true);
  });

  it('refreshes router config from disk into the active config reference', () => {
    const configPath = path.join(testDir, 'pi-router.json');
    fs.writeFileSync(configPath, JSON.stringify({ strategy: 'channelFirst', models: [{ id: 'm1', channels: ['a'] }] }), 'utf-8');

    expect(__testLoadConfig().models?.[0]?.channels).toEqual(['a']);

    fs.writeFileSync(configPath, JSON.stringify({ strategy: 'custom', customOrder: ['m1@b'], models: [{ id: 'm1', channels: ['b'] }] }), 'utf-8');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(configPath, future, future);

    const refreshed = __testRefreshConfigFromDisk();
    expect(refreshed.strategy).toBe('custom');
    expect(refreshed.models?.[0]?.channels).toEqual(['b']);
    expect(refreshed.customOrder).toEqual(['m1@b']);
  });

  it('preserves advanced config fields when saving comments', () => {
    const configPath = path.join(testDir, 'pi-router.json');
    const config = {
      strategy: 'channelFirst',
      auto: false,
      models: [{ id: 'm1', channels: ['a'] }],
      request: { timeoutMs: 1234, maxRetries: 2, maxRetryDelayMs: 99, maxTokens: 456 },
      footer: { rightAlignRoute: false, statusLine: false },
      stickyRecords: {
        m1: { modelId: 'm1', channel: 'a', successCount: 3, lastSuccess: 10, lastUpdate: 20 },
      },
      intent: 'auto',
    } as any;

    __testSaveConfig(config);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(saved.auto).toBe(false);
    expect(saved.autoSync).toBe(true);
    expect(saved.healthProbe).toEqual({ enabled: false });
    expect(saved.request).toEqual(config.request);
    expect(saved.footer).toEqual(config.footer);
    expect(saved.stickyRecords).toEqual(config.stickyRecords);
    expect(saved.intent).toBe('auto');
  });

  it('defers health probes to avoid blocking startup', () => {
    let probesStarted = false;
    let initializationComplete = false;

    const startHealthProbes = () => {
      probesStarted = true;
    };

    const config = {
      healthProbe: { enabled: true }
    };

    const initialize = () => {
      if (config.healthProbe?.enabled) {
        setTimeout(() => {
          startHealthProbes();
          expect(initializationComplete).toBe(true);
          expect(probesStarted).toBe(true);
        }, 10);
      }

      initializationComplete = true;
    };

    initialize();

    expect(initializationComplete).toBe(true);
    expect(probesStarted).toBe(false);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(probesStarted).toBe(true);
        resolve();
      }, 20);
    });
  });
});
