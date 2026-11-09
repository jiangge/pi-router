import { describe, expect, it, vi } from 'vitest';
import { OpenRouterAllowanceAdapter } from '../core/openrouter-allowance.js';
import { AllowanceStore, orderAllowanceRoutes, usableSnapshot, type AllowanceSnapshot } from '../core/allowance.js';
const snap = (usedShare:number, observedAt=0): AllowanceSnapshot => ({providerId:'openrouter',accountRef:'acct',quotaPoolId:'pool',modelScope:['model'],observedAt,source:'provider-api',confidence:'authoritative',windows:[{usedShare,resetAt:10000}]});
describe('provider allowance snapshots', () => {
  it('rejects stale, ambiguous, malformed and local-only data', () => {
    expect(usableSnapshot(snap(.1), 'openrouter','model',100,50)).toBe(false);
    expect(usableSnapshot(snap(.1), 'openrouter','model',10,50)).toBe(true);
    expect(usableSnapshot({...snap(.1),windows:[{usedShare:2}]},'openrouter','model',10,50)).toBe(false);
  });
  it('does not choose an account when identity is ambiguous', () => {
    const s = new AllowanceStore(); s.snapshots.set('a',snap(.1)); s.snapshots.set('b',{...snap(.2),accountRef:'other'});
    expect(s.lookup('pool','openrouter')).toBeUndefined();
  });
  it('orders expiring exact-model routes and falls back when one snapshot is absent', () => {
    const s = new AllowanceStore(); s.snapshots.set('a',snap(.95));
    const routes:any[]=[{modelId:'model',upstreamModelId:'model',routeKey:'openrouter',channel:'openrouter'},{modelId:'model',upstreamModelId:'model',routeKey:'other',channel:'other'}];
    const m:any={'model@openrouter':{quotaPoolRef:'pool'},'model@other':{quotaPoolRef:'missing'}};
    expect(orderAllowanceRoutes(routes,m,s,'smart-lite',10).reason).toContain('fallback');
    s.snapshots.set('b',{...snap(.1),providerId:'other',quotaPoolId:'missing'});
    expect(orderAllowanceRoutes(routes,m,s,'smart-lite',10).routes[0].channel).toBe('other');
    s.snapshots.get('a')!.freePlan = true;
    s.snapshots.get('b')!.freePlan = false;
    s.snapshots.get('a')!.windows[0].usedShare = .2;
    expect(orderAllowanceRoutes(routes,m,s,'expiring',10).routes[0].channel).toBe('openrouter');
    s.snapshots.get('a')!.windows.push({usedShare:1,resetAt:500});
    expect(orderAllowanceRoutes(routes,m,s,'expiring',10).routes[0].channel).toBe('other');
    expect(orderAllowanceRoutes(routes,m,s,'smart-lite',20000).routes).toEqual(routes);
  });
  it('coalesces concurrent refresh, caches and backs off without generating completions', async () => {
    const store = new AllowanceStore();
    const source:any={adapter:'openrouter-key',providerId:'openrouter',accountRef:'acct',quotaPoolId:'pool',modelScope:['model']};
    const read=vi.fn(async()=>snap(.1,Date.now()));
    await Promise.all([store.refresh(source,{read},{enabled:true}),store.refresh(source,{read},{enabled:true})]);
    expect(read).toHaveBeenCalledTimes(1);
    await store.refresh(source,{read},{enabled:true}); expect(read).toHaveBeenCalledTimes(1);
    store.close(); await store.refresh(source,{read},{enabled:true}); expect(read).toHaveBeenCalledTimes(1);
    const failed = new AllowanceStore(), fail=vi.fn(async()=>undefined);
    await failed.refresh(source,{read:fail},{enabled:true});
    await failed.refresh(source,{read:fail},{enabled:true}); expect(fail).toHaveBeenCalledTimes(1);
  });
  it('maps only actual provider budget fields; unlimited/usage-only data remain unknown', async () => {
    const source:any={providerId:'openrouter',accountRef:'acct',quotaPoolId:'pool',modelScope:['model']};
    const request=vi.fn(async()=>({ok:true,json:async()=>({data:{budgets:[{limit_usd:100,remaining_usd:25,resets_at:null}]}})}));
    const adapter=new OpenRouterAllowanceAdapter(async()=>'fake-test-key',request as any);
    const result=await adapter.read(source,new AbortController().signal);
    expect(result?.windows[0].usedShare).toBe(.75);
    expect(request.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/key');
    const unknown=new OpenRouterAllowanceAdapter(async()=>'fake',vi.fn(async()=>({ok:true,json:async()=>({data:{usage:99,limit:null}})})) as any);
    expect(await unknown.read(source,new AbortController().signal)).toBeUndefined();
  });
});
