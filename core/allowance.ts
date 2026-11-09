import type { RouterRouteEntry } from '../router-routes.js';
import { metadataKey, type RouteMetadata } from './routing-policy.js';

export type AllowanceWindow = {
  spanMs?: number; resetAt?: number; expiresAt?: number;
  usedShare: number; unit?: string; amount?: number; allowsPaidContinuation?: boolean;
};
/** Account/pool refs must be opaque non-secret IDs. No local token totals enter this contract. */
export type AllowanceSnapshot = {
  providerId: string; accountRef: string; quotaPoolId: string; modelScope: string[];
  windows: AllowanceWindow[]; observedAt: number;
  source: 'provider-api' | 'provider-response' | 'trusted-gateway' | 'manual';
  confidence: 'authoritative' | 'manual'; freePlan?: boolean;
};
export type AllowanceSource = { adapter: 'openrouter-key'; providerId: 'openrouter'; accountRef: string; quotaPoolId: string; modelScope: string[] };
export type AllowanceConfig = { enabled?: boolean; ttlMs?: number; timeoutMs?: number; backoffMs?: number; snapshots?: AllowanceSnapshot[]; sources?: AllowanceSource[] };
export interface AllowanceAdapter { read(source: AllowanceSource, signal: AbortSignal): Promise<AllowanceSnapshot | undefined> }

export function usableSnapshot(s: AllowanceSnapshot | undefined, provider: string, model: string, now: number, ttl: number): s is AllowanceSnapshot {
  return !!s && s.providerId === provider && !!s.accountRef && !!s.quotaPoolId
    && (s.confidence === 'authoritative' || s.confidence === 'manual')
    && ['provider-api','provider-response','trusted-gateway','manual'].includes(s.source)
    && Number.isFinite(s.observedAt) && s.observedAt <= now && now - s.observedAt < ttl
    && Array.isArray(s.modelScope) && (s.modelScope.includes('*') || s.modelScope.includes(model)) && Array.isArray(s.windows) && s.windows.length > 0
    && s.windows.every(w => Number.isFinite(w.usedShare) && w.usedShare >= 0 && w.usedShare <= 1
      && (w.resetAt === undefined || (Number.isFinite(w.resetAt) && w.resetAt > now))
      && (w.expiresAt === undefined || (Number.isFinite(w.expiresAt) && w.expiresAt > now))
      && (w.amount === undefined || (Number.isFinite(w.amount) && w.amount > 0)));
}

/** Cached read, coalesced refresh, bounded wait and backoff; callers never wait for refresh. */
export class AllowanceStore {
  readonly snapshots = new Map<string, AllowanceSnapshot>();
  private pending = new Map<string, Promise<void>>();
  private retryAt = new Map<string, number>();
  private controllers = new Set<AbortController>();
  private closed = false;
  static key(s: Pick<AllowanceSnapshot,'providerId'|'accountRef'|'quotaPoolId'>) { return `${s.providerId}\0${s.accountRef}\0${s.quotaPoolId}`; }
  close() { this.closed = true; for (const c of this.controllers) c.abort(); this.controllers.clear(); this.snapshots.clear(); }
  refresh(source: AllowanceSource, adapter: AllowanceAdapter, config: AllowanceConfig, now = Date.now()): Promise<void> {
    if (!config.enabled || this.closed) return Promise.resolve();
    const key = AllowanceStore.key(source);
    const cached = this.snapshots.get(key);
    if (cached && now - cached.observedAt < (config.ttlMs ?? 60000) && cached.observedAt <= now) return Promise.resolve();
    if (this.pending.has(key)) return this.pending.get(key)!;
    if ((this.retryAt.get(key) ?? 0) > now) return Promise.resolve();
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = Math.max(1,Math.min(10000,config.timeoutMs ?? 1500));
    let timer: ReturnType<typeof setTimeout>;
    const operation = Promise.race([
      Promise.resolve().then(() => adapter.read(source,controller.signal)),
      new Promise<never>((_,reject) => { timer = setTimeout(() => {controller.abort();reject(new Error('allowance refresh timeout'));},timeout); }),
    ]).then(snapshot => {
      if (!snapshot || snapshot.providerId !== source.providerId || snapshot.accountRef !== source.accountRef || snapshot.quotaPoolId !== source.quotaPoolId) throw new Error('allowance unavailable/identity mismatch');
      if (!this.closed) this.snapshots.set(key,snapshot);
    }).catch(() => { this.retryAt.set(key,Date.now() + Math.max(1000,config.backoffMs ?? 30000)); })
      .finally(() => { clearTimeout(timer); this.controllers.delete(controller); this.pending.delete(key); });
    this.pending.set(key,operation); return operation;
  }
  lookup(pool: string, provider: string): AllowanceSnapshot | undefined {
    const matches = [...this.snapshots.values()].filter(s => s.quotaPoolId === pool && s.providerId === provider);
    // Ambiguous account identity is unknown, not an arbitrary first account.
    return matches.length === 1 ? matches[0] : undefined;
  }
}

export function orderAllowanceRoutes(routes: RouterRouteEntry[], metadata: Record<string,RouteMetadata>, store: AllowanceStore,
  objective: 'expiring' | 'smart-lite', now: number, ttl = 60000): {routes: RouterRouteEntry[];reason:string} {
  const groups = new Map<string, RouterRouteEntry[]>();
  for (const r of routes) { const group = groups.get(r.upstreamModelId) ?? []; group.push(r); groups.set(r.upstreamModelId,group); }
  let fallback = false;
  for (const [id,group] of groups) {
    const snapshot = (r: RouterRouteEntry) => store.lookup(metadata[metadataKey(r)]?.quotaPoolRef, r.channel);
    if (!group.every(r => usableSnapshot(snapshot(r), r.channel,r.upstreamModelId,now,ttl))) {fallback=true;continue;}
    if (objective === 'expiring' && !group.every(r => {
      const s = snapshot(r)!;
      return typeof s.freePlan === 'boolean' && (!s.freePlan || s.windows.some(w => w.resetAt !== undefined || w.expiresAt !== undefined));
    })) {fallback=true;continue;}
    const tier = (s: AllowanceSnapshot) => s.windows.some(w => w.usedShare >= 1 && !w.allowsPaidContinuation) ? 2 : s.windows.some(w=>w.usedShare>=0.9 && !w.allowsPaidContinuation) ? 1 : 0;
    const used = (s: AllowanceSnapshot) => Math.max(...s.windows.map(w=>w.usedShare));
    const lapse = (s: AllowanceSnapshot) => Math.min(...s.windows.map(w=>Math.min(w.resetAt ?? Infinity,w.expiresAt ?? Infinity)));
    groups.set(id,[...group].sort((a,b)=> {
      const x=snapshot(a)!,y=snapshot(b)!;
      const t=tier(x)-tier(y); if(t) return t;
      if (objective === 'expiring') {
        const xf=Boolean(x.freePlan && Number.isFinite(lapse(x))), yf=Boolean(y.freePlan && Number.isFinite(lapse(y)));
        if (xf !== yf) return xf ? -1 : 1;
        if(xf && yf && lapse(x)!==lapse(y)) return lapse(x)-lapse(y);
      }
      return used(x)-used(y); // Conservative multi-window bottleneck; not magpie full Smart.
    }));
  }
  const offsets = new Map<string,number>();
  return { routes: routes.map(r=>{const i=offsets.get(r.upstreamModelId)??0; offsets.set(r.upstreamModelId,i+1);return groups.get(r.upstreamModelId)![i];}),
    reason:fallback?'legacy fallback: missing/stale/ambiguous/out-of-scope allowance snapshot':`${objective}: provider allowance snapshots, short-window exhaustion first; stable exact-model groups` };
}
