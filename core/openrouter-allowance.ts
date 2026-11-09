import type { AllowanceAdapter, AllowanceSnapshot, AllowanceSource, AllowanceWindow } from './allowance.js';
/** GET /key is metadata-only; no completion or paid probe. Never sends keys to configurable URLs. */
export class OpenRouterAllowanceAdapter implements AllowanceAdapter {
  constructor(private key: () => Promise<string | undefined>, private request: typeof fetch = fetch) {}
  async read(source: AllowanceSource, signal: AbortSignal): Promise<AllowanceSnapshot | undefined> {
    const key = await this.key(); if (!key || signal.aborted) return undefined;
    const response = await this.request('https://openrouter.ai/api/v1/key', {
      signal, redirect:'error', headers:{Authorization:`Bearer ${key}`},
    });
    if (!response.ok) return undefined;
    const d = (await response.json() as any)?.data;
    if (!d) return undefined;
    const windows: AllowanceWindow[] = [];
    // Use enforced budget layers; do not derive account credit balance from usage.
    if (Array.isArray(d.budgets)) for (const b of d.budgets) {
      if (typeof b.limit_usd !== 'number' || b.limit_usd <= 0 || !Number.isFinite(b.limit_usd)
        || typeof b.remaining_usd !== 'number' || !Number.isFinite(b.remaining_usd) || b.remaining_usd > b.limit_usd) return undefined;
      const resetAt = b.resets_at ? Date.parse(b.resets_at) : undefined;
      if (resetAt !== undefined && !Number.isFinite(resetAt)) return undefined;
      windows.push({usedShare:Math.min(1,Math.max(0,1-b.remaining_usd/b.limit_usd)),unit:'USD',amount:b.limit_usd,resetAt});
    }
    if (!windows.length && typeof d.limit === 'number' && Number.isFinite(d.limit) && d.limit > 0
      && typeof d.limit_remaining === 'number' && Number.isFinite(d.limit_remaining) && d.limit_remaining <= d.limit) {
      windows.push({usedShare:Math.min(1,Math.max(0,1-d.limit_remaining/d.limit)),unit:'USD',amount:d.limit});
    }
    if (!windows.length) return undefined;
    return {providerId:source.providerId,accountRef:source.accountRef,quotaPoolId:source.quotaPoolId,
      modelScope:source.modelScope,windows,observedAt:Date.now(),source:'provider-api',confidence:'authoritative'};
  }
}
