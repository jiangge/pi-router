import type { RouterRouteEntry } from '../router-routes.js';

/** Prices are route-specific, never inferred from provider names or zero catalog defaults. */
export type RouteMetadata = {
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number;
    currency: string; source: 'manual' | 'provider' | 'reference'; expiresAt?: number };
  free?: { kind: 'no-quota'; source: 'manual' | 'provider'; expiresAt?: number };
  quotaPoolRef?: string;
};
export type RoutingPolicy = { enabled?: boolean; objective?: 'legacy' | 'free' | 'cheap' | 'expiring' | 'smart-lite'; currency?: string };
export const metadataKey = (route: RouterRouteEntry) => `${route.modelId}@${route.routeKey}`;

/** Pure stable ordering, restricted to EXACT upstream identities. No implicit quality downgrade. */
export function orderEconomicRoutes(routes: RouterRouteEntry[], metadata: Record<string, RouteMetadata>,
  policy: RoutingPolicy, now: number): { routes: RouterRouteEntry[]; reason: string } {
  if (!policy.enabled || !policy.objective || policy.objective === 'legacy') return { routes, reason: 'policy disabled/legacy' };
  const groups = new Map<string, RouterRouteEntry[]>();
  for (const route of routes) {
    const group = groups.get(route.upstreamModelId) ?? [];
    group.push(route); groups.set(route.upstreamModelId, group);
  }
  const fresh = (expiry?: number) => expiry === undefined || (Number.isFinite(expiry) && expiry > now);
  let fallback = false;
  for (const [id, group] of groups) {
    const price = (r: RouterRouteEntry) => metadata[metadataKey(r)]?.price;
    if (policy.objective === 'cheap') {
      // Partial or incomparable data must not invent a price for unknown candidates.
      if (!group.every(r => {
        const p = price(r);
        return p && p.source !== 'reference' && p.currency === (policy.currency ?? 'USD') && fresh(p.expiresAt)
          && [p.input, p.output, p.cacheRead ?? 0, p.cacheWrite ?? 0].every(v => Number.isFinite(v) && v >= 0);
      })) { fallback = true; continue; }
      // Explicit estimate: 1000 uncached input + 500 output; not a bill prediction.
      groups.set(id, [...group].sort((a, b) => (price(a)!.input * 1000 + price(a)!.output * 500) - (price(b)!.input * 1000 + price(b)!.output * 500)));
    } else if (policy.objective === 'free') {
      const free = (r: RouterRouteEntry) => {
        const f = metadata[metadataKey(r)]?.free;
        return f?.kind === 'no-quota' && ['manual', 'provider'].includes(f.source) && fresh(f.expiresAt) ? 1 : 0;
      };
      groups.set(id, [...group].sort((a, b) => free(b) - free(a)));
    }
  }
  const offsets = new Map<string, number>();
  return { routes: routes.map(r => {
    const offset = offsets.get(r.upstreamModelId) ?? 0; offsets.set(r.upstreamModelId, offset + 1);
    return groups.get(r.upstreamModelId)![offset];
  }), reason: fallback ? 'legacy fallback: unknown/stale/reference price or currency mismatch' : `${policy.objective}: exact-upstream stable ordering; explicit route metadata` };
}

/** Hard request requirements are checked before economics AND again before admission. */
export function routeIncompatibility(model: any, context: any, options: any, estimatedTokens: number): string | undefined {
  const image = (context.messages ?? []).some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image'));
  if (image && !model.input?.includes('image')) return 'image input unsupported';
  if (context.tools?.length && model.compat?.supportsTools === false) return 'tools unsupported';
  if (options?.reasoning && options.reasoning !== 'off' && !model.reasoning) return 'reasoning unsupported';
  if (!model.contextWindow || estimatedTokens + (options?.maxTokens ?? 0) > model.contextWindow) return 'context capacity unknown/exceeded';
  return undefined;
}
