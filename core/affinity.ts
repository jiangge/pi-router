export type AffinityConfig = { mode?: 'legacy' | 'turn' | 'session' | 'cache-aware'; returnToPreferred?: boolean; minResidenceMs?: number; cacheTtlMs?: number };
export type AffinityRecord = { modelId: string; routeKey: string; channel: string; since: number; cacheUntil: number; turn: number };
/** One instance per session; branch navigation invalidates it. Never persisted across sessions. */
export class RouteAffinity {
  turn = 0;
  private records = new Map<string, AffinityRecord>();
  beginUserTurn() { this.turn++; }
  delete(key: string) { this.records.delete(key); }
  clear() { this.records.clear(); this.turn++; }
  success(key: string, modelId: string, routeKey: string, channel: string, config: AffinityConfig, now: number, cache: boolean) {
    const prior = this.records.get(key);
    this.records.set(key, {modelId,routeKey,channel,turn:this.turn,
      since: prior?.modelId === modelId && prior.routeKey === routeKey ? prior.since : now,
      cacheUntil: cache ? now + Math.max(0, config.cacheTtlMs ?? 300000) : 0 });
  }
  select(key: string, config: AffinityConfig, now: number): { record?: AffinityRecord; reason: string } {
    const record = this.records.get(key);
    if (!record) return { reason: 'no session affinity' };
    if (record.turn === this.turn) return { record, reason: 'keep successful route within user turn (including tools)' };
    const resident = now - record.since < Math.max(0,config.minResidenceMs ?? 0);
    if (resident) return {record,reason:'minimum residence prevents recovery oscillation'};
    if (config.returnToPreferred) return {reason:'new user turn: retry preferred order through normal health admission'};
    if (config.mode === 'turn') return {reason:'new user turn: previous turn pin expired'};
    if (config.mode === 'cache-aware' && record.cacheUntil <= now) return {reason:'cache value unknown/expired: restore preferred ordering'};
    return {record,reason:config.mode === 'cache-aware' ? 'keep route with explicit unexpired cache hint' : 'keep session route'};
  }
}
