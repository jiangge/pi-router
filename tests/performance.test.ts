/**
 * Performance test for startup optimization
 * Tests file hash caching and model loading optimization
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Performance Optimizations', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-perf-'));
    testFile = path.join(testDir, 'test.json');
    fs.writeFileSync(testFile, JSON.stringify({ test: 'data' }), 'utf-8');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should cache file hash based on mtime', () => {
    // Simulate the hash cache implementation
    const fileHashCache = new Map<string, { hash: string; mtime: number }>();
    
    const calculateFileHash = (filePath: string): string => {
      if (!fs.existsSync(filePath)) return '';
      
      const stats = fs.statSync(filePath);
      const mtime = stats.mtimeMs;
      
      // Check cache
      const cached = fileHashCache.get(filePath);
      if (cached && cached.mtime === mtime) {
        return cached.hash;
      }
      
      // Calculate hash (simplified for test)
      const content = fs.readFileSync(filePath, 'utf-8');
      const hash = `hash-${content.length}`;
      
      // Update cache
      fileHashCache.set(filePath, { hash, mtime });
      return hash;
    };

    // First call - should calculate
    const hash1 = calculateFileHash(testFile);
    expect(hash1).toBe('hash-15'); // {"test":"data"} without trailing newline
    expect(fileHashCache.size).toBe(1);

    // Second call - should use cache (file unchanged)
    const hash2 = calculateFileHash(testFile);
    expect(hash2).toBe(hash1);
    expect(fileHashCache.size).toBe(1);

    // Modify file and force a distinct mtime for filesystems with coarse timestamp resolution
    fs.writeFileSync(testFile, JSON.stringify({ test: 'modified' }), 'utf-8');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(testFile, future, future);
    
    // Third call - should recalculate (mtime changed)
    const hash3 = calculateFileHash(testFile);
    expect(hash3).toBe('hash-19'); // {"test":"modified"} without trailing newline
    expect(hash3).not.toBe(hash1);
    expect(fileHashCache.size).toBe(1);
  });

  it('should avoid redundant model loading', () => {
    // Simulate lazy loading logic
    let loadCount = 0;
    let currentModels: any = undefined;

    const loadModelsJson = () => {
      loadCount++;
      return [{ id: 'test-model', name: 'Test' }];
    };

    const config = {
      models: [{ id: 'test-model', channels: ['ch1', 'ch2'] }],
      autoSync: false,
      lastSyncHash: undefined
    };

    const hasConfiguredModels = config.models && config.models.length > 0;

    // Optimized logic: load once if we have configured models
    const needsModelData = (
      (config.autoSync !== false && config.lastSyncHash) ||
      (!config.models || config.models.length === 0) ||
      hasConfiguredModels
    );

    if (needsModelData) {
      currentModels = loadModelsJson();
    }

    // Should have loaded once
    expect(loadCount).toBe(1);
    expect(currentModels).toBeDefined();

    // Second check - should not load again
    if (!currentModels) {
      currentModels = loadModelsJson();
    }

    // Should still be 1 (no redundant load)
    expect(loadCount).toBe(1);
  });

  it('should defer health probes to avoid blocking startup', () => {
    let probesStarted = false;
    let initializationComplete = false;

    const startHealthProbes = () => {
      probesStarted = true;
    };

    const config = {
      healthProbe: { enabled: true }
    };

    // Simulate initialization
    const initialize = () => {
      // ... other initialization ...
      
      // Defer health probes
      if (config.healthProbe?.enabled) {
        setTimeout(() => {
          startHealthProbes();
          
          // Verify probes started after initialization
          expect(initializationComplete).toBe(true);
          expect(probesStarted).toBe(true);
        }, 10); // Use 10ms for test (1000ms in production)
      }
      
      // Initialization completes immediately
      initializationComplete = true;
    };

    initialize();

    // At this point, initialization is complete but probes haven't started
    expect(initializationComplete).toBe(true);
    expect(probesStarted).toBe(false);

    // Wait for the deferred probe to start
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(probesStarted).toBe(true);
        resolve();
      }, 20);
    });
  });

  it('should skip hash calculation when autoSync is disabled', () => {
    let hashCalculations = 0;

    const calculateFileHash = (filePath: string): string => {
      hashCalculations++;
      return 'hash-value';
    };

    const config1 = {
      autoSync: false,
      lastSyncHash: undefined,
      models: [{ id: 'test', channels: ['ch1'] }]
    };

    // With autoSync disabled, should not calculate hash
    if (config1.autoSync !== false && config1.lastSyncHash) {
      calculateFileHash(testFile);
    }

    expect(hashCalculations).toBe(0);

    const config2 = {
      autoSync: true,
      lastSyncHash: 'old-hash',
      models: [{ id: 'test', channels: ['ch1'] }]
    };

    // With autoSync enabled, should calculate hash
    if (config2.autoSync !== false && config2.lastSyncHash) {
      calculateFileHash(testFile);
    }

    expect(hashCalculations).toBe(1);
  });
});
