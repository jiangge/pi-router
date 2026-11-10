import type { AffinityConfig } from './affinity.js';
import type { FailoverBudgetConfig } from './failover-budget.js';
import { getModelRouteEntries } from '../router-routes.js';

export type RouterGroupConfig = {
  id: string;
  name?: string;
  members: string[];
  affinity?: Omit<AffinityConfig, 'mode'> & { mode?: 'turn' | 'session' | 'cache-aware' };
  failoverBudget?: FailoverBudgetConfig;
};

/** Exact canonical references only. No aliases, provider guessing or recursive groups. */
export function validateGroups(config: { models?: any[]; groups?: RouterGroupConfig[]; failoverBudget?: FailoverBudgetConfig }): void {
  if (config.groups === undefined || (Array.isArray(config.groups) && !config.groups.length)) return;
  const fail = (path: string, reason: string): never => { throw new Error(`${path}: ${reason}`); };
  const keys = (value: any, allowed: string[], path: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  };
  const budget = (value: any, path: string) => {
    if (value === undefined) return;
    keys(value, ['maxAttempts', 'maxTotalWaitMs', 'respectRetryAfter'], path);
    for (const key of ['maxAttempts', 'maxTotalWaitMs']) if (value[key] !== undefined &&
      (!Number.isFinite(value[key]) || value[key] <= 0 || (key === 'maxAttempts' && !Number.isInteger(value[key])))) fail(`${path}.${key}`, 'expected positive finite limit (attempts integer)');
    if (value.respectRetryAfter !== undefined && typeof value.respectRetryAfter !== 'boolean') fail(`${path}.respectRetryAfter`, 'expected boolean');
  };
  if (!Array.isArray(config.groups) || config.groups.length > 128) fail('groups', 'expected array with at most 128 groups');
  if (!Array.isArray(config.models)) fail('models', 'groups require explicit models');
  const models = new Map<string, any>();
  for (const [i, model] of config.models.entries()) {
    if (!model || typeof model.id !== 'string' || models.has(model.id)) fail(`models[${i}].id`, 'missing or duplicate canonical model id');
    models.set(model.id, model);
  }
  const ids = new Set<string>();
  config.groups.forEach((group, i) => {
    const p = `groups[${i}]`;
    keys(group, ['id', 'name', 'members', 'affinity', 'failoverBudget'], p);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(group.id) || group.id === 'auto' || models.has(group.id) || ids.has(group.id)) fail(`${p}.id`, 'invalid, reserved or conflicting router name');
    ids.add(group.id);
    if (group.name !== undefined && typeof group.name !== 'string') fail(`${p}.name`, 'expected string');
  });
  config.groups.forEach((group, i) => {
    const p = `groups[${i}]`;
    if (!Array.isArray(group.members) || !group.members.length || group.members.length > 256) fail(`${p}.members`, 'expected 1–256 exact router references');
    const seen = new Set<string>();
    group.members.forEach((member, j) => {
      const path = `${p}.members[${j}]`;
      if (typeof member !== 'string' || !member.startsWith('router/')) fail(path, 'expected router/<exact configured model id>');
      const id = member.slice(7);
      if (id === 'auto' || ids.has(id)) fail(path, 'auto and nested groups are forbidden');
      const model = models.get(id);
      if (!model) fail(path, `no exact models[].id match for ${member}`);
      if (seen.has(id)) fail(path, 'duplicate member');
      seen.add(id);
      for (const route of getModelRouteEntries(model)) {
        if (route.channel === 'magpie' && /^(group|auto)\//.test(route.upstreamModelId)) fail(path, `opaque magpie dynamic leaf unsupported: ${route.upstreamModelId}`);
      }
    });
    if (group.affinity !== undefined) {
      const a = group.affinity;
      keys(a, ['mode', 'returnToPreferred', 'minResidenceMs', 'cacheTtlMs'], `${p}.affinity`);
      if (a.mode !== undefined && !['turn', 'session', 'cache-aware'].includes(a.mode)) fail(`${p}.affinity.mode`, 'expected turn/session/cache-aware');
      if (a.returnToPreferred !== undefined && typeof a.returnToPreferred !== 'boolean') fail(`${p}.affinity.returnToPreferred`, 'expected boolean');
      for (const key of ['minResidenceMs', 'cacheTtlMs']) if (a[key] !== undefined && (!Number.isFinite(a[key]) || a[key] < 0)) fail(`${p}.affinity.${key}`, 'expected nonnegative finite duration');
    }
    budget(group.failoverBudget, `${p}.failoverBudget`);
  });
  budget(config.failoverBudget, 'failoverBudget');
}

export function groupBudget(global?: FailoverBudgetConfig, local?: FailoverBudgetConfig): FailoverBudgetConfig {
  return {
    maxAttempts: Math.min(global?.maxAttempts ?? Infinity, local?.maxAttempts ?? 4),
    maxTotalWaitMs: Math.min(global?.maxTotalWaitMs ?? Infinity, local?.maxTotalWaitMs ?? 120000),
    respectRetryAfter: global?.respectRetryAfter || local?.respectRetryAfter || false,
  };
}
