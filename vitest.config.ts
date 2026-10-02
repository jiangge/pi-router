import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function commandOutput(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function findPackageRoot(startPath: string, packageName: string): string | undefined {
  let current = path.dirname(startPath);
  while (current !== path.dirname(current)) {
    const packageJson = path.join(current, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
        if (manifest.name === packageName) return current;
      } catch {
        // Continue searching parent directories.
      }
    }
    current = path.dirname(current);
  }
  return undefined;
}

function resolvePiPackageRoot(): string {
  const configured = process.env.PI_ROUTER_TEST_PI_ROOT;
  if (configured) {
    const packageJson = path.join(configured, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
        if (manifest.name === '@earendil-works/pi-coding-agent') return realpathSync(configured);
      } catch {
        // Fall back to executable discovery below.
      }
    }
  }

  const piBinLines = (process.platform === 'win32'
    ? commandOutput('where', ['pi'])
    : commandOutput('which', ['pi']))?.split(/\r?\n/) ?? [];
  let packageRoot: string | undefined;
  for (const line of piBinLines) {
    const candidate = line.trim();
    if (!candidate || !existsSync(candidate)) continue;
    packageRoot = findPackageRoot(realpathSync(candidate), '@earendil-works/pi-coding-agent');
    if (packageRoot) break;
  }
  if (packageRoot) return packageRoot;

  const voltaPiBin = commandOutput('volta', ['which', 'pi']);
  const voltaPackageRoot = voltaPiBin
    ? findPackageRoot(realpathSync(voltaPiBin), '@earendil-works/pi-coding-agent')
    : undefined;
  if (voltaPackageRoot) return voltaPackageRoot;

  throw new Error(
    'Unable to locate the system Pi package. Set PI_ROUTER_TEST_PI_ROOT to the '
    + 'installed @earendil-works/pi-coding-agent package root before running tests.',
  );
}

const piRoot = resolvePiPackageRoot();

function resolvePiDependencyRoot(packageName: string): string {
  let current = piRoot;
  while (true) {
    for (const candidate of [
      path.join(current, 'node_modules', packageName),
      path.join(current, packageName),
    ]) {
      const packageJson = path.join(candidate, 'package.json');
      if (!existsSync(packageJson)) continue;
      try {
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
        if (manifest.name === packageName) return realpathSync(candidate);
      } catch {
        // Continue searching parent installation roots.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to locate ${packageName} from Pi package root: ${piRoot}`);
}

const piAiRoot = resolvePiDependencyRoot('@earendil-works/pi-ai');
const piTuiRoot = resolvePiDependencyRoot('@earendil-works/pi-tui');

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@earendil-works\/pi-coding-agent$/,
        replacement: path.join(piRoot, 'dist', 'index.js'),
      },
      {
        find: /^@earendil-works\/pi-coding-agent\/(.*)$/,
        replacement: `${piRoot}/$1`,
      },
      {
        find: '@earendil-works/pi-ai/compat',
        replacement: path.join(piAiRoot, 'dist', 'compat.js'),
      },
      {
        find: '@earendil-works/pi-ai/providers/all',
        replacement: path.join(piAiRoot, 'dist', 'providers', 'all.js'),
      },
      {
        find: '@earendil-works/pi-ai',
        replacement: path.join(piAiRoot, 'dist', 'index.js'),
      },
      {
        find: '@earendil-works/pi-tui',
        replacement: path.join(piTuiRoot, 'dist', 'index.js'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData.ts'
      ]
    }
  }
});
