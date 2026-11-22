import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupBudget, validateGroups } from '../core/group-config.js';
import { __testLoadConfig, __testSaveConfig, __testSetPiConfigDir, __testResetInternalState, __testRefreshConfigFromDisk } from '../index.js';
const valid = () => ({ models: [{ id: 'vendor/full-model.v2', channels: ['p'] }], groups: [{ id: 'plan', members: ['router/vendor/full-model.v2'] }] });
afterEach(() => __testResetInternalState());
describe('exact group configuration', () => {
  it('allows absence, empty groups, slash ids and shared members', () => {
    validateGroups({}); validateGroups({ groups: [] });
    const c = valid(); c.groups.push({ id: 'review', members: c.groups[0].members }); validateGroups(c);
  });
  it('allows up to 1024 members per group and rejects more', () => {
    const models = Array.from({ length: 1025 }, (_, i) => ({ id: `vendor/m${i}`, channels: ['p'] }));
    const members = models.map(m => `router/${m.id}`);
    validateGroups({ models, groups: [{ id: 'all', members: members.slice(0, 1024) }] });
    expect(() => validateGroups({ models, groups: [{ id: 'all', members }] })).toThrow(/groups\[0\]\.members/);
  });
  it.each([
    ['wrong prefix', (c: any) => c.groups[0].members = ['rourter/vendor/full-model.v2']],
    ['provider member', (c: any) => c.groups[0].members = ['magpie/x']],
    ['missing exact name', (c: any) => c.groups[0].members = ['router/full-model']],
    ['auto member', (c: any) => c.groups[0].members = ['router/auto']],
    ['nested', (c: any) => c.groups[0].members = ['router/plan']],
    ['empty', (c: any) => c.groups[0].members = []],
    ['duplicate member', (c: any) => c.groups[0].members.push(c.groups[0].members[0])],
    ['reserved id', (c: any) => c.groups[0].id = 'auto'],
    ['name collision', (c: any) => c.models.push({id:'plan', channels:['p']})],
    ['duplicate model', (c: any) => c.models.push(c.models[0])],
    ['duplicate group', (c: any) => c.groups.push(c.groups[0])],
    ['legacy affinity', (c: any) => c.groups[0].affinity = {mode:'legacy'}],
    ['typo', (c: any) => c.groups[0].affinity = {mod:'session'}],
    ['invalid budget', (c: any) => c.groups[0].failoverBudget = {maxAttempts:1.5}],
    ['infinite budget', (c: any) => c.groups[0].failoverBudget = {maxTotalWaitMs:Infinity}],
    ['opaque leaf', (c: any) => c.models[0] = {id:c.models[0].id,channels:['magpie'],modelByChannel:{magpie:'group/auto-x'}}],
  ])('rejects %s', (_name, mutate) => { const c = valid(); mutate(c); expect(() => validateGroups(c)).toThrow(/groups|models/); });
  it('accepts optional per-member Pi thinking levels while preserving string members', () => {
    const c: any = valid();
    c.groups[0].members = [{ model: 'router/vendor/full-model.v2', thinking: 'xhigh' }];
    validateGroups(c);
    for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      c.groups[0].members[0].thinking = thinking;
      expect(() => validateGroups(c)).not.toThrow();
    }
    delete c.groups[0].members[0].thinking;
    expect(() => validateGroups(c)).not.toThrow();
    c.groups[0].members = ['router/vendor/full-model.v2'];
    expect(() => validateGroups(c)).not.toThrow();
  });
  it('rejects invalid member objects without relaxing exact identity or duplicate rules', () => {
    for (const member of [
      { model: 'router/vendor/full-model.v2', thinking: 'ultra' },
      { model: 'router/vendor/full-model.v2', thinking: 12 },
      { model: 'router/vendor/full-model.v2', unexpected: true },
      { model: 'vendor/full-model.v2', thinking: 'high' },
      { thinking: 'high' },
      null,
    ]) {
      const c: any = valid();
      c.groups[0].members = [member];
      expect(() => validateGroups(c)).toThrow(/groups\[0\]\.members/);
    }
    const c: any = valid();
    c.groups[0].members.push({ model: 'router/vendor/full-model.v2', thinking: 'low' });
    expect(() => validateGroups(c)).toThrow(/duplicate member/);
  });
  it('round-trips object members when saving a configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-thinking-config-')); __testSetPiConfigDir(dir);
    try {
      const c: any = valid();
      c.groups[0].members = [{ model: 'router/vendor/full-model.v2', thinking: 'max' }];
      __testSaveConfig(c);
      expect(JSON.parse(readFileSync(join(dir, 'pi-router.json'), 'utf8')).groups).toEqual(c.groups);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses bounded defaults and stricter global/local dimensions', () => {
    expect(groupBudget()).toMatchObject({maxAttempts:4,maxTotalWaitMs:120000});
    expect(groupBudget({maxAttempts:2,maxTotalWaitMs:90000},{maxAttempts:8,maxTotalWaitMs:50000})).toMatchObject({maxAttempts:2,maxTotalWaitMs:50000});
  });
  it('preserves groups on save and retains last good configuration on invalid reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'groups-config-')); __testSetPiConfigDir(dir);
    try {
      __testSaveConfig(valid() as any);
      expect(JSON.parse(readFileSync(join(dir,'pi-router.json'),'utf8')).groups).toEqual(valid().groups);
      const bad = valid(); bad.groups[0].members = ['router/auto'];
      writeFileSync(join(dir,'pi-router.json'),JSON.stringify(bad));
      expect(__testRefreshConfigFromDisk().groups).toEqual(valid().groups);
      __testResetInternalState(); __testSetPiConfigDir(dir);
      expect(__testLoadConfig()).toMatchObject({auto:false,models:[]});
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
