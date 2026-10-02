import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteFileSync } from '../core/atomic-file.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('atomic file writes', () => {
  it('replaces an existing file without leaving temporary files behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-atomic-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'pi-router.json');
    fs.writeFileSync(file, '{"old":true}', 'utf8');

    atomicWriteFileSync(file, '{"new":true}');

    expect(fs.readFileSync(file, 'utf8')).toBe('{"new":true}');
    expect(fs.readdirSync(dir)).toEqual(['pi-router.json']);
  });

  it('creates a new file atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-atomic-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'pi-router.json');

    atomicWriteFileSync(file, '{"created":true}');

    expect(fs.readFileSync(file, 'utf8')).toBe('{"created":true}');
    expect(fs.readdirSync(dir)).toEqual(['pi-router.json']);
  });
});
