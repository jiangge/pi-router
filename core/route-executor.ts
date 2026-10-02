import type {
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  isAbortError,
  isAbortSignalAborted,
  type RelayProviderStreamResult,
} from "./stream-relay.js";

export type RouteAttemptExecutionResult =
  | { status: "skipped"; reason: "cooldown" | "circuit" }
  | { status: "succeeded"; latencyMs: number }
  | { status: "failed"; error: string; aborted: boolean; committed: boolean };

export type RouteAttemptRoute<TModel> = {
  routeKey: string;
  routeLabel: string;
  model: TModel;
};

export type RouteAttemptDependencies<TModel, TModelConfig, TConfig> = {
  getCooldownEnd: (stateModelId: string, routeKey: string) => number | undefined;
  canAttempt: (stateModelId: string, routeKey: string) => boolean;
  forward: (
    model: TModel,
    context: Context,
    options: SimpleStreamOptions | undefined,
    config: TConfig,
    virtualModelId: string,
  ) => AssistantMessageEventStream;
  relay: (
    stream: AssistantMessageEventStream,
    outputStream: AssistantMessageEventStream,
    options: SimpleStreamOptions | undefined,
    config: TConfig,
    onCommit: () => void,
  ) => Promise<RelayProviderStreamResult>;
  recordLatency: (stateModelId: string, routeKey: string, latencyMs: number) => void;
  recordFailure: (stateModelId: string, routeKey: string, error: string, config: TConfig, modelConfig: TModelConfig) => void;
  updateHealth: (stateModelId: string, routeKey: string, healthy: boolean) => void;
  recordCircuit: (stateModelId: string, routeKey: string, success: boolean) => void;
  releaseCircuit: (stateModelId: string, routeKey: string) => void;
  debugLog?: (message: string) => void;
};

export type ExecuteRouteAttemptParams<TModel, TModelConfig, TConfig> = {
  stateModelId: string;
  route: RouteAttemptRoute<TModel>;
  modelConfig: TModelConfig;
  context: Context;
  options: SimpleStreamOptions | undefined;
  config: TConfig;
  outputStream: AssistantMessageEventStream;
  virtualModelId: string;
  onAdmitted?: () => void;
  onCommit?: (latencyMs: number) => void;
  onSuccess?: (latencyMs: number) => void;
};

export async function executeRouteAttempt<TModel, TModelConfig, TConfig>(
  params: ExecuteRouteAttemptParams<TModel, TModelConfig, TConfig>,
  deps: RouteAttemptDependencies<TModel, TModelConfig, TConfig>,
): Promise<RouteAttemptExecutionResult> {
  const {
    stateModelId,
    route,
    modelConfig,
    context,
    options,
    config,
    outputStream,
    virtualModelId,
    onAdmitted,
    onCommit,
    onSuccess,
  } = params;
  const routeKey = route.routeKey;
  const cooldownEnd = deps.getCooldownEnd(stateModelId, routeKey);
  if (cooldownEnd && Date.now() < cooldownEnd) {
    deps.debugLog?.(`Route ${route.routeLabel} in cooldown, skipping`);
    return { status: "skipped", reason: "cooldown" };
  }
  if (!deps.canAttempt(stateModelId, routeKey)) {
    deps.debugLog?.(`Circuit breaker open for ${route.routeLabel}, skipping`);
    return { status: "skipped", reason: "circuit" };
  }

  onAdmitted?.();

  let stream: AssistantMessageEventStream;
  try {
    stream = deps.forward(route.model, context, options, config, virtualModelId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const aborted = isAbortError(error) || isAbortSignalAborted(options);
    if (aborted) {
      deps.releaseCircuit(stateModelId, routeKey);
    } else {
      deps.recordFailure(stateModelId, routeKey, error, config, modelConfig);
      deps.updateHealth(stateModelId, routeKey, false);
      deps.recordCircuit(stateModelId, routeKey, false);
    }
    return { status: "failed", error, aborted, committed: false };
  }

  const streamStartTime = Date.now();
  let commitLatencyMs: number | undefined;
  const relayResult = await deps.relay(stream, outputStream, options, config, () => {
    commitLatencyMs = Date.now() - streamStartTime;
    deps.recordLatency(stateModelId, routeKey, commitLatencyMs);
    onCommit?.(commitLatencyMs);
  });

  if (relayResult.ok) {
    const latencyMs = commitLatencyMs ?? (Date.now() - streamStartTime);
    deps.updateHealth(stateModelId, routeKey, true);
    deps.recordCircuit(stateModelId, routeKey, true);
    onSuccess?.(latencyMs);
    return { status: "succeeded", latencyMs };
  }

  const { error, aborted, committed } = relayResult as Extract<RelayProviderStreamResult, { ok: false }>;
  if (aborted) {
    deps.releaseCircuit(stateModelId, routeKey);
  } else {
    deps.recordFailure(stateModelId, routeKey, error, config, modelConfig);
    deps.updateHealth(stateModelId, routeKey, false);
    deps.recordCircuit(stateModelId, routeKey, false);
  }
  return { status: "failed", error, aborted, committed };
}
