export type FailureKind =
  | "transient-auth"
  | "network"
  | "timeout"
  | "rate-limit"
  | "auth"
  | "abort"
  | "provider"
  | "unknown";

export type FailureClassification = {
  kind: FailureKind;
  retryable: boolean;
};

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
