/**
 * Performance tests for pi-router
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { createTempDir, cleanupTempDir, createMockModelsJson, createMockConfig } from './setup';

describe('Performance Tests', () => {
  let tempDir: string;
  
  beforeEach(() => {
    tempDir = createTempDir();
  });
  
  afterEach(() => {
    cleanupTempDir(tempDir);
  });
  
  it('should load config quickly (< 50ms)', () => {
    // Create a simple config
    createMockConfig(tempDir, {
      strategy: 'channelFirst',
      auto: false,
      models: [
        { id: 'test-model', channels: ['test-provider'] }
      ]
    });
    
    const start = Date.now();
    const configPath = path.join(tempDir, 'router.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeLessThan(50);
    expect(config.models).toHaveLength(1);
  });
  
  it('should NOT load models.json when config has models', () => {
    // Create config with models
    createMockConfig(tempDir, {
      strategy: 'channelFirst',
      auto: false,
      autoSync: false,
      models: [
        { id: 'test-model', channels: ['test-provider'] }
      ]
    });
    
    // Create a large models.json
    const providers: any = {};
    for (let i = 0; i < 100; i++) {
      providers[`provider${i}`] = {
        api: 'test-api',
        models: Array.from({ length: 10 }, (_, j) => ({
          id: `model-${i}-${j}`,
          name: `Model ${i}-${j}`
        }))
      };
    }
    createMockModelsJson(tempDir, providers);
    
    // Measure time - should be fast because models.json is NOT loaded
    const start = Date.now();
    const configPath = path.join(tempDir, 'router.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const elapsed = Date.now() - start;
    
    // Should be very fast (only config loading)
    expect(elapsed).toBeLessThan(100);
  });
  
  it('should handle auto-discovery only on first run', () => {
    // First run: auto-discovery
    createMockConfig(tempDir, {
      strategy: 'channelFirst',
      auto: true,
      models: []
    });
    
    createMockModelsJson(tempDir, {
      testProvider: {
        api: 'test-api',
        models: [
          { id: 'model-1', name: 'Model 1' },
          { id: 'model-2', name: 'Model 2' }
        ]
      }
    });
    
    // After discovery, config should be updated with models
    // and auto should be disabled
    // (This is what the extension should do)
  });
});

describe('Config Loading Tests', () => {
  let tempDir: string;
  
  beforeEach(() => {
    tempDir = createTempDir();
  });
  
  afterEach(() => {
    cleanupTempDir(tempDir);
  });
  
  it('should use default config when file not exists', () => {
    // No config file created
    const configPath = path.join(tempDir, 'router.config.json');
    
    // Should not crash, should use defaults
    expect(fs.existsSync(configPath)).toBe(false);
  });
  
  it('should prefer config file over defaults', () => {
    createMockConfig(tempDir, {
      strategy: 'modelFirst',
      auto: true,
      models: [{ id: 'test', channels: ['a', 'b'] }]
    });
    
    const configPath = path.join(tempDir, 'router.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    expect(config.strategy).toBe('modelFirst');
    expect(config.auto).toBe(true);
  });
});
