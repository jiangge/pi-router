export type FailureKind =
  | "transient-auth"
  | "network"
  | "timeout"
  | "rate-limit"
  | "quota-exhausted"
  | "credit-exhausted"
  | "auth"
  | "abort"
  | "provider"
  | "unknown";

export type FailureClassification = {
  kind: FailureKind;
  retryable: boolean;
  retryAt?: number;
  status?: number;
};

/** Only structured provider fields are accepted as reset hints; never infer balances from usage. */
export function structuredFailure(error: unknown, now = Date.now()): FailureClassification {
  const e = error as any;
  const base = classifyFailure(typeof error === 'string' ? error : e?.message ?? String(error));
  const status = Number(e?.status ?? e?.statusCode);
  const raw = e?.headers?.get?.('retry-after') ?? e?.headers?.['retry-after'];
  const seconds = typeof raw === 'string' && /^\\d+(?:\\.\\d+)?$/.test(raw) ? Number(raw) : undefined;
  const date = typeof raw === 'string' ? Date.parse(raw) : NaN;
  const retryAt = seconds !== undefined ? now + seconds * 1000 : date;
  const code = e?.code ?? e?.error?.code;
  return { ...base,
    ...(code === 'insufficient_quota' ? { kind: 'quota-exhausted' as const, retryable: false } : {}),
    ...(code === 'insufficient_credits' ? { kind: 'credit-exhausted' as const, retryable: false } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? {status} : {}),
    ...(Number.isFinite(retryAt) && retryAt > now ? {retryAt: Math.min(retryAt,now + 86400000)} : {}),
  };
}

export function classifyFailure(error: string): FailureClassification {
  const text = error || "";
  const lower = text.toLowerCase();
  const statusCode = text.match(/(?:^|\D)(401|403|408|409|429|500|502|503|504)(?:\D|$)/)?.[1];

  if (
    lower.includes("registry auth temporarily unavailable") ||
    lower.includes("auth resolution temporarily unavailable") ||
    lower.includes("credential store temporarily unavailable") ||
    lower.includes("authentication temporarily unavailable")
  ) {
    return { kind: "transient-auth", retryable: true };
  }

  if (
    lower.includes("aborterror") ||
    lower.includes("request was aborted") ||
    lower.includes("operation was aborted")
  ) {
    return { kind: "abort", retryable: false };
  }

  if (
    statusCode === "401" ||
    statusCode === "403" ||
    lower.includes("invalid token") ||
    lower.includes("invalid api key") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("no api key")
  ) {
    return { kind: "auth", retryable: false };
  }

  if (/insufficient_quota|quota exhausted|usage limit reached/i.test(text)) return {kind:'quota-exhausted',retryable:false};
  if (/insufficient_credits|credit balance.*(?:low|exhausted)|insufficient balance/i.test(text)) return {kind:'credit-exhausted',retryable:false};

  if (
    statusCode === "429" ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return { kind: "rate-limit", retryable: true };
  }

  if (
    statusCode === "408" ||
    lower.includes("etimedout") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return { kind: "timeout", retryable: true };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach") ||
    lower.includes("enetunreach") ||
    lower.includes("connection error") ||
    lower.includes("connection refused") ||
    lower.includes("dns lookup failed")
  ) {
    return { kind: "network", retryable: true };
  }

  if (statusCode && ["500", "502", "503", "504"].includes(statusCode)) {
    return { kind: "provider", retryable: true };
  }

  return { kind: "unknown", retryable: false };
}

export function getFailureCooldownMs(
  error: string,
  configuredCooldownMs: number,
): { cooldownMs: number; classification: FailureClassification } {
  const classification = classifyFailure(error);

  if (
    classification.kind === "transient-auth" ||
    classification.kind === "network" ||
    classification.kind === "timeout"
  ) {
    return { cooldownMs: 5000, classification };
  }

  return { cooldownMs: configuredCooldownMs, classification };
}
