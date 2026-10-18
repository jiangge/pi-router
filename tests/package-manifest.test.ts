import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
  files: string[];
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const packageLock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, unknown>;
};

const piPackages = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
];

describe('package manifest', () => {
  it('keeps Pi core packages host-provided and out of the local install tree', () => {
    for (const name of piPackages) {
      expect(packageJson.devDependencies?.[name]).toBeUndefined();
      expect(packageJson.peerDependencies?.[name]).toBe('>=0.84.4 <2.0.0');
      expect(packageJson.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(packageLock.packages[`node_modules/${name}`]).toBeUndefined();
    }
  });

  it('includes runtime logger files without shipping test-only declarations', () => {
    expect(packageJson.files).toContain('logger.ts');
    expect(packageJson.files).not.toContain('types');
    expect(packageJson.files).not.toContain('tests');
  });
});
