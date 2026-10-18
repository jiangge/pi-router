/**
 * Keep every test file away from the developer's real Pi agent directory.
 *
 * Pi resolves `auth.json`, `models.json`, and lock files from
 * `PI_CODING_AGENT_DIR`. Without this isolation, a local run can read real
 * credentials or fail while trying to lock a read-only `~/.pi/agent`, so the
 * same test passes in CI and fails on a developer machine (or vice versa).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-pi-agent-'));

process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

afterAll(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
});
