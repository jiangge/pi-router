/**
 * Test setup and utilities
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function createTempDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-test-'));
  return tmpDir;
}

export function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function createMockModelsJson(dir: string, providers: any): void {
  const modelsPath = path.join(dir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2));
}

export function createMockConfig(dir: string, config: any): void {
  const configPath = path.join(dir, 'router.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
