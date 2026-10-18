#!/usr/bin/env node
/**
 * Type-check pi-router against the Pi packages installed on the host.
 *
 * The published package treats `@earendil-works/pi-*` as host-provided optional
 * peers, so a plain `tsc --noEmit` cannot resolve them and silently checks the
 * extension against `any`. This script points TypeScript at the installed Pi
 * declarations and runs the normal project type check.
 *
 * The Pi package root is taken from `PI_ROUTER_TEST_PI_ROOT` when set, then
 * discovered from the `pi` executable the same way `vitest.config.ts` does.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI_PACKAGE = '@earendil-works/pi-coding-agent';

function readManifest(dir) {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function findPackageRoot(startPath) {
  let current = path.dirname(startPath);
  while (true) {
    const manifest = readManifest(current);
    if (manifest?.name === PI_PACKAGE) return realpathSync(current);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolvePiRoot() {
  const configured = process.env.PI_ROUTER_TEST_PI_ROOT;
  if (configured) {
    const resolved = realpathSync(configured);
    if (readManifest(resolved)?.name === PI_PACKAGE) return resolved;
    throw new Error(
      `PI_ROUTER_TEST_PI_ROOT does not point at ${PI_PACKAGE}: ${configured}`,
    );
  }

  const binLines = (process.platform === 'win32'
    ? commandOutput('where', ['pi'])
    : commandOutput('which', ['pi']))?.split(/\r?\n/) ?? [];
  for (const line of binLines) {
    const candidate = line.trim();
    if (!candidate || !existsSync(candidate)) continue;
    const packageRoot = findPackageRoot(realpathSync(candidate));
    if (packageRoot) return packageRoot;
  }

  const voltaPiBin = commandOutput('volta', ['which', 'pi']);
  if (voltaPiBin) {
    const packageRoot = findPackageRoot(realpathSync(voltaPiBin));
    if (packageRoot) return packageRoot;
  }

  throw new Error(
    'Unable to locate the system Pi package. Set PI_ROUTER_TEST_PI_ROOT to the '
    + 'installed @earendil-works/pi-coding-agent package root.',
  );
}

function resolveDependency(piRoot, packageName) {
  let current = piRoot;
  while (true) {
    for (const candidate of [
      path.join(current, 'node_modules', packageName),
      path.join(current, packageName),
    ]) {
      if (readManifest(candidate)?.name === packageName) return realpathSync(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to locate ${packageName} from the Pi package root: ${piRoot}`);
}

const piRoot = resolvePiRoot();
const piAiRoot = resolveDependency(piRoot, '@earendil-works/pi-ai');
const piTuiRoot = resolveDependency(piRoot, '@earendil-works/pi-tui');
const piVersion = readManifest(piRoot)?.version ?? 'unknown';

console.log(`[typecheck:pi] Using Pi ${piVersion} from ${piRoot}`);

const tempDir = mkdtempSync(path.join(tmpdir(), 'pi-router-typecheck-'));
try {
  const configPath = path.join(tempDir, 'tsconfig.json');
  writeFileSync(configPath, JSON.stringify({
    extends: path.join(rootDir, 'tsconfig.json'),
    compilerOptions: {
      baseUrl: rootDir,
      paths: {
        '@earendil-works/pi-coding-agent': [path.join(piRoot, 'dist', 'index.d.ts')],
        '@earendil-works/pi-ai': [path.join(piAiRoot, 'dist', 'index.d.ts')],
        '@earendil-works/pi-ai/compat': [path.join(piAiRoot, 'dist', 'compat.d.ts')],
        '@earendil-works/pi-ai/providers/all': [path.join(piAiRoot, 'dist', 'providers', 'all.d.ts')],
        '@earendil-works/pi-tui': [path.join(piTuiRoot, 'dist', 'index.d.ts')],
      },
    },
  }, null, 2));

  const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tscPath, '-p', configPath, '--noEmit'], { stdio: 'inherit' });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
