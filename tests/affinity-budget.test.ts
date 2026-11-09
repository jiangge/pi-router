import { describe, expect, it } from 'vitest';
import { RouteAffinity } from '../core/affinity.js';
import { FailoverBudget } from '../core/failover-budget.js';
describe('affinity v2', () => {
  it('pins tools within a user turn and releases only on a new user turn', () => {
    const a = new RouteAffinity();
    a.success('auto','m','b','b',{mode:'turn'},0,false);
    expect(a.select('auto',{mode:'turn',returnToPreferred:true},100).record?.routeKey).toBe('b');
    a.beginUserTurn();
    expect(a.select('auto',{mode:'turn'},100).record).toBeUndefined();
  });
  it('session retention, minimum residence, cache value and recovery are distinct', () => {
    const a = new RouteAffinity();
    a.success('m','m','b','b',{mode:'session',cacheTtlMs:1000},0,true); a.beginUserTurn();
    expect(a.select('m',{mode:'session'},100).record).toBeDefined();
    expect(a.select('m',{mode:'session',returnToPreferred:true,minResidenceMs:200},100).record).toBeDefined();
    expect(a.select('m',{mode:'session',returnToPreferred:true},300).record).toBeUndefined();
    expect(a.select('m',{mode:'cache-aware'},999).record).toBeDefined();
    expect(a.select('m',{mode:'cache-aware'},1000).record).toBeUndefined();
  });
  it('isolates sessions and invalidates branch state', () => {
    const a = new RouteAffinity(), b = new RouteAffinity();
    a.success('m','m','x','x',{},0,false);
    expect(b.select('m',{mode:'session'},1).record).toBeUndefined();
    a.clear(); expect(a.select('m',{mode:'session'},1).record).toBeUndefined();
  });
});
describe('shared bounded failover', () => {
  it('counts admissions rather than cooldown skips and bounds elapsed time', () => {
    const budget = new FailoverBudget({maxAttempts:2,maxTotalWaitMs:1000},100);
    expect(budget.exhausted(100)).toBeUndefined(); budget.admit(); budget.admit();
    expect(budget.exhausted(101)).toContain('attempts');
    const timed = new FailoverBudget({maxTotalWaitMs:1000},100);
    expect(timed.remaining(600)).toBe(500);
    expect(timed.exhausted(1100)).toContain('deadline');
  });
});
