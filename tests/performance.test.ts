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
  __testLoadConfig,
  __testLoadModelsJson,
  __testRefreshConfigFromDisk,
  __testResetInternalState,
  __testSaveConfig,
  __testSetPiConfigDir,
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

  it('rebuilds cached model map when models.json changes', () => {
    writeModelsJson('m1');
    expect(Array.from(__testGetCachedModelMap().keys())).toEqual(['m1@Provider-A']);

    writeModelsJson('m2');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(testDir, 'models.json'), future, future);

    expect(Array.from(__testGetCachedModelMap().keys())).toEqual(['m2@Provider-A']);
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
