export type CircuitState = "closed" | "open" | "half-open";

export type CircuitBreakerStatus = {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  nextRetryTime: number;
  /** Ensures half-open recovery admits exactly one live probe request. */
  halfOpenInFlight?: boolean;
};

export type CircuitBreaker = {
  circuits: Map<string, CircuitBreakerStatus>;
  failureThreshold: number;
  resetTimeoutMs: number;
  enabled: boolean;
};

type CircuitDebugLog = (message: string) => void;

export function canAttemptCircuit(
  breaker: CircuitBreaker,
  key: string,
  debugLog?: CircuitDebugLog,
): boolean {
  if (!breaker.enabled) return true;

  const status = breaker.circuits.get(key);
  if (!status) return true;

  if (status.state === "closed") return true;

  const now = Date.now();
  if (status.state === "open") {
    if (now >= status.nextRetryTime) {
      status.state = "half-open";
      status.halfOpenInFlight = true;
      debugLog?.(`Circuit half-open for ${key}, allowing test request`);
      return true;
    }
    debugLog?.(`Circuit open for ${key}, blocking request`);
    return false;
  }

  if (status.halfOpenInFlight) {
    debugLog?.(`Circuit half-open probe already in flight for ${key}, blocking request`);
    return false;
  }

  status.halfOpenInFlight = true;
  debugLog?.(`Circuit half-open for ${key}, acquiring test request slot`);
  return true;
}

export function recordCircuitResult(
  breaker: CircuitBreaker,
  key: string,
  success: boolean,
  debugLog?: CircuitDebugLog,
): void {
  if (!breaker.enabled) return;

  let status = breaker.circuits.get(key);
  if (!status) {
    status = {
      state: "closed",
      failureCount: 0,
      lastFailureTime: 0,
      nextRetryTime: 0,
      halfOpenInFlight: false,
    };
    breaker.circuits.set(key, status);
  }

  if (success) {
    if (status.state === "half-open") {
      debugLog?.(`Circuit closed for ${key} after successful test`);
    }
    status.state = "closed";
    status.failureCount = 0;
    status.halfOpenInFlight = false;
    return;
  }

  status.failureCount++;
  status.lastFailureTime = Date.now();

  if (status.state === "half-open") {
    status.state = "open";
    status.halfOpenInFlight = false;
    status.nextRetryTime = Date.now() + breaker.resetTimeoutMs;
    debugLog?.(`Circuit reopened for ${key}, retry in ${breaker.resetTimeoutMs / 1000}s`);
    return;
  }

  if (status.failureCount >= breaker.failureThreshold) {
    status.state = "open";
    status.halfOpenInFlight = false;
    status.nextRetryTime = Date.now() + breaker.resetTimeoutMs;
    debugLog?.(`Circuit opened for ${key} after ${status.failureCount} failures`);
  }
}

export function releaseCircuitProbe(
  breaker: CircuitBreaker,
  key: string,
  debugLog?: CircuitDebugLog,
): void {
  const status = breaker.circuits.get(key);
  if (!status || status.state !== "half-open" || !status.halfOpenInFlight) return;

  status.halfOpenInFlight = false;
  status.state = "open";
  status.nextRetryTime = Date.now();
  debugLog?.(`Released half-open probe slot for ${key} without recording an outcome`);
}
