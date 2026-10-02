import { describe, expect, it } from 'vitest';
import { classifyFailure, getFailureCooldownMs } from '../core/failure-classifier.js';

describe('failure classifier', () => {
  it('does not mistake arbitrary words containing "connect" for network failures', () => {
    expect(classifyFailure('The connector returned an invalid request')).toEqual({
      kind: 'unknown',
      retryable: false,
    });
  });

  it('classifies concrete retryable transport failures', () => {
    expect(classifyFailure('ECONNREFUSED 127.0.0.1')).toEqual({ kind: 'network', retryable: true });
    expect(classifyFailure('Request timed out after 120000ms')).toEqual({ kind: 'timeout', retryable: true });
    expect(classifyFailure('429 rate limit exceeded')).toEqual({ kind: 'rate-limit', retryable: true });
  });

  it('keeps permanent auth failures on the configured cooldown', () => {
    const result = getFailureCooldownMs('401 invalid api key', 60_000);
    expect(result.classification.kind).toBe('auth');
    expect(result.cooldownMs).toBe(60_000);
  });

  it('uses a short cooldown for transient auth resolution and transport failures', () => {
    expect(getFailureCooldownMs('Registry auth temporarily unavailable', 60_000).cooldownMs).toBe(5_000);
    expect(getFailureCooldownMs('ENOTFOUND upstream.example', 60_000).cooldownMs).toBe(5_000);
    expect(getFailureCooldownMs('ETIMEDOUT', 60_000).cooldownMs).toBe(5_000);
  });
});
