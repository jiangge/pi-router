export type FailoverBudgetConfig = { maxAttempts?: number; maxTotalWaitMs?: number; respectRetryAfter?: boolean };
/** Shared by the existing executor chain (primary/auto/custom/fallback), not a second retry loop. */
export class FailoverBudget {
  attempts = 0;
  readonly startedAt: number;
  constructor(readonly config: FailoverBudgetConfig, now = Date.now()) { this.startedAt = now; }
  remaining(now = Date.now()) { return this.config.maxTotalWaitMs === undefined ? Infinity : Math.max(0, this.config.maxTotalWaitMs - (now - this.startedAt)); }
  exhausted(now = Date.now()): string | undefined {
    if (this.config.maxAttempts !== undefined && this.attempts >= this.config.maxAttempts) return 'failover budget: maximum attempts reached';
    if (this.remaining(now) <= 0) return 'failover budget: total wait deadline reached';
    return undefined;
  }
  admit() { this.attempts++; }
}
