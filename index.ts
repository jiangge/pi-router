/**
 * pi-router v0.4.0
 * Intelligent routing layer for pi coding agent
 *
 * Routes channels (same model, different providers) with optional fallback models.
 * Real model identity end-to-end — zero protocol coupling with pi-cache-optimizer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { getModels as getBuiltinPiAiModels, streamSimple, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model, Api, Context, SimpleStreamOptions, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { runConfigOrderWizard, runConfigWizard } from "./config-wizard-flow.js";
import {
  getModelRouteEntries,
  getRouteDisplayLabel,
  getRouteSignature,
  makeRouteKey,
  serializeRouteEntriesForConfig,
  type RouterCustomRouteConfig,
  type RouterRouteConfig,
  type RouterRouteEntry,
} from "./router-routes.js";

const PI_ROUTER_DEBUG = process.env.PI_ROUTER_DEBUG === "1";
const ROUTER_API = "pi-router" as Api;
const ROUTER_DUMMY_API_KEY = "router";
const DEFAULT_ROUTER_TIMEOUT_MS = Number(process.env.PI_ROUTER_TIMEOUT_MS || 120000);
const DEFAULT_ROUTER_MAX_TOKENS = Number(process.env.PI_ROUTER_MAX_TOKENS || 32768);
const PI_ROUTING_REGISTRY = Symbol.for("pi.routing.registry.v1");
const PI_CACHE_HINTS = Symbol.for("pi.cache.hints.v1");

function debugLog(...args: unknown[]): void {
  if (PI_ROUTER_DEBUG) {
    console.log(...args);
  }
}

type PiModel = {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  input?: string[];
};

type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute: (
    virtualModelId: string,
    hint?: { sessionIdHash?: string; requestId?: string }
  ) => PiRouteSnapshot | undefined;
  resolveCandidateRoutes?: (virtualModelId: string) => PiRouteSnapshot[];
  subscribe?: (listener: (event: PiRouteSnapshot) => void) => () => void;
};

type PiRoutingRegistryV1 = {
  version: 1;
  registerRouter: (adapter: PiRouterAdapterV1) => () => void;
  getRouter: (virtualProvider: string) => PiRouterAdapterV1 | undefined;
};

type PiCacheHintsV1 = {
  version: 1;
  getHints: (input: {
    sessionIdHash?: string;
    // Transitional alias used by early integrations; new code should prefer sessionIdHash.
    sessionId?: string;
    virtualProvider?: string;
    virtualModelId?: string;
    upstreamProvider?: string;
    upstreamModelId?: string;
    api?: string;
  }) => {
    systemPrompt?: string;
    promptCacheKey?: string;
    cacheRetention?: "long";
  } | undefined;
};

type RouterConfig = {
  strategy?: "channelFirst" | "custom";
  auto?: boolean;
  sortBy?: "manual" | "capabilityFirst" | "costFirst" | "latency" | "cost";
  request?: {
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs?: number;
    maxTokens?: number;
  };
  models?: RouterModelConfig[];
  /**
   * Legacy/global alias map kept for migration compatibility. Prefer per-model
   * `models[].aliases` so each canonical router model owns its upstream IDs.
   */
  modelAliases?: Record<string, string[]>;
  customOrder?: string[];  // For custom strategy: array of "modelId@channel" strings
  customRoutes?: RouterCustomRouteConfig[];  // For duplicate provider/model-variant routes in custom strategy
  failover?: {
    on?: string[];
    cooldownMs?: number;
  };
  sticky?: boolean;
  stickyRecords?: Record<string, StickyRecord>;  // Persistent sticky state per model
  intent?: "suggest" | "auto" | "off";
  logDir?: string | null;
  autoSync?: boolean;  // Auto-detect models.json changes and prompt user
  lastSyncHash?: string;  // Hash of models.json at last sync
  contextTransfer?: "none" | "summary" | "full";  // Context transfer strategy on model switch
  summaryModel?: string;  // Optional dedicated summary model id or id@provider; default uses target model
  summaryPrompt?: string;  // Optional custom summary prompt template
  summaryMaxTokens?: number;  // Target upper bound for AI summary size; default 2000
  healthProbe?: {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    probeMessage?: string;
  };
  footer?: {
    /**
     * Default true. When the replacement footer is disabled, keep route status
     * on pi's built-in extension status line. Set false to suppress that
     * fallback status item.
     */
    statusLine?: boolean;
    /**
     * Default true. pi-router replaces pi's built-in footer while router
     * status is active so the route can be right-aligned with other extension
     * statuses. Set false to keep pi's built-in footer layout.
     */
    rightAlignRoute?: boolean;
  };
};

type StickyRecord = {
  modelId: string;  // Actual routed model ID
  channel: string;  // Actual routed channel
  /** Distinguishes same-provider routes with different upstream model names. */
  routeKey?: string;
  /** Exact upstream model id for this route when it differs from modelId. */
  upstreamModelId?: string;
  successCount: number;  // Consecutive success count
  lastSuccess: number;  // Timestamp of last success
  lastUpdate: number;  // Timestamp of last update
};

type RouterModelConfig = {
  id: string;
  channels: string[];
  /** Optional route list; needed when the same provider appears with multiple upstream model IDs. */
  routes?: RouterRouteConfig[];
  sortBy?: "config" | "latency" | "cost";
  failover?: {
    on?: string[];
    cooldownMs?: number;
  };
  fallbackModels?: Array<{
    id: string;
    channels: string[];
    /** Optional route list for duplicate provider/model-variant fallback routes. */
    routes?: RouterRouteConfig[];
    /** Upstream model IDs considered equivalent to this fallback id. */
    aliases?: string[];
    /** Per-channel upstream model id when it differs from the canonical id. */
    modelByChannel?: Record<string, string>;
  }>;
  /** Upstream model IDs considered equivalent to this canonical router id. */
  aliases?: string[];
  /** Per-channel upstream model id when it differs from the canonical id. */
  modelByChannel?: Record<string, string>;
  fallbackMode?: "switch" | "inline";
  sticky?: boolean;
  contextTransfer?: "none" | "summary" | "full";  // Override global setting per model
};

/**
 * Context transfer strategies
 */
type ContextTransferStrategy = "none" | "summary" | "full";

/**
 * Default summary prompt template
 */
const DEFAULT_SUMMARY_PROMPT = `You are switching from one AI model to another mid-conversation. Please provide a concise but useful summary of the conversation so far, focusing on:

1. User's main goal/task
2. Key decisions made
3. Current progress/status
4. Important context the next model needs

Format the result as a natural continuation prompt.`;

/**
 * Summary generation result
 */
type SummaryResult = {
  success: boolean;
  summary?: string;
  error?: string;
  tokensUsed?: number;
};

/**
 * Built-in capability scores (0-100)
 * Used for capabilityFirst sorting in custom strategy
 */
const CAPABILITY_SCORES: Record<string, number> = {
  // Claude family
  "claude-opus-4-8": 95,
  "claude-sonnet-4-6": 85,
  "claude-haiku-4-5": 75,
  "claude-sonnet-3-5": 82,
  "claude-opus-3": 88,
  
  // OpenAI GPT family
  "gpt-5.5": 98,
  "gpt-5": 96,
  "gpt-4o": 90,
  "gpt-4-turbo": 88,
  "gpt-4": 85,
  "gpt-3.5-turbo": 70,
  
  // Google Gemini family
  "gemini-3-pro": 90,
  "gemini-2-flash": 82,
  "gemini-2-pro": 88,
  "gemini-1.5-pro": 85,
  "gemini-1.5-flash": 78,
  
  // DeepSeek
  "deepseek-v3": 87,
  "deepseek-r1": 89,
  
  // Default fallback
  "default": 50,
};

/**
 * Reference pricing (USD per 1M tokens)
 * Used when models.json cost is 0/missing
 * Format: { input, output, cacheRead, cacheWrite }
 */
const REFERENCE_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Claude (Anthropic official)
  "claude-opus-4-8": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  
  // GPT (OpenAI official)
  "gpt-5.5": { input: 20, output: 80, cacheRead: 2, cacheWrite: 25 },
  "gpt-5": { input: 15, output: 60, cacheRead: 1.5, cacheWrite: 18.75 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
  "gpt-4-turbo": { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 },
  
  // Gemini (Google official)
  "gemini-3-pro": { input: 3.5, output: 10.5, cacheRead: 0.35, cacheWrite: 4.375 },
  "gemini-2-pro": { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
  "gemini-2-flash": { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.25 },
  "gemini-1.5-pro": { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5625 },
  
  // DeepSeek
  "deepseek-v3": { input: 0.27, output: 1.1, cacheRead: 0.027, cacheWrite: 0.3375 },
  "deepseek-r1": { input: 0.55, output: 2.19, cacheRead: 0.055, cacheWrite: 0.6875 },
};

/**
 * Channel pricing multipliers (v0.3.0)
 * Different channels may have different pricing for the same model
 */
const CHANNEL_PRICING_MULTIPLIERS: Record<string, number> = {
  // Official providers (1.0x = reference pricing)
  "anthropic": 1.0,
  "openai": 1.0,
  "google": 1.0,
  
  // Third-party aggregators (may add markup)
  "openrouter": 1.1,     // 10% markup
  "together": 1.05,      // 5% markup
  "fireworks": 1.08,     // 8% markup
  
  // Self-hosted / LAN (0.0x = free infrastructure cost)
  "lan": 0.0,            // Free (your own infrastructure)
  "local": 0.0,          // Free (local deployment)
  "self-hosted": 0.0,    // Free (your servers)
  
  // Custom channels (default: assume same as official)
  "n1-claude": 1.0,      // Your custom Claude channel
  "run-claude": 1.0,     // Your custom Claude channel
};

/**
 * Get effective pricing for a specific model@channel
 */
function getChannelPricing(
  modelId: string,
  channel: string
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  const basePricing = REFERENCE_PRICING[modelId];
  if (!basePricing) {
    return null;
  }
  
  const multiplier = CHANNEL_PRICING_MULTIPLIERS[channel] ?? 1.0;
  
  return {
    input: basePricing.input * multiplier,
    output: basePricing.output * multiplier,
    cacheRead: basePricing.cacheRead * multiplier,
    cacheWrite: basePricing.cacheWrite * multiplier,
  };
}

/**
 * Calculate cost for a request (estimated)
 */
function estimateRequestCost(
  modelId: string,
  channel: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): number {
  const pricing = getChannelPricing(modelId, channel);
  if (!pricing) {
    return 0;
  }
  
  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
  
  return cost;
}

/**
 * Diff types for models.json changes
 */
type ModelDiff = {
  added: Array<{ id: string; channels: string[]; aliases?: string[]; modelByChannel?: Record<string, string>; routes?: RouterRouteConfig[] }>;
  removed: Array<{ id: string; channels: string[] }>;
  modified: Array<{
    id: string;
    channelsAdded: string[];
    channelsRemoved: string[];
    propsChanged: string[];  // e.g., ["cost", "contextWindow"]
  }>;
};

let piConfigDirOverride: string | null = null;

/**
 * Get pi config directory
 */
function getPiConfigDir(): string {
  return piConfigDirOverride || path.join(os.homedir(), ".pi", "agent");
}

/**
 * Get models.json path
 */
function getModelsJsonPath(): string {
  return path.join(getPiConfigDir(), "models.json");
}

// Cache for provider IDs to avoid repeated file system access
let providerIdsCache: { authProviders: string[]; modelsProviders: string[]; mtimeMs: { auth: number | null; models: number | null } } | null = null;

/**
 * Load provider IDs from both auth.json and models.json with caching
 * FIX #9, #13: Consolidate synchronous file reads and cache results
 */
function loadProviderIds(forceRefresh = false): { authProviders: string[]; modelsProviders: string[] } {
  const authPath = path.join(getPiConfigDir(), "auth.json");
  const modelsPath = getModelsJsonPath();

  const authMtime = getFileMtimeMs(authPath);
  const modelsMtime = getFileMtimeMs(modelsPath);

  // Return cached if mtimes haven't changed
  if (!forceRefresh &&
      providerIdsCache &&
      providerIdsCache.mtimeMs.auth === authMtime &&
      providerIdsCache.mtimeMs.models === modelsMtime) {
    return {
      authProviders: providerIdsCache.authProviders,
      modelsProviders: providerIdsCache.modelsProviders
    };
  }

  let authProviders: string[] = [];
  let modelsProviders: string[] = [];

  // Load auth.json
  if (fs.existsSync(authPath)) {
    try {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, unknown>;
      authProviders = Object.keys(auth);
    } catch {
      authProviders = [];
    }
  }

  // Load models.json
  if (fs.existsSync(modelsPath)) {
    try {
      const modelsJson = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as { providers?: Record<string, unknown> };
      modelsProviders = Object.keys(modelsJson.providers || {});
    } catch {
      modelsProviders = [];
    }
  }

  // Update cache
  providerIdsCache = {
    authProviders,
    modelsProviders,
    mtimeMs: { auth: authMtime, models: modelsMtime }
  };

  return { authProviders, modelsProviders };
}

function normalizeModelForProvider(model: PiModel): PiModel {
  return {
    ...model,
    maxTokens: Math.min(model.maxTokens || DEFAULT_ROUTER_MAX_TOKENS, DEFAULT_ROUTER_MAX_TOKENS),
  };
}

/**
 * Merge headers and compat from multiple sources with correct precedence
 * FIX #11: Extract duplicated merge logic into shared helper
 * Precedence: override > provider > builtin (later spread wins)
 */
function mergeModelProps(
  builtin: { headers?: Record<string, string>; compat?: Record<string, unknown> },
  provider: { headers?: Record<string, string>; compat?: Record<string, unknown> },
  override: { headers?: Record<string, string>; compat?: Record<string, unknown> } = {}
): { headers?: Record<string, string>; compat?: Record<string, unknown> } {
  const headers = builtin.headers || provider.headers || override.headers
    ? { ...(builtin.headers || {}), ...(provider.headers || {}), ...(override.headers || {}) }
    : undefined;
  const compat = builtin.compat || provider.compat || override.compat
    ? { ...(builtin.compat || {}), ...(provider.compat || {}), ...(override.compat || {}) }
    : undefined;
  return { headers, compat };
}

/**
 * Expand provider models from models.json or modelOverrides with builtin fallback
 * FIX #7: Better error handling for getBuiltinPiAiModels cast
 * FIX #8: Warn user when modelOverrides entry has no builtin model
 * FIX #13: Respect explicit models:[] to disable provider (no builtin fallback)
 */
function expandProviderModels(providerName: string, provider: any): PiModel[] {
  const expanded: PiModel[] = [];
  let builtinModels: PiModel[] = [];

  // Try to get builtin models with safer error handling
  try {
    const getBuiltin = getBuiltinPiAiModels as any;
    if (typeof getBuiltin === 'function') {
      const result = getBuiltin(providerName);
      builtinModels = Array.isArray(result) ? result : [];
    }
  } catch (err) {
    debugLog(`[pi-router] Failed to get builtin models for ${providerName}:`, err);
    builtinModels = [];
  }

  // Process explicit models array
  if (Array.isArray(provider.models)) {
    // FIX #13: If models array is explicitly set (even if empty), don't use builtin fallback
    // This allows users to disable a provider by setting models:[]
    for (const model of provider.models) {
      const merged = mergeModelProps(
        {},
        { headers: provider.headers, compat: provider.compat },
        { headers: model.headers, compat: model.compat }
      );

      expanded.push(normalizeModelForProvider({
        ...model,
        provider: providerName,
        api: model.api || provider.api || "unknown",
        baseUrl: model.baseUrl || provider.baseUrl,
        headers: merged.headers,
        compat: merged.compat,
      }));
    }

    // Early return - don't fall through to builtin fallback when models array is explicit
    if (provider.models.length === 0) {
      debugLog(`[pi-router] Provider ${providerName} has explicit empty models array, skipping builtin fallback`);
    }

    // Process modelOverrides for explicit models array
    if (provider.modelOverrides && typeof provider.modelOverrides === "object") {
      for (const [modelId, overrideData] of Object.entries(provider.modelOverrides)) {
        if (expanded.some(model => model.id === modelId)) {
          continue;
        }

        const builtinModel = builtinModels.find(model => model.id === modelId);
        if (!builtinModel) {
          // FIX #6: Only warn if this provider actually has builtin models but this ID is missing
          // OAuth providers like 'kiro' have no builtin models, so missing is expected
          if (builtinModels.length > 0) {
            console.warn(`[pi-router] Warning: modelOverrides entry '${providerName}.${modelId}' has no builtin model to extend. Check that the model ID is correct.`);
            debugLog(`[pi-router] Available builtin models for ${providerName}:`, builtinModels.map(m => m.id));
          } else {
            debugLog(`[pi-router] Skipping modelOverrides entry '${providerName}.${modelId}': no builtin models available (OAuth provider)`);
          }
          continue;
        }

        const override = overrideData as Partial<PiModel>;
        const merged = mergeModelProps(
          { headers: builtinModel.headers, compat: builtinModel.compat },
          { headers: provider.headers, compat: provider.compat },
          { headers: override.headers, compat: override.compat }
        );

        expanded.push(normalizeModelForProvider({
          ...builtinModel,
          ...override,
          id: modelId,
          provider: providerName,
          api: override.api || provider.api || builtinModel.api || "unknown",
          baseUrl: override.baseUrl || provider.baseUrl || builtinModel.baseUrl,
          headers: merged.headers,
          compat: merged.compat,
        }));
      }
    }

    return expanded;
  }

  // Process modelOverrides-only providers (like openai-codex)
  if (provider.modelOverrides && typeof provider.modelOverrides === "object") {
    for (const [modelId, overrideData] of Object.entries(provider.modelOverrides)) {
      const builtinModel = builtinModels.find(model => model.id === modelId);
      if (!builtinModel) {
        // FIX #6: Only warn if this provider actually has builtin models but this ID is missing
        // OAuth providers like 'kiro' have no builtin models, so missing is expected
        if (builtinModels.length > 0) {
          console.warn(`[pi-router] Warning: modelOverrides entry '${providerName}.${modelId}' has no builtin model to extend. Check that the model ID is correct.`);
          debugLog(`[pi-router] Available builtin models for ${providerName}:`, builtinModels.map(m => m.id));
        } else {
          debugLog(`[pi-router] Skipping modelOverrides entry '${providerName}.${modelId}': no builtin models available (OAuth provider)`);
        }
        continue;
      }

      const override = overrideData as Partial<PiModel>;
      const merged = mergeModelProps(
        { headers: builtinModel.headers, compat: builtinModel.compat },
        { headers: provider.headers, compat: provider.compat },
        { headers: override.headers, compat: override.compat }
      );

      expanded.push(normalizeModelForProvider({
        ...builtinModel,
        ...override,
        id: modelId,
        provider: providerName,
        api: override.api || provider.api || builtinModel.api || "unknown",
        baseUrl: override.baseUrl || provider.baseUrl || builtinModel.baseUrl,
        headers: merged.headers,
        compat: merged.compat,
      }));
    }
  }

  // Only use builtin fallback if no explicit models array was provided
  if (expanded.length === 0 && builtinModels.length > 0 && !Array.isArray(provider.models)) {
    for (const builtinModel of builtinModels) {
      const merged = mergeModelProps({ headers: builtinModel.headers, compat: builtinModel.compat }, { headers: provider.headers, compat: provider.compat });

      expanded.push(normalizeModelForProvider({
        ...builtinModel,
        provider: providerName,
        api: provider.api || builtinModel.api || "unknown",
        baseUrl: provider.baseUrl || builtinModel.baseUrl,
        headers: merged.headers,
        compat: merged.compat,
      }));
    }
  }

  return expanded;
}

function modelsFromRegistry(modelRegistry: any): PiModel[] | undefined {
  const getter = typeof modelRegistry?.getAvailable === "function"
    ? () => modelRegistry.getAvailable()
    : typeof modelRegistry?.getAll === "function"
      ? () => modelRegistry.getAll()
      : undefined;

  if (!getter) {
    return undefined;
  }

  try {
    const models = getter() as Array<any>;
    return models.map((model) => normalizeModelForProvider({
      id: model.id,
      name: model.name,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      headers: model.headers,
      compat: model.compat,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
      input: model.input,
    }));
  } catch (err) {
    debugLog("[pi-router] Failed to read models from model registry:", err);
    return undefined;
  }
}

function getEffectiveModels(modelRegistry?: any): PiModel[] {
  return modelsFromRegistry(modelRegistry) || loadModelsJson();
}

function filterConfigurableModels(models: PiModel[], allowedProviders: Set<string>): PiModel[] {
  return models.filter((model) =>
    model.provider !== "router" &&
    model.api !== ROUTER_API &&
    allowedProviders.has(model.provider)
  );
}

function getConfigurableModels(modelRegistry?: any, forceRefresh = false): PiModel[] {
  const { authProviders, modelsProviders } = loadProviderIds(forceRefresh);
  const allowedProviders = new Set<string>([...authProviders, ...modelsProviders]);
  const diskModels = loadModelsJson(forceRefresh);
  if (diskModels.length > 0) {
    return filterConfigurableModels(diskModels, allowedProviders);
  }
  return filterConfigurableModels(getEffectiveModels(modelRegistry), allowedProviders);
}

function buildModelMap(models: PiModel[]): Map<string, PiModel> {
  const modelMap = new Map<string, PiModel>();
  for (const model of models) {
    if (model.provider === "router" || model.api === ROUTER_API) {
      continue;
    }
    modelMap.set(`${model.id}@${model.provider}`, model);
  }
  return modelMap;
}

/**
 * Get pi-router config path
 */
function getRouterConfigPath(): string {
  return path.join(getPiConfigDir(), "pi-router.json");
}

/**
 * Calculate SHA256 hash of file content (optimized with mtime caching)
 */
let fileHashCache = new Map<string, { hash: string; mtime: number }>();

// Auto-sync state (module-level to be accessible from registerRouterProvider)
let autoSyncChecked = false;
let autoSyncConfig: RouterConfig | null = null;

/**
 * Check for models.json changes (auto-sync)
 * Called on first use or after 30s as fallback
 */
function checkAutoSyncOnce(): void {
  if (autoSyncChecked || !autoSyncConfig) return;
  autoSyncChecked = true;

  if (autoSyncConfig.autoSync !== false && autoSyncConfig.lastSyncHash) {
    debugLog("[pi-router] Checking for models.json changes...");

    const models = getSyncModels();
    const modelsJsonHash = calculateFileHash(getModelsJsonPath());

    if (autoSyncConfig.lastSyncHash !== modelsJsonHash) {
      const diff = detectModelChanges(autoSyncConfig, models);
      const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0;

      if (hasChanges) {
        debugLog("[pi-router] Detected models.json changes:");
        debugLog(`  Added: ${diff.added.length}, Removed: ${diff.removed.length}, Modified: ${diff.modified.length}`);
        debugLog("[pi-router] Run '/router sync' to review and update config");
      }
    }
  }
}

function calculateFileHash(filePath: string, forceRefresh = false): string {
  if (!fs.existsSync(filePath)) return "";
  
  try {
    const stats = fs.statSync(filePath);
    const mtime = stats.mtimeMs;
    
    // Check cache - if file hasn't changed, return cached hash
    const cached = fileHashCache.get(filePath);
    if (!forceRefresh && cached && cached.mtime === mtime) {
      return cached.hash;
    }
    
    // Calculate hash only if file changed
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    
    // Update cache
    fileHashCache.set(filePath, { hash, mtime });
    return hash;
  } catch (err) {
    console.warn("[pi-router] Failed to calculate file hash:", err);
    return "";
  }
}

// Cache for loaded models to avoid re-parsing on every call
let modelsCache: PiModel[] | null = null;
let modelsCacheTimestamp = 0;
let modelsCacheModelsMtime: number | null = null;
let modelsCacheAuthMtime: number | null = null;
const CACHE_TTL = 60000; // 1 minute cache

/**
 * Load models from models.json (with caching)
 */
function loadModelsJson(forceRefresh = false): PiModel[] {
  const now = Date.now();
  const modelsPath = getModelsJsonPath();
  const authPath = path.join(getPiConfigDir(), "auth.json");
  const modelsMtime = getFileMtimeMs(modelsPath);
  const authMtime = getFileMtimeMs(authPath);

  if (
    !forceRefresh &&
    modelsCache &&
    modelsCacheModelsMtime === modelsMtime &&
    modelsCacheAuthMtime === authMtime &&
    (now - modelsCacheTimestamp < CACHE_TTL)
  ) {
    return modelsCache;
  }
  
  if (!fs.existsSync(modelsPath)) {
    console.warn("[pi-router] models.json not found:", modelsPath);
    return [];
  }
  
  try {
    const content = fs.readFileSync(modelsPath, "utf-8");
    const data = JSON.parse(content);
    
    // models.json structure: { providers: { providerName: { models?: [...], modelOverrides?: {...} } } }
    if (!data.providers || typeof data.providers !== "object") {
      console.warn("[pi-router] Invalid models.json structure (no providers)");
      return [];
    }
    
    const allModels: PiModel[] = [];
    
    const configuredProviderNames = new Set(Object.keys(data.providers));
    for (const [providerName, providerData] of Object.entries(data.providers)) {
      const provider = providerData as any;
      allModels.push(...expandProviderModels(providerName, provider));
    }

    const { authProviders } = loadProviderIds();
    for (const providerName of authProviders) {
      // Auth-only discovery should only fill in providers absent from models.json.
      // If a provider is explicitly present with models: [], that is an intentional
      // user-level disable and must not be undone by auth.json.
      if (configuredProviderNames.has(providerName) || allModels.some(model => model.provider === providerName)) {
        continue;
      }
      allModels.push(...expandProviderModels(providerName, {}));
    }
    
    // Update cache
    modelsCache = allModels;
    modelsCacheTimestamp = now;
    modelsCacheModelsMtime = modelsMtime;
    modelsCacheAuthMtime = authMtime;
    
    return allModels;
  } catch (err) {
    console.error("[pi-router] Failed to load models.json:", err);
    return [];
  }
}

function loadExplicitModelsJson(): PiModel[] {
  const modelsPath = getModelsJsonPath();

  if (!fs.existsSync(modelsPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(modelsPath, "utf-8");
    const data = JSON.parse(content);

    if (!data.providers || typeof data.providers !== "object") {
      return [];
    }

    const explicitModels: PiModel[] = [];
    for (const [providerName, providerData] of Object.entries(data.providers)) {
      explicitModels.push(...expandProviderModels(providerName, providerData as any));
    }

    return explicitModels;
  } catch (err) {
    console.error("[pi-router] Failed to load explicit models.json entries:", err);
    return [];
  }
}

/**
 * Group models by id (collect all channels for same model)
 */
function groupModelsByChannels(models: PiModel[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  
  for (const model of models) {
    if (!groups.has(model.id)) {
      groups.set(model.id, []);
    }
    groups.get(model.id)!.push(model.provider);
  }
  
  return groups;
}

type ResolvedModelRoute = {
  canonicalId: string;
  upstreamId: string;
  channel: string;
  routeKey: string;
  routeLabel: string;
  routeEntry: RouterRouteEntry;
  model: PiModel;
};

type ModelAliasGroup = {
  channels: string[];
  aliases: string[];
  modelByChannel: Record<string, string>;
  routes: RouterRouteConfig[];
};

function normalizeModelAliasId(id: string): string {
  return id.trim().toLowerCase();
}

function addModelAlias(aliases: string[], alias: unknown, canonicalId: string): void {
  if (typeof alias !== "string") return;
  const trimmed = alias.trim();
  if (!trimmed || trimmed === canonicalId) return;
  if (!aliases.includes(trimmed)) aliases.push(trimmed);
}

function getModelConfigAliases(modelConfig: Pick<RouterModelConfig, "id" | "aliases" | "modelByChannel">): string[] {
  const aliases: string[] = [];
  for (const alias of modelConfig.aliases || []) {
    addModelAlias(aliases, alias, modelConfig.id);
  }
  for (const alias of Object.values(modelConfig.modelByChannel || {})) {
    addModelAlias(aliases, alias, modelConfig.id);
  }
  return aliases;
}

function buildModelAliasLookup(config?: RouterConfig): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const modelConfig of config?.models || []) {
    lookup.set(normalizeModelAliasId(modelConfig.id), modelConfig.id);
    for (const alias of getModelConfigAliases(modelConfig)) {
      lookup.set(normalizeModelAliasId(alias), modelConfig.id);
    }
    for (const fallback of modelConfig.fallbackModels || []) {
      lookup.set(normalizeModelAliasId(fallback.id), fallback.id);
      for (const alias of getModelConfigAliases(fallback)) {
        lookup.set(normalizeModelAliasId(alias), fallback.id);
      }
    }
  }

  // Legacy compatibility for configs that adopted the earlier draft shape.
  for (const [canonicalId, aliases] of Object.entries(config?.modelAliases || {})) {
    lookup.set(normalizeModelAliasId(canonicalId), canonicalId);
    for (const alias of aliases || []) {
      if (typeof alias === "string" && alias.trim().length > 0) {
        lookup.set(normalizeModelAliasId(alias), canonicalId);
      }
    }
  }

  return lookup;
}

function resolveCanonicalModelId(modelId: string, config?: RouterConfig): string {
  return buildModelAliasLookup(config).get(normalizeModelAliasId(modelId)) || modelId;
}

function getCandidateUpstreamModelIds(modelConfig: Pick<RouterModelConfig, "id" | "aliases" | "modelByChannel" | "routes">, channel: string): string[] {
  const candidates: string[] = [];
  const addCandidate = (id: unknown) => {
    if (typeof id !== "string") return;
    const trimmed = id.trim();
    if (!trimmed || candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };

  for (const route of getModelRouteEntries(modelConfig)) {
    if (route.channel === channel) addCandidate(route.upstreamModelId);
  }
  addCandidate(modelConfig.modelByChannel?.[channel]);
  addCandidate(modelConfig.id);
  for (const alias of modelConfig.aliases || []) addCandidate(alias);
  for (const alias of Object.values(modelConfig.modelByChannel || {})) addCandidate(alias);

  return candidates;
}

function getUpstreamModelId(modelConfig: Pick<RouterModelConfig, "id" | "aliases" | "modelByChannel" | "routes">, channel: string): string {
  return getCandidateUpstreamModelIds(modelConfig, channel)[0] || modelConfig.id;
}

function resolveConfiguredRouteByEntry(
  modelConfig: RouterModelConfig,
  routeEntry: RouterRouteEntry,
  modelMap: Map<string, PiModel>
): ResolvedModelRoute | undefined {
  const candidates: string[] = [];
  const addCandidate = (id: unknown) => {
    if (typeof id !== "string") return;
    const trimmed = id.trim();
    if (!trimmed || candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };
  addCandidate(routeEntry.upstreamModelId);
  // Legacy/simple routes without an explicit model can still fall back through aliases.
  if (!routeEntry.explicitModel) {
    for (const alias of getCandidateUpstreamModelIds(modelConfig, routeEntry.channel)) addCandidate(alias);
  }

  for (const upstreamId of candidates) {
    const targetModel = modelMap.get(`${upstreamId}@${routeEntry.channel}`);
    if (targetModel) {
      const resolvedEntry: RouterRouteEntry = {
        ...routeEntry,
        upstreamModelId: targetModel.id,
        routeKey: makeRouteKey(routeEntry.channel, targetModel.id, modelConfig.id),
      };
      resolvedEntry.label = getRouteDisplayLabel(resolvedEntry);
      return {
        canonicalId: modelConfig.id,
        upstreamId: targetModel.id,
        channel: routeEntry.channel,
        routeKey: resolvedEntry.routeKey,
        routeLabel: resolvedEntry.label,
        routeEntry: resolvedEntry,
        model: targetModel,
      };
    }
  }

  return undefined;
}

function resolveConfiguredRoute(
  modelConfig: RouterModelConfig,
  channel: string,
  modelMap: Map<string, PiModel>
): ResolvedModelRoute | undefined {
  const routeEntries = getModelRouteEntries(modelConfig).filter(route => route.channel === channel);
  for (const routeEntry of routeEntries) {
    const route = resolveConfiguredRouteByEntry(modelConfig, routeEntry, modelMap);
    if (route) return route;
  }

  // Fallback for ad-hoc customOrder items not present in routes/channels.
  const fallbackEntry: RouterRouteEntry = {
    modelId: modelConfig.id,
    channel,
    upstreamModelId: modelConfig.modelByChannel?.[channel] || modelConfig.id,
    routeKey: makeRouteKey(channel, modelConfig.modelByChannel?.[channel], modelConfig.id),
    label: channel,
    explicitModel: !!modelConfig.modelByChannel?.[channel],
  };
  fallbackEntry.label = getRouteDisplayLabel(fallbackEntry);
  return resolveConfiguredRouteByEntry(modelConfig, fallbackEntry, modelMap);
}

function resolveConfiguredRouteByKey(
  modelConfig: RouterModelConfig,
  routeKey: string,
  modelMap: Map<string, PiModel>
): ResolvedModelRoute | undefined {
  const route = getModelRouteEntries(modelConfig).find(entry => entry.routeKey === routeKey || entry.channel === routeKey);
  return route ? resolveConfiguredRouteByEntry(modelConfig, route, modelMap) : resolveConfiguredRoute(modelConfig, routeKey, modelMap);
}

function getConfiguredModel(
  modelConfig: RouterModelConfig,
  channel: string,
  modelMap: Map<string, PiModel>
): PiModel | undefined {
  return resolveConfiguredRoute(modelConfig, channel, modelMap)?.model;
}

function createEmptyAliasGroup(): ModelAliasGroup {
  return { channels: [], aliases: [], modelByChannel: {}, routes: [] };
}

function groupModelsByChannelsWithAliases(
  models: PiModel[],
  config?: RouterConfig
): Map<string, ModelAliasGroup> {
  const groups = new Map<string, ModelAliasGroup>();

  for (const model of models) {
    const canonicalId = resolveCanonicalModelId(model.id, config);
    if (!groups.has(canonicalId)) {
      groups.set(canonicalId, createEmptyAliasGroup());
    }

    const group = groups.get(canonicalId)!;
    if (!group.channels.includes(model.provider)) {
      group.channels.push(model.provider);
    }
    const route: RouterRouteConfig = {
      channel: model.provider,
      ...(model.id !== canonicalId ? { model: model.id } : {}),
    };
    const routeSignature = `${route.channel}\u0000${route.model || canonicalId}`;
    if (!group.routes.some(existing => `${existing.channel}\u0000${existing.model || canonicalId}` === routeSignature)) {
      group.routes.push(route);
    }
    if (model.id !== canonicalId) {
      if (!group.modelByChannel[model.provider]) {
        group.modelByChannel[model.provider] = model.id;
      }
      addModelAlias(group.aliases, model.id, canonicalId);
    }
  }

  return groups;
}

function createRouterModelConfigFromGroup(
  id: string,
  group: ModelAliasGroup
): RouterModelConfig {
  const serialized = serializeRouteEntriesForConfig(
    id,
    group.routes.map(route => ({ channel: route.channel, upstreamModelId: route.model || id }))
  );
  return {
    id,
    ...(group.aliases.length > 0 ? { aliases: group.aliases } : {}),
    channels: serialized.channels,
    ...(serialized.modelByChannel ? { modelByChannel: serialized.modelByChannel } : {}),
    ...(serialized.routes ? { routes: serialized.routes } : {}),
  };
}

/**
 * Detect changes between current models.json and config
 */
function detectModelChanges(config: RouterConfig, currentModels: PiModel[]): ModelDiff {
  const currentGroups = groupModelsByChannelsWithAliases(currentModels, config);
  const configModels = config.models || [];
  
  const diff: ModelDiff = {
    added: [],
    removed: [],
    modified: [],
  };
  
  // Check for added models
  for (const [modelId, group] of currentGroups.entries()) {
    const configModel = configModels.find(m => m.id === modelId);
    if (!configModel) {
      diff.added.push({
        id: modelId,
        channels: group.channels,
        ...(group.aliases.length > 0 ? { aliases: group.aliases } : {}),
        ...(Object.keys(group.modelByChannel).length > 0 ? { modelByChannel: group.modelByChannel } : {}),
        ...(group.routes.length > group.channels.length ? { routes: group.routes } : {}),
      });
    }
  }
  
  // Check for removed/modified models
  for (const configModel of configModels) {
    const currentGroup = currentGroups.get(configModel.id);
    
    if (!currentGroup) {
      diff.removed.push({ id: configModel.id, channels: configModel.channels });
    } else {
      const channelsAdded = currentGroup.channels.filter(c => !configModel.channels.includes(c));
      const channelsRemoved = configModel.channels.filter(c => !currentGroup.channels.includes(c));
      const missingAliases = currentGroup.aliases.filter(alias => !(configModel.aliases || []).includes(alias));
      const serializedGroup = serializeRouteEntriesForConfig(
        configModel.id,
        currentGroup.routes.map(route => ({ channel: route.channel, upstreamModelId: route.model || configModel.id }))
      );
      const routesChanged = !routesEqual(getModelRouteEntries(configModel), getModelRouteEntries({
        id: configModel.id,
        channels: serializedGroup.channels,
        modelByChannel: serializedGroup.modelByChannel,
        routes: serializedGroup.routes,
      }));
      const modelByChannelChanged = !serializedGroup.routes && !recordsEqual(configModel.modelByChannel, serializedGroup.modelByChannel);
      const propsChanged = [
        ...(missingAliases.length > 0 ? ["aliases"] : []),
        ...(routesChanged && serializedGroup.routes ? ["routes"] : []),
        ...(modelByChannelChanged ? ["modelByChannel"] : []),
      ];
      
      if (channelsAdded.length > 0 || channelsRemoved.length > 0 || propsChanged.length > 0) {
        diff.modified.push({
          id: configModel.id,
          channelsAdded,
          channelsRemoved,
          propsChanged,
        });
      }
    }
  }
  
  return diff;
}

function getSyncModels(): PiModel[] {
  const explicitModels = loadExplicitModelsJson();
  const { modelsProviders } = loadProviderIds(true);
  return filterConfigurableModels(explicitModels, new Set(modelsProviders));
}

function normalizeRecord(record: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(record || {}).sort()) {
    const value = record?.[key];
    if (typeof value === "string") normalized[key] = value;
  }
  return normalized;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values || []).filter(value => typeof value === "string" && value.length > 0))).sort();
}

function aliasesEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  return JSON.stringify(normalizeStringList(a)) === JSON.stringify(normalizeStringList(b));
}

function recordsEqual(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  return JSON.stringify(normalizeRecord(a)) === JSON.stringify(normalizeRecord(b));
}

function routesEqual(a: RouterRouteEntry[], b: RouterRouteEntry[]): boolean {
  const normalize = (routes: RouterRouteEntry[]) => routes
    .map(route => ({ channel: route.channel, upstreamModelId: route.upstreamModelId || route.modelId }))
    .sort((left, right) => left.channel.localeCompare(right.channel) || left.upstreamModelId.localeCompare(right.upstreamModelId));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

let configFileMtimeMs: number | null = null;
let currentRouterConfig: RouterConfig | null = null;

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : null;
  } catch {
    return null;
  }
}

function setCurrentRouterConfig(config: RouterConfig): RouterConfig {
  currentRouterConfig = config;
  autoSyncConfig = config;
  routerState.customFooterEnabled = config.footer?.rightAlignRoute !== false;
  routerState.footerStatusLineEnabled = config.footer?.statusLine !== false;
  return config;
}

function getCurrentRouterConfig(): RouterConfig {
  return currentRouterConfig || setCurrentRouterConfig(loadConfig());
}

function refreshConfigFromDisk(config?: RouterConfig): RouterConfig {
  const configPath = getRouterConfigPath();
  const mtimeMs = getFileMtimeMs(configPath);
  const currentConfig = currentRouterConfig || config || loadConfig();
  if (configFileMtimeMs === mtimeMs) {
    return currentConfig;
  }

  const freshConfig = loadConfig();
  configFileMtimeMs = mtimeMs;
  debugLog("[pi-router] Reloaded config from disk");
  return setCurrentRouterConfig(freshConfig);
}

/**
 * Load config from ~/.pi/agent/pi-router.json
 */
function loadConfig(): RouterConfig {
  const configPath = getRouterConfigPath();
  
  if (!fs.existsSync(configPath)) {
    debugLog("[pi-router] No config found. Auto-discovery disabled by default.");
    debugLog("[pi-router] Create ~/.pi/agent/pi-router.json to configure models.");
    debugLog("[pi-router] See examples/router.config.json for reference.");
    return {
      strategy: "channelFirst",
      auto: false,  // Disabled to avoid slow startup on every launch
      autoSync: false,
      models: [],
    };
  }
  
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as RouterConfig;
    return {
      strategy: "channelFirst",
      auto: true,
      autoSync: true,
      ...config,
    };
  } catch (err) {
    console.error("[pi-router] Failed to load config:", err);
    return {
      strategy: "channelFirst",
      auto: true,
      autoSync: true,
      models: [],
    };
  }
}

/**
 * Save config to ~/.pi/agent/pi-router.json
 */
function saveConfig(config: RouterConfig): void {
  const configPath = getRouterConfigPath();
  const configDir = path.dirname(configPath);
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(addConfigComments(config), null, 2), "utf-8");
    writeConfigReadme(configPath);
    configFileMtimeMs = getFileMtimeMs(configPath);
    setCurrentRouterConfig(config);
    debugLog("[pi-router] Config saved:", configPath);
  } catch (err) {
    console.error("[pi-router] Failed to save config:", err);
  }
}

/**
 * Add JSON-safe comment keys for users who edit pi-router.json manually.
 */
function addConfigComments(config: RouterConfig): Record<string, unknown> {
  return {
    _comment_1: "Pi-Router 配置文件。可手动编辑；也可运行 /router config wizard 重新生成。",
    _comment_2: "配置文件路径: ~/.pi/agent/pi-router.json；修改后运行 /reload 或重启 pi 生效。",
    _comment_strategy: "路由策略: channelFirst(通道优先) / custom(自定义顺序)",
    strategy: config.strategy ?? "channelFirst",
    _comment_auto: "是否注册 router/auto 并在无 models 时自动发现多通道模型",
    auto: config.auto ?? true,
    _comment_sortBy: "排序策略: latency(延迟) / capabilityFirst(能力) / cost(成本) / manual(手动)",
    sortBy: config.sortBy ?? "latency",
    _comment_autoSync: "自动同步: true=从 models.json 自动发现多通道模型；false=手动维护 models",
    autoSync: config.autoSync ?? true,
    lastSyncHash: config.lastSyncHash,
    _comment_healthProbe: "健康探测: enabled=true 时每 intervalMs 毫秒探测一次",
    healthProbe: config.healthProbe ?? { enabled: false },
    _comment_sticky: "粘性模式: true=优先复用上次成功通道，提高缓存命中率",
    sticky: config.sticky ?? true,
    ...(config.stickyRecords && Object.keys(config.stickyRecords).length > 0
      ? { _comment_stickyRecords: "运行时粘性路由记录，由 pi-router 自动维护", stickyRecords: config.stickyRecords }
      : {}),
    _comment_models: "模型配置: id 是 router/<id> 的 canonical 名；aliases/modelByChannel 可把不同上游模型名归并到同一模型；channels 从左到右依次尝试；fallbackModels 为模型级降级链",
    models: config.models ?? [],
    _comment_customOrder: "自定义顺序(仅 custom 策略): model@channel 二元组数组，按此顺序尝试；customRoutes 用于区分同 provider 的模型名变种",
    ...(config.customOrder ? { customOrder: config.customOrder } : {}),
    ...(config.customRoutes ? { customRoutes: config.customRoutes } : {}),
    ...(config.request ? { _comment_request: "请求控制: timeoutMs / maxRetries / maxRetryDelayMs / maxTokens", request: config.request } : {}),
    _comment_footer: "底部状态栏: rightAlignRoute 默认 true(替换 footer 并右对齐路由状态)；statusLine 默认 true(禁用替换时仍显示简短状态)",
    footer: config.footer ?? { rightAlignRoute: true, statusLine: true },
    ...(config.intent ? { intent: config.intent } : {}),
    _comment_advanced: "高级配置，通常不需要手动修改",
    failover: config.failover ?? {
      on: ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"],
      cooldownMs: 60000,
    },
    contextTransfer: config.contextTransfer ?? "summary",
    summaryModel: config.summaryModel,
    summaryPrompt: config.summaryPrompt,
    summaryMaxTokens: config.summaryMaxTokens ?? 2000,
    logDir: config.logDir,
  };
}

/**
 * Write a companion README for terminal users who edit pi-router.json directly.
 */
function writeConfigReadme(configPath: string): void {
  const readmePath = configPath.replace(/\.json$/, ".README.md");
  const content = `# Pi-Router 配置说明

配置文件: \`${configPath}\`

## 推荐方式

运行交互式向导：

\`\`\`bash
/router config wizard
\`\`\`

快捷命令：

- \`/router config w\`：运行完整向导
- \`/router config order\`：仅调整现有模型/渠道顺序
- \`/router config s\`：显示当前配置
- \`/router config r\`：重置配置

## 手动编辑

你也可以直接编辑 \`pi-router.json\`。修改后运行 \`/reload\` 或重启 pi 生效。

### 关键字段

- \`strategy\`: \`channelFirst\` 或 \`custom\`
- \`auto\`: 是否注册 \`router/auto\` 并支持首次自动发现
- \`sortBy\`: \`latency\` / \`capabilityFirst\` / \`cost\` / \`manual\`
- \`autoSync\`: 是否从 models.json 自动同步多通道模型
- \`healthProbe.enabled\`: 是否启用健康探测
- \`sticky\`: 是否优先复用上次成功通道
- \`request\`: 请求超时、重试与 maxTokens 控制
- \`footer.rightAlignRoute\`: 默认 true；设为 false 可保留 pi 内置 footer
- \`footer.statusLine\`: 默认 true；仅在禁用替换 footer 时控制简短状态项
- \`summaryMaxTokens\`: AI 摘要目标上限（默认 2000）
- \`models[].channels\`: 通道尝试顺序，从左到右

## 通道分类规则

配置向导会自动扫描 auth.json 与 models.json：

1. auth.json 中 type=oauth 的渠道视为 OAuth 官方渠道
2. baseUrl 是 localhost/内网地址的渠道视为本地/自建
3. baseUrl 匹配官方域名的渠道视为官方渠道
4. 其他渠道默认视为第三方平台
`;
  fs.writeFileSync(readmePath, content, "utf-8");
}

/**
 * Match config subcommand with shortcuts
 */
function matchConfigSubcommand(input: string): string | null {
  const commands = ["wizard", "order", "show", "reset"];
  const aliases: Record<string, string> = {
    "w": "wizard",
    "wiz": "wizard",
    "o": "order",
    "ord": "order",
    "reorder": "order",
    "s": "show",
    "sh": "show",
    "r": "reset",
    "res": "reset"
  };
  
  // Check alias
  if (aliases[input]) return aliases[input];
  
  // Exact match
  if (commands.includes(input)) return input;
  
  // Prefix match
  const matches = commands.filter(cmd => cmd.startsWith(input));
  if (matches.length === 1) return matches[0];
  
  return null;
}

/**
 * Show current configuration
 */
function showCurrentConfig(ctx: any, config: RouterConfig): void {
  const lines: string[] = [];
  
  lines.push("╔═══════════════════════════════════════════════════════════╗");
  lines.push("║           Pi-Router 当前配置                              ║");
  lines.push("╚═══════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push("【用户配置】");
  lines.push("");
  lines.push(`  路由策略: ${config.strategy || "channelFirst"}`);
  lines.push(`  排序策略: ${config.sortBy || "latency"}`);
  lines.push(`  自动同步: ${config.autoSync !== false ? "启用" : "禁用"}`);
  lines.push(`  健康探测: ${config.healthProbe?.enabled ? "启用" : "禁用"}`);
  lines.push(`  粘性模式: ${config.sticky !== false ? "启用" : "禁用"}`);
  lines.push("");
  lines.push("【智能默认值】（可手动编辑配置文件修改）");
  lines.push("");
  lines.push("  故障转移:");
  lines.push(`    • 触发条件: ${config.failover?.on?.join(", ") || "ECONNREFUSED, ETIMEDOUT, ENOTFOUND"}`);
  lines.push(`    • 冷却时间: ${config.failover?.cooldownMs || 60000}ms`);
  lines.push("");
  lines.push(`  上下文传输: ${config.contextTransfer || "summary"}`);
  lines.push(`  摘要模型: ${config.summaryModel || "默认使用切换后的目标模型"}`);
  lines.push(`  摘要上限: ${config.summaryMaxTokens || 2000} tokens`);
  lines.push("");
  lines.push(`【配置的模型】(${config.models?.length || 0} 个)`);
  lines.push("");
  
  if (config.models && config.models.length > 0) {
    config.models.forEach(m => {
      lines.push(`  ${m.id}`);
      lines.push(`    通道: ${getModelRouteEntries(m).map(route => route.label).join(" → ")}`);
      if (m.fallbackModels && m.fallbackModels.length > 0) {
        lines.push(`    降级: ${m.fallbackModels.map(f => f.id).join(" → ")}`);
      }
    });
  } else {
    lines.push("  未配置模型");
  }
  
  lines.push("");
  lines.push("  auto 模式会按上面的模型顺序依次尝试；某个模型成功后就不会继续往后尝试。");
  lines.push("");
  lines.push(`配置文件: ~/.pi/agent/pi-router.json`);
  lines.push("");
  lines.push("运行 /router config order 调整现有模型/渠道顺序");
  lines.push("运行 /router config wizard 重新跑完整配置向导");
  lines.push("运行 /reload 应用配置更改");
  
  ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Show config help
 */
/**
 * Confirm reset configuration
 */
async function confirmReset(ctx: any): Promise<boolean> {
  const items: SelectItem[] = [
    {
      value: "cancel",
      label: "取消",
      description: "保留当前配置"
    },
    {
      value: "reset",
      label: "确认重置",
      description: "恢复默认配置，需要重新运行配置向导"
    }
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("warning", theme.bold("确认重置 Pi-Router 配置？")), 1, 1));
    container.addChild(new Text(theme.fg("dim", "此操作会覆盖 ~/.pi/agent/pi-router.json。"), 1, 0));

    const selectList = new SelectList(items, items.length, {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done("cancel");
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ 选择 • enter 确认 • esc 取消"), 1, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  });

  return result === "reset";
}

/**
 * Reset configuration to defaults
 */
function resetConfig(): RouterConfig {
  const defaultConfig: RouterConfig = {
    strategy: "channelFirst",
    sortBy: "latency",
    autoSync: true,
    sticky: true,
    healthProbe: { enabled: false },
    models: [],
    failover: {
      on: ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"],
      cooldownMs: 60000
    },
    contextTransfer: "summary",
    summaryMaxTokens: 2000
  };
  
  saveConfig(defaultConfig);
  debugLog("[pi-router] Config reset to defaults");
  return getCurrentRouterConfig();
}

/**
 * Show interactive router menu (when /router is called without args)
 */
async function showRouterMenu(ctx: any, config: RouterConfig): Promise<void> {
  const items: SelectItem[] = [
    { value: "config", label: "config", description: "Configuration management" },
    { value: "status", label: "status", description: "Show router status" },
    { value: "list", label: "list", description: "List configured models" },
    { value: "explain", label: "explain", description: "Show failures, latency, health" },
    { value: "decisions", label: "decisions", description: "Show recent routing decisions" },
    { value: "probes", label: "probes", description: "Show background health probes" },
    { value: "pricing", label: "pricing", description: "Show per-channel pricing" },
    { value: "sync", label: "sync", description: "Check models.json changes" },
    { value: "diff", label: "diff", description: "Preview config differences" },
    { value: "sticky", label: "sticky", description: "View/clear sticky routing records" },
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("\u2554 Pi-Router (v0.4.0)")), 1, 1));
    container.addChild(new Text(theme.fg("dim", "\u2500".repeat(40)), 1, 0));

    const selectList = new SelectList(items, items.length, {
      selectedPrefix: (txt: string) => theme.fg("accent", txt),
      selectedText: (txt: string) => theme.fg("accent", txt),
      description: (txt: string) => theme.fg("muted", txt),
      scrollInfo: (txt: string) => theme.fg("dim", txt),
      noMatch: (txt: string) => theme.fg("warning", txt),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "\u2191\u2193 select \u2022 enter confirm \u2022 esc cancel"), 1, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  });

  if (!result) return;

  // Recursively call the router handler with the selected subcommand
  const handlerRef = routerHandlerRef;
  if (handlerRef) {
    await handlerRef(result, ctx);
  }
}

/**
 * Show interactive config submenu (when /router config is called without args)
 */
async function showConfigMenu(ctx: any, config: RouterConfig): Promise<void> {
  const items: SelectItem[] = [
    { value: "wizard", label: "wizard", description: "Interactive full configuration wizard" },
    { value: "order", label: "order", description: "Adjust existing model/channel order only" },
    { value: "show", label: "show", description: "Show current configuration" },
    { value: "reset", label: "reset", description: "Reset to default configuration" },
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("\u2554 Config")), 1, 1));
    container.addChild(new Text(theme.fg("dim", "\u2500".repeat(40)), 1, 0));

    const selectList = new SelectList(items, items.length, {
      selectedPrefix: (txt: string) => theme.fg("accent", txt),
      selectedText: (txt: string) => theme.fg("accent", txt),
      description: (txt: string) => theme.fg("muted", txt),
      scrollInfo: (txt: string) => theme.fg("dim", txt),
      noMatch: (txt: string) => theme.fg("warning", txt),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "\u2191\u2193 select \u2022 enter confirm \u2022 esc cancel"), 1, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  });

  if (!result) return;

  switch (result) {
    case "wizard":
      await runConfigWizard(
        ctx,
        () => getConfigurableModels(ctx.modelRegistry, true),
        groupModelsByChannels,
        saveConfig,
        calculateFileHash,
        getModelsJsonPath
      );
      break;
    case "order":
      await runConfigOrderWizard(
        ctx,
        config,
        () => getConfigurableModels(ctx.modelRegistry, true),
        saveConfig,
      );
      break;
    case "show":
      showCurrentConfig(ctx, config);
      break;
    case "reset": {
      const confirmed = await confirmReset(ctx);
      if (confirmed) {
        resetConfig();
        ctx.ui.notify("Config reset to defaults\n\nRun /router config wizard to reconfigure", "info");
      }
      break;
    }
  }
}

/**
 * Update footer status to show the active channel (real provider).
 *
 * This writes to the active UI immediately when available. Relying only on
 * turn_start misses mid-turn route changes and can leave the footer blank until
 * the next user turn.
 */
function getCurrentSessionHash(): string | undefined {
  return routerState.currentSessionHash;
}

function hashRouteSessionId(sessionId: unknown): string | undefined {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function getSessionHashFromManager(sessionManager: any): string | undefined {
  try {
    return hashRouteSessionId(sessionManager?.getSessionId?.());
  } catch {
    return undefined;
  }
}

function getRouteSnapshotKey(virtualModelId: string, sessionIdHash?: string): string {
  return `${sessionIdHash || "global"}:${virtualModelId}`;
}

function publishRouteSnapshot(snapshot: PiRouteSnapshot): void {
  routerState.activeRouteSnapshots.set(getRouteSnapshotKey(snapshot.virtualModelId, snapshot.sessionIdHash), snapshot);
  routerState.activeRouteSnapshots.set(getRouteSnapshotKey(snapshot.virtualModelId), snapshot);
  for (const listener of routerState.routeListeners) {
    try {
      listener(snapshot);
    } catch (err) {
      debugLog("[pi-router] Route listener failed:", err);
    }
  }
}

function findConfiguredModelById(config: RouterConfig, modelId: string): RouterModelConfig | undefined {
  return config.models?.find(model => model.id === modelId);
}

function buildRouteSnapshot(
  virtualModelId: string,
  canonicalModelId: string,
  upstreamModel: PiModel,
  status: PiRouteSnapshot["status"],
  sessionIdHash?: string,
  timestamp = Date.now()
): PiRouteSnapshot {
  return {
    virtualProvider: "router",
    virtualModelId,
    canonicalModelId,
    provider: upstreamModel.provider,
    modelId: upstreamModel.id,
    api: upstreamModel.api,
    routeLabel: upstreamModel.id === canonicalModelId
      ? `${upstreamModel.provider}/${upstreamModel.id}`
      : `${canonicalModelId} -> ${upstreamModel.provider}/${upstreamModel.id}`,
    status,
    sessionIdHash,
    timestamp,
  };
}

function updateRouteSnapshot(
  virtualModelId: string,
  canonicalModelId: string,
  upstreamModel: PiModel,
  status: PiRouteSnapshot["status"]
): void {
  publishRouteSnapshot(buildRouteSnapshot(
    virtualModelId,
    canonicalModelId,
    upstreamModel,
    status,
    getCurrentSessionHash(),
  ));
}

function ensureRoutingRegistry(): PiRoutingRegistryV1 {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[PI_ROUTING_REGISTRY] as PiRoutingRegistryV1 | undefined;
  if (existing?.version === 1 && typeof existing.registerRouter === "function" && typeof existing.getRouter === "function") {
    return existing;
  }

  const adapters = new Map<string, PiRouterAdapterV1>();
  const registry: PiRoutingRegistryV1 = {
    version: 1,
    registerRouter(adapter: PiRouterAdapterV1) {
      adapters.set(adapter.virtualProvider, adapter);
      return () => {
        if (adapters.get(adapter.virtualProvider) === adapter) {
          adapters.delete(adapter.virtualProvider);
        }
      };
    },
    getRouter(virtualProvider: string) {
      return adapters.get(virtualProvider);
    },
  };
  globalRecord[PI_ROUTING_REGISTRY] = registry;
  return registry;
}

function resolveActiveRouteSnapshot(virtualModelId: string, hint?: { sessionIdHash?: string; requestId?: string }): PiRouteSnapshot | undefined {
  const sessionIdHash = hint?.sessionIdHash || getCurrentSessionHash();
  return routerState.activeRouteSnapshots.get(getRouteSnapshotKey(virtualModelId, sessionIdHash))
    || routerState.activeRouteSnapshots.get(getRouteSnapshotKey(virtualModelId));
}

function resolveCandidateRouteSnapshots(virtualModelId: string): PiRouteSnapshot[] {
  const config = currentRouterConfig;
  if (!config) return [];

  const modelMap = getCachedModelMap(routerState.currentModelRegistry);
  const snapshots: PiRouteSnapshot[] = [];
  const appendSnapshot = (routerModelId: string, modelConfig: RouterModelConfig, routeEntry: RouterRouteEntry) => {
    const route = resolveConfiguredRouteByEntry(modelConfig, routeEntry, modelMap);
    if (!route) return;
    snapshots.push(buildRouteSnapshot(routerModelId, modelConfig.id, route.model, "planned", undefined, 0));
  };

  if (virtualModelId === "auto") {
    for (const modelConfig of config.models || []) {
      for (const routeEntry of getModelRouteEntries(modelConfig)) {
        appendSnapshot("auto", modelConfig, routeEntry);
      }
    }
    return snapshots;
  }

  const modelConfig = findConfiguredModelById(config, virtualModelId);
  if (!modelConfig) return [];
  for (const routeEntry of getModelRouteEntries(modelConfig)) {
    appendSnapshot(virtualModelId, modelConfig, routeEntry);
  }
  return snapshots;
}

function registerRoutingAdapter(): void {
  if (routerState.unregisterRoutingAdapter) return;

  const registry = ensureRoutingRegistry();
  routerState.unregisterRoutingAdapter = registry.registerRouter({
    virtualProvider: "router",
    resolveActiveRoute: resolveActiveRouteSnapshot,
    resolveCandidateRoutes: resolveCandidateRouteSnapshots,
    subscribe(listener) {
      routerState.routeListeners.add(listener);
      return () => routerState.routeListeners.delete(listener);
    },
  });
}

function readCacheHints(input: Parameters<PiCacheHintsV1["getHints"]>[0]): ReturnType<PiCacheHintsV1["getHints"]> {
  const service = (globalThis as Record<PropertyKey, unknown>)[PI_CACHE_HINTS] as PiCacheHintsV1 | undefined;
  if (service?.version !== 1 || typeof service.getHints !== "function") return undefined;
  try {
    return service.getHints(input);
  } catch (err) {
    debugLog("[pi-router] Cache hints lookup failed:", err);
    return undefined;
  }
}

function applyCacheHintsToRequest(
  context: Context,
  options: SimpleStreamOptions | undefined,
  model: PiModel,
  virtualModelId?: string
): { context: Context; options: SimpleStreamOptions | undefined } {
  const sessionIdHash = getCurrentSessionHash();
  const resolvedVirtualModelId = virtualModelId || (routerState.currentModelProvider === "router" ? routerState.currentModel?.id : undefined);
  const baseHintInput = {
    sessionIdHash,
    sessionId: sessionIdHash,
    virtualProvider: "router",
    virtualModelId: resolvedVirtualModelId,
  };
  // Prefer route-exact hints when the cache optimizer already knows the upstream
  // provider/model. On the first router turn, the optimizer may only know the
  // virtual router model during before_agent_start; retry with virtual-only input
  // so the optimized prompt/cache key still reaches the inner upstream request.
  const hints = readCacheHints({
    ...baseHintInput,
    upstreamProvider: model.provider,
    upstreamModelId: model.id,
    api: model.api,
  }) || readCacheHints(baseHintInput);

  if (!hints) return { context, options };

  const nextContext = hints.systemPrompt && hints.systemPrompt !== context.systemPrompt
    ? { ...context, systemPrompt: hints.systemPrompt }
    : context;
  const nextOptions: SimpleStreamOptions | undefined = options ? { ...options } : {};

  if (hints.promptCacheKey && !nextOptions.sessionId) {
    nextOptions.sessionId = hints.promptCacheKey;
  }
  if (hints.cacheRetention && !nextOptions.cacheRetention) {
    nextOptions.cacheRetention = hints.cacheRetention;
  }

  return {
    context: nextContext,
    options: Object.keys(nextOptions).length > 0 ? nextOptions : undefined,
  };
}

function updateFooterStatus(
  modelId: string,
  channel: string,
  actualModelId?: string,
  phase: RouterStatusPhase = "trying",
  attemptedChannels?: string[],
  error?: string,
  api?: string
): void {
  routerState.lastStatusUpdate = {
    modelId,
    channel,
    actualModelId,
    api,
    phase,
    attemptedChannels,
    error,
    timestamp: Date.now()
  };

  applyFooterStatus();
}

function formatRouteStatus(theme: any, status: NonNullable<RouterState["lastStatusUpdate"]>): string {
  const fg = (name: string, text: string) => theme?.fg ? theme.fg(name, text) : text;
  const at = fg("accent", "@");
  const channel = fg(status.phase === "failed" || status.phase === "aborted" ? "warning" : "success", status.channel);
  const phase = status.phase === "trying"
    ? fg("dim", "trying ")
    : status.phase === "failed"
      ? fg("warning", "failed ")
      : status.phase === "aborted"
        ? fg("warning", "aborted ")
        : status.phase === "fallback"
          ? fg("warning", "fallback ")
          : "";

  // Footer stays intentionally concise: only the current real model/channel.
  // Full attempted chains remain available in /router debug-footer, /router
  // decisions, and /router explain.
  const target = status.actualModelId
    ? `${status.actualModelId}${at}${channel}`
    : channel;

  return phase + target;
}

function formatFooterStatus(theme: any, status: NonNullable<RouterState["lastStatusUpdate"]>): string {
  const fg = (name: string, text: string) => theme?.fg ? theme.fg(name, text) : text;
  const arrow = fg("accent", "→");

  return fg("dim", `(router) ${status.modelId} ${arrow} `) + formatRouteStatus(theme, status);
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForRouterFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  const relativeToHome = path.relative(resolvedHome, resolvedCwd);
  const isInsideHome = relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${path.sep}${relativeToHome}`;
}

function sanitizeFooterStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatStatsLine(theme: any, width: number): string {
  const sessionManager = routerState.currentSessionManager;
  const model = routerState.currentModel;
  const getContextUsage = routerState.currentGetContextUsage;
  const modelRegistry = routerState.currentModelRegistry;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let latestCacheHitRate: number | undefined;

  for (const entry of sessionManager?.getEntries?.() ?? []) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const usage = entry.message.usage;
      if (!usage) continue;
      totalInput += usage.input || 0;
      totalOutput += usage.output || 0;
      totalCacheRead += usage.cacheRead || 0;
      totalCacheWrite += usage.cacheWrite || 0;
      totalCost += usage.cost?.total || 0;
      const latestPromptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      latestCacheHitRate = latestPromptTokens > 0 ? ((usage.cacheRead || 0) / latestPromptTokens) * 100 : undefined;
    }
  }

  const contextUsage = getContextUsage?.();
  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
    ? contextPercentValue.toFixed(1)
    : "?";

  const statsParts: string[] = [];
  if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
  if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
  if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
  if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
  if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
    statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }

  const usingSubscription = model ? !!modelRegistry?.isUsingOAuth?.(model) : false;
  if (totalCost || usingSubscription) {
    statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
  }

  const contextDisplay = contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
  if (contextPercentValue > 90) {
    statsParts.push(theme?.fg ? theme.fg("error", contextDisplay) : contextDisplay);
  } else if (contextPercentValue > 70) {
    statsParts.push(theme?.fg ? theme.fg("warning", contextDisplay) : contextDisplay);
  } else {
    statsParts.push(contextDisplay);
  }

  let statsLeft = statsParts.join(" ");
  if (visibleWidth(statsLeft) > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
  }

  return theme?.fg ? theme.fg("dim", statsLeft) : statsLeft;
}

function formatRightAlignedStatusLine(
  theme: any,
  width: number,
  leftStatus: string,
  rightStatus: string
): string | undefined {
  const left = sanitizeFooterStatusText(leftStatus);
  const right = sanitizeFooterStatusText(rightStatus);

  if (!left && !right) return undefined;
  if (!right) return truncateToWidth(left, width, theme?.fg ? theme.fg("dim", "...") : "...");
  if (!left) return " ".repeat(Math.max(0, width - visibleWidth(right))) + truncateToWidth(right, width, "");

  const leftWidth = visibleWidth(left);
  const minPadding = 2;

  // Preserve left-side extension statuses (e.g. cache optimizer). Router status
  // is secondary observability, so truncate it first when space is tight.
  if (leftWidth >= width - minPadding) {
    return truncateToWidth(left, width, theme?.fg ? theme.fg("dim", "...") : "...");
  }

  const availableForRight = width - leftWidth - minPadding;
  const clippedRight = visibleWidth(right) > availableForRight
    ? truncateToWidth(right, availableForRight, theme?.fg ? theme.fg("dim", "...") : "...")
    : right;
  const padding = " ".repeat(Math.max(minPadding, width - leftWidth - visibleWidth(clippedRight)));
  return left + padding + clippedRight;
}

function createRouterFooterComponent(_tui: any, theme: any, footerData: any) {
  const unsubscribe = footerData?.onBranchChange?.(() => _tui?.requestRender?.());

  return {
    dispose() {
      unsubscribe?.();
    },
    invalidate() {},
    render(width: number): string[] {
      const sessionManager = routerState.currentSessionManager;
      let pwd = formatCwdForRouterFooter(sessionManager?.getCwd?.() ?? process.cwd(), process.env.HOME || process.env.USERPROFILE);
      const branch = footerData?.getGitBranch?.();
      if (branch) pwd = `${pwd} (${branch})`;
      const sessionName = sessionManager?.getSessionName?.();
      if (sessionName) pwd = `${pwd} • ${sessionName}`;

      const statsLeft = formatStatsLine(theme, width);
      const status = routerState.lastStatusUpdate;
      const model = routerState.currentModel;
      const routeStatus = status && routerState.currentModelProvider === "router"
        ? formatRouteStatus(theme, status)
        : "";

      let modelText = model?.id || "no-model";
      if (model?.reasoning) {
        const thinkingLevel = routerState.currentThinkingLevel || "off";
        modelText = thinkingLevel === "off" ? `${modelText} • thinking off` : `${modelText} • ${thinkingLevel}`;
      }
      const modelPrefix = model?.provider ? `(${model.provider}) ${modelText}` : modelText;
      const rightText = modelPrefix;
      const rightWidth = visibleWidth(rightText);
      const statsLeftWidth = visibleWidth(statsLeft);

      let modelLine: string;
      if (statsLeftWidth + 2 + rightWidth <= width) {
        modelLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + rightText;
      } else {
        const availableForRight = width - statsLeftWidth - 2;
        if (availableForRight > 0) {
          const truncatedRight = truncateToWidth(rightText, availableForRight, "");
          modelLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
        } else {
          modelLine = statsLeft;
        }
      }

      const lines = [
        truncateToWidth(theme?.fg ? theme.fg("dim", pwd) : pwd, width, theme?.fg ? theme.fg("dim", "...") : "..."),
        truncateToWidth(modelLine, width, ""),
      ];

      const extensionStatuses = footerData?.getExtensionStatuses?.();
      if (extensionStatuses?.size > 0) {
        const statusEntries = Array.from(extensionStatuses.entries())
          .sort(([a], [b]) => String(a).localeCompare(String(b)));
        const leftStatuses = statusEntries
          .filter(([key]) => key !== "pi-router" && key !== "pi-router-right")
          .map(([, text]) => String(text))
          .join(" ");
        const rightAlignedRouterStatus = statusEntries.find(([key]) => key === "pi-router-right")?.[1];
        const statusLine = formatRightAlignedStatusLine(
          theme,
          width,
          leftStatuses,
          rightAlignedRouterStatus ? String(rightAlignedRouterStatus) : ""
        );
        if (statusLine) {
          lines.push(statusLine);
        }
      }

      return lines;
    },
  };
}

function refreshFooterContext(ctx: any, thinkingLevel?: string): void {
  routerState.currentUi = ctx.ui;
  routerState.currentTheme = ctx.ui?.theme;
  routerState.currentModel = ctx.model;
  routerState.currentModelProvider = ctx.model?.provider;
  routerState.currentThinkingLevel = thinkingLevel;
  routerState.currentSessionManager = ctx.sessionManager;
  routerState.currentSessionHash = getSessionHashFromManager(ctx.sessionManager);
  routerState.currentGetContextUsage = typeof ctx.getContextUsage === "function" ? () => ctx.getContextUsage() : undefined;
  routerState.currentModelRegistry = ctx.modelRegistry;
}

function ensureRouterFooterInstalled(): void {
  const ui = routerState.currentUi;
  if (!ui?.setFooter || routerState.customFooterInstalled || !routerState.customFooterEnabled) {
    return;
  }

  ui.setFooter(createRouterFooterComponent);
  routerState.customFooterInstalled = true;
  ui.setStatus?.("pi-router", undefined);
  ui.setStatus?.("pi-router-right", undefined);
}

function restoreDefaultFooter(): void {
  const ui = routerState.currentUi;
  if (!ui?.setFooter || !routerState.customFooterInstalled) {
    return;
  }

  ui.setFooter(undefined);
  routerState.customFooterInstalled = false;
  ui.setStatus?.("pi-router-right", undefined);
}

function applyFooterStatus(): void {
  const status = routerState.lastStatusUpdate;
  const ui = routerState.currentUi;

  if (!ui || !status || routerState.currentModelProvider !== "router") {
    restoreDefaultFooter();
    ui?.setStatus?.("pi-router", undefined);
    ui?.setStatus?.("pi-router-right", undefined);
    return;
  }

  // Be conservative: never install the replacement footer unless there is a
  // concrete router status to show. This avoids clobbering other extension
  // footer state during startup/reload.
  if (!status) return;

  ensureRouterFooterInstalled();

  if (routerState.customFooterInstalled) {
    ui.setStatus?.("pi-router", undefined);
    ui.setStatus?.("pi-router-right", status ? formatFooterStatus(routerState.currentTheme, status) : undefined);
    return;
  }

  if (routerState.footerStatusLineEnabled === false) {
    ui.setStatus?.("pi-router", undefined);
    ui.setStatus?.("pi-router-right", undefined);
    return;
  }

  if (ui.setStatus) {
    ui.setStatus("pi-router", formatFooterStatus(routerState.currentTheme, status));
    ui.setStatus("pi-router-right", undefined);
  }
}

/**
 * Reference to the router handler for menu re-dispatch
 */
let routerHandlerRef: ((args: string, ctx: any) => Promise<void>) | null = null;

/**
 * Main extension export
 *
 * Performance optimization: Lazy load models.json only when needed
 * Auto-sync check is deferred to first use or background (30s after startup)
 */
export default function (pi: ExtensionAPI) {
  const config = setCurrentRouterConfig(loadConfig());
  configFileMtimeMs = getFileMtimeMs(getRouterConfigPath());
  registerRoutingAdapter();

  // Check if we have configured models
  const hasConfiguredModels = config.models && config.models.length > 0;

  // Lazy loading: Only load models.json when needed
  let currentModels: PiModel[] | undefined;

  // Optimize: Only load models.json when absolutely necessary at startup
  const needsModelData = (
    // Auto-discovery is enabled and no models configured
    (config.auto && !hasConfiguredModels)
  );

  if (needsModelData) {
    // Load models.json only for auto-discovery
    currentModels = loadModelsJson();

    // Auto-discover models if enabled and no models configured
    if (config.auto && !hasConfiguredModels) {
      const groups = groupModelsByChannelsWithAliases(currentModels, config);
      const autoModels: RouterModelConfig[] = [];

      for (const [modelId, group] of groups.entries()) {
        if (group.channels.length > 1) {
          autoModels.push(createRouterModelConfigFromGroup(modelId, group));
        }
      }

      if (autoModels.length > 0) {
        debugLog(`[pi-router] Auto-discovered ${autoModels.length} multi-channel models`);
        config.models = autoModels;
        const modelsJsonHash = calculateFileHash(getModelsJsonPath());
        config.lastSyncHash = modelsJsonHash;
        saveConfig(config);
        autoSyncChecked = true; // Already checked during auto-discovery
      } else {
        debugLog("[pi-router] No multi-channel models found for auto-discovery");
      }
    }
  }

  // Early exit if no models configured
  if (!config.models || config.models.length === 0) {
    debugLog("[pi-router] No models configured. Create pi-router.json or enable auto-discovery.");
    return;
  }

  // Ensure models are loaded for registration
  if (!currentModels) {
    currentModels = loadModelsJson();
  }
  
  // Register router provider with mirror entries
  registerRouterProvider(pi, config, currentModels);
  
  // Defer health probes to avoid blocking startup
  if (config.healthProbe?.enabled) {
    // Start probes after a short delay to not block initialization
    setTimeout(() => {
      startHealthProbes(config);
    }, 1000);
  }
  
  debugLog("[pi-router] Extension loaded (v0.4.0)");
  debugLog("[pi-router] Strategy:", config.strategy ?? "channelFirst");
  debugLog("[pi-router] Configured models:", config.models?.length ?? 0);
  
  // By default pi-router owns the footer replacement when router status is
  // active. Users can opt out with footer.rightAlignRoute = false if another
  // extension should keep the built-in footer layout.
  routerState.customFooterEnabled = config.footer?.rightAlignRoute !== false;
  routerState.footerStatusLineEnabled = config.footer?.statusLine !== false;
  const updateFooterContext = (ctx: any) => {
    refreshFooterContext(ctx, typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined);
  };

  // Remember the active UI context so routing code can update the footer during
  // the same turn, not only at the next turn_start.
  pi.on("session_start", async (_event, ctx) => {
    updateFooterContext(ctx);
    applyFooterStatus();
  });

  pi.on("turn_start", async (_event, ctx) => {
    updateFooterContext(ctx);
    applyFooterStatus();
  });

  pi.on("message_update", async (_event, ctx) => {
    updateFooterContext(ctx);
    applyFooterStatus();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    refreshFooterContext(ctx, event.level);
    applyFooterStatus();
  });
  
  // Clear status when switching away from router models
  pi.on("model_select", async (event, ctx) => {
    updateFooterContext(ctx);
    routerState.currentModel = event.model;
    routerState.currentModelProvider = event.model.provider;
    if (event.model.provider !== "router") {
      restoreDefaultFooter();
      ctx.ui.setStatus("pi-router", undefined);
      ctx.ui.setStatus("pi-router-right", undefined);
    } else {
      applyFooterStatus();
    }
  });
  
  // Register /router command
  pi.registerCommand("router", {
    description: "pi-router operations (config, status, list, explain, decisions, probes, pricing, sync, diff, debug-footer)",
    getArgumentCompletions: (prefix: string) => {
      // Handle trailing space: user typed "config " then hit tab
      const hasTrailingSpace = prefix.endsWith(' ');
      const parts = prefix.trim().split(/\s+/).filter(Boolean);
      
      // First level: main subcommands (no input yet, or partial first word)
      if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
        const subcommands = [
          { value: "config", label: "config", description: "Configuration management" },
          { value: "status", label: "status", description: "Show router status" },
          { value: "list", label: "list", description: "List configured models" },
          { value: "explain", label: "explain", description: "Show failures, latency, health" },
          { value: "decisions", label: "decisions", description: "Show recent routing decisions" },
          { value: "probes", label: "probes", description: "Show background health probes" },
          { value: "pricing", label: "pricing", description: "Show per-channel pricing" },
          { value: "sync", label: "sync", description: "Check models.json changes" },
          { value: "diff", label: "diff", description: "Preview config differences" },
          { value: "sticky", label: "sticky", description: "View/clear sticky routing records" },
          { value: "debug-footer", label: "debug-footer (df)", description: "Debug footer display status" },
        ];
        
        const lowerPrefix = (parts[0] || '').toLowerCase();
        const filtered = subcommands.filter(cmd => cmd.value.startsWith(lowerPrefix));
        
        return filtered.length > 0 ? filtered : null;
      }
      
      // Second level: config subcommands
      // Triggered when: "config " (trailing space, parts[0]=config) or "config w" (parts.length=2)
      const firstCmd = parts[0].toLowerCase();
      if (firstCmd === 'config' || firstCmd === 'c') {
        const configSubcommands = [
          { value: "wizard", label: "wizard (w)", description: "Interactive full configuration wizard" },
          { value: "order", label: "order (o)", description: "Adjust existing model/channel order only" },
          { value: "show", label: "show (s)", description: "Show current configuration" },
          { value: "reset", label: "reset (r)", description: "Reset to default configuration" },
        ];
        
        const secondPart = (parts[1] || '').toLowerCase();
        const filtered = configSubcommands.filter(cmd => cmd.value.startsWith(secondPart));
        
        return filtered.length > 0 ? filtered : null;
      }
      
      return null;
    },
    handler: async (args: string, ctx: any) => {
      await routerHandler(args, ctx);
    },
  });
  
  // Store handler reference for menu re-dispatch
  routerHandlerRef = async (args: string, ctx: any) => {
    await routerHandler(args, ctx);
  };
  
  debugLog("[pi-router] /router command registered");

  // Background auto-sync check (30s after startup as fallback)
  // This ensures we catch changes even if user doesn't use router immediately
  setTimeout(() => {
    checkAutoSyncOnce();
  }, 30000);
}

/**
 * Router command handler implementation
 */
async function routerHandler(args: string, ctx: any): Promise<void> {
  const config = refreshConfigFromDisk();
  const trimmedArgs = args.trim();
  
  // If no args provided, show interactive menu
  if (!trimmedArgs) {
    await showRouterMenu(ctx, config);
    return;
  }
  
  const parts = trimmedArgs.toLowerCase().split(/\s+/);
  const subcommand = parts[0];
  
  // Config commands with shortcut support
  if (subcommand === "config" || subcommand === "c") {
    const configSubcmd = parts[1];
    
    // If no sub-command, show config menu
    if (!configSubcmd) {
      await showConfigMenu(ctx, config);
      return;
    }
    
    // Match shortcuts
    const matchedSubcmd = matchConfigSubcommand(configSubcmd);
    
    if (matchedSubcmd === "wizard") {
      // Run configuration wizard
      await runConfigWizard(
        ctx,
        () => getConfigurableModels(ctx.modelRegistry, true),
        groupModelsByChannels,
        saveConfig,
        calculateFileHash,
        getModelsJsonPath
      );
    } else if (matchedSubcmd === "order") {
      await runConfigOrderWizard(
        ctx,
        config,
        () => getConfigurableModels(ctx.modelRegistry, true),
        saveConfig,
      );
    } else if (matchedSubcmd === "show") {
      // Show current configuration
      showCurrentConfig(ctx, config);
    } else if (matchedSubcmd === "reset") {
      // Reset to default configuration
      const confirmed = await confirmReset(ctx);
      if (confirmed) {
        resetConfig();
        ctx.ui.notify("Config reset to defaults\n\nRun /router config wizard to reconfigure", "info");
      }
    } else {
      // Unknown config subcommand, show config menu
      await showConfigMenu(ctx, config);
    }
  } else if (subcommand === "status") {
    const modelCount = config.models?.length ?? 0;
    const strategy = config.strategy ?? "channelFirst";
    ctx.ui.notify(
      `pi-router status\n\n` +
      `Strategy: ${strategy}\n` +
      `Configured models: ${modelCount}\n` +
      `Auto-sync: ${config.autoSync !== false ? "enabled" : "disabled"}`,
      "info"
    );
  } else if (subcommand === "list") {
    const models = config.models || [];
    if (models.length === 0) {
      ctx.ui.notify("No models configured. Run '/router sync' to auto-discover.", "info");
    } else {
      const lines = models.map(m => `  ${m.id}: ${getModelRouteEntries(m).map(route => route.label).join(", ")}`);
      ctx.ui.notify(
        `Configured models (${models.length}):\n\n` + lines.join("\n"),
        "info"
      );
    }
  } else if (subcommand === "explain") {
    // Show failure history and router state
    const lines: string[] = ["Router State:", ""];
    
    // Active channels
    lines.push("Active Channels:");
    if (routerState.activeChannels.size === 0) {
      lines.push("  (none)");
    } else {
      for (const [modelId, channel] of routerState.activeChannels.entries()) {
        lines.push(`  ${modelId} \u2192 ${channel}`);
      }
    }
    lines.push("");
    
    // Cooldowns
    lines.push("Active Cooldowns:");
    const now = Date.now();
    let cooldownCount = 0;
    for (const [key, endTime] of routerState.cooldowns.entries()) {
      if (endTime > now) {
        const remainingMs = endTime - now;
        lines.push(`  ${key}: ${Math.ceil(remainingMs / 1000)}s remaining`);
        cooldownCount++;
      }
    }
    if (cooldownCount === 0) {
      lines.push("  (none)");
    }
    lines.push("");
    
    // Recent failures
    lines.push("Recent Failures (last 10):");
    let totalFailures = 0;
    for (const [modelId, failures] of routerState.lastFailures.entries()) {
      const recent = failures.slice(-10);
      totalFailures += recent.length;
      recent.forEach(f => {
        const ago = Math.floor((now - f.timestamp) / 1000);
        lines.push(`  ${modelId}@${f.channel} (${ago}s ago): ${f.error.substring(0, 60)}`);
      });
    }
    if (totalFailures === 0) {
      lines.push("  (none)");
    }
    lines.push("");
    
    // Latency stats
    lines.push("Channel Latency (avg last 10):");
    let latencyCount = 0;
    for (const [key, records] of latencyTracker.records.entries()) {
      if (records.length > 0) {
        const avg = records.reduce((sum, r) => sum + r.latencyMs, 0) / records.length;
        lines.push(`  ${key}: ${avg.toFixed(0)}ms (${records.length} samples)`);
        latencyCount++;
      }
    }
    if (latencyCount === 0) {
      lines.push("  (no data yet)");
    }
    lines.push("");
    
    // Health status
    lines.push("Channel Health:");
    let healthCount = 0;
    for (const [key, status] of healthChecker.status.entries()) {
      const statusStr = status.healthy ? "healthy" : "unhealthy";
      const failStr = status.consecutiveFailures > 0 ? ` (${status.consecutiveFailures} failures)` : "";
      const ago = Math.floor((now - status.lastCheck) / 1000);
      lines.push(`  ${key}: ${statusStr}${failStr} (checked ${ago}s ago)`);
      healthCount++;
    }
    if (healthCount === 0) {
      lines.push("  (no data yet)");
    }
    lines.push("");
    
    // Circuit breaker status
    lines.push("Circuit Breakers:");
    let circuitCount = 0;
    for (const [key, status] of circuitBreaker.circuits.entries()) {
      if (status.state !== "closed") {
        const retryIn = status.nextRetryTime > now ? Math.ceil((status.nextRetryTime - now) / 1000) : 0;
        lines.push(`  ${key}: ${status.state} (${status.failureCount} failures, retry in ${retryIn}s)`);
        circuitCount++;
      }
    }
    if (circuitCount === 0) {
      lines.push("  (all circuits closed)");
    }
    
    ctx.ui.notify(lines.join("\n"), "info");
  } else if (subcommand === "decisions") {
    // Show recent routing decisions
    const decisions = getRecentDecisions(20);
    const lines: string[] = ["Recent Routing Decisions (last 20):", ""];
    
    if (decisions.length === 0) {
      lines.push("  (no decisions yet)");
    } else {
      const now = Date.now();
      decisions.forEach(d => {
        const ago = Math.floor((now - d.timestamp) / 1000);
        const fallbackStr = d.fallbackUsed ? ` -> ${d.fallbackModel}` : "";
        const latencyStr = d.latencyMs ? ` (${d.latencyMs}ms)` : "";
        lines.push(`  ${d.modelId} -> ${d.selectedChannel}${fallbackStr}${latencyStr} (${ago}s ago)`);
        lines.push(`    Strategy: ${d.sortStrategy} | ${d.reason}`);
        if (d.attemptedChannels.length > 1) {
          lines.push(`    Tried: ${d.attemptedChannels.join(" -> ")}`);
        }
      });
    }
    
    ctx.ui.notify(lines.join("\n"), "info");
  } else if (subcommand === "probes") {
    // Show health probe results
    if (!healthProber.enabled) {
      ctx.ui.notify("Health probes are disabled.\n\nTo enable, add to config:\n{\n  \"healthProbe\": {\n    \"enabled\": true\n  }\n}", "info");
      return;
    }
    
    const probes = getHealthProbeResults();
    const lines: string[] = [
      `Background Health Probes (interval: ${Math.floor(healthProber.intervalMs / 1000)}s):`,
      ""
    ];
    
    if (probes.length === 0) {
      lines.push("  (no probes yet)");
    } else {
      const now = Date.now();
      probes.forEach(p => {
        const ago = Math.floor((now - p.timestamp) / 1000);
        const status = p.success ? "success" : "failed";
        const latencyStr = p.latencyMs ? ` (${p.latencyMs}ms)` : "";
        const errorStr = p.error ? ` - ${p.error}` : "";
        lines.push(`  ${p.channel}: ${status}${latencyStr} (${ago}s ago)${errorStr}`);
      });
    }
    
    ctx.ui.notify(lines.join("\n"), "info");
  } else if (subcommand === "pricing") {
    // Show pricing for all configured models
    const models = config.models || [];
    const lines: string[] = ["Channel Pricing (USD per 1M tokens):", ""];
    
    if (models.length === 0) {
      lines.push("  No models configured.");
    } else {
      for (const model of models) {
        lines.push(`${model.id}:`);
        
        for (const channel of model.channels) {
          const pricing = getChannelPricing(model.id, channel);
          
          if (!pricing) {
            lines.push(`  ${channel}: (no pricing data)`);
          } else if (pricing.input === 0 && pricing.output === 0) {
            lines.push(`  ${channel}: FREE (self-hosted)`);
          } else {
            const multiplier = CHANNEL_PRICING_MULTIPLIERS[channel] ?? 1.0;
            const markupStr = multiplier === 1.0 ? "" : ` (${multiplier}x)`;
            lines.push(`  ${channel}: in=$${pricing.input.toFixed(2)} out=$${pricing.output.toFixed(2)}${markupStr}`);
          }
        }
        
        lines.push("");
      }
      
      lines.push("Example cost (1000 in, 500 out tokens):");
      for (const model of models) {
        lines.push(`${model.id}:`);
        for (const channel of model.channels) {
          const cost = estimateRequestCost(model.id, channel, 1000, 500);
          const costStr = cost === 0 ? "FREE" : `$${cost.toFixed(6)}`;
          lines.push(`  ${channel}: ${costStr}`);
        }
        lines.push("");
      }
    }
    
    ctx.ui.notify(lines.join("\n"), "info");
  } else if (subcommand === "sync") {
    const syncParts = trimmedArgs.split(/\s+/);
    const action = syncParts[1]?.toLowerCase();
    
    if (action === "accept") {
      // Apply changes
      const currentModels = getSyncModels();
      const diff = detectModelChanges(config, currentModels);
      
      // Remove deleted models
      if (config.models) {
        config.models = config.models.filter(m => 
          !diff.removed.some(r => r.id === m.id)
        );
      } else {
        config.models = [];
      }
      
      const currentGroups = groupModelsByChannelsWithAliases(currentModels, config);

      // Add new models
      for (const added of diff.added) {
        const group = currentGroups.get(added.id);
        config.models.push(group
          ? createRouterModelConfigFromGroup(added.id, group)
          : { id: added.id, channels: added.channels }
        );
      }
      
      // Update modified models
      for (const modified of diff.modified) {
        const model = config.models.find(m => m.id === modified.id);
        const group = currentGroups.get(modified.id);
        if (model && group) {
          const existingRoutes = getModelRouteEntries(model);
          const groupRoutes = group.routes.map(route => ({
            channel: route.channel,
            upstreamModelId: route.model || model.id,
          }));
          const currentSignatures = new Set(groupRoutes.map(route => `${route.channel}\u0000${route.upstreamModelId}`));
          const mergedRoutes = [
            ...existingRoutes
              .filter(route => currentSignatures.has(`${route.channel}\u0000${route.upstreamModelId}`))
              .map(route => ({ channel: route.channel, upstreamModelId: route.upstreamModelId })),
            ...groupRoutes,
          ];
          const serialized = serializeRouteEntriesForConfig(model.id, mergedRoutes);
          model.channels = serialized.channels;
          if (serialized.modelByChannel) model.modelByChannel = serialized.modelByChannel;
          else delete model.modelByChannel;
          if (serialized.routes) model.routes = serialized.routes;
          else delete model.routes;
          model.aliases = [...new Set([...(model.aliases || []), ...group.aliases])];
          if (model.aliases.length === 0) {
            delete model.aliases;
          }
        }
      }
      
      // Update sync hash
      const modelsJsonHash = calculateFileHash(getModelsJsonPath(), true);
      config.lastSyncHash = modelsJsonHash;
      
      saveConfig(config);
      
      ctx.ui.notify(
        `Config updated successfully!\n\n` +
        `Added: ${diff.added.length}\n` +
        `Removed: ${diff.removed.length}\n` +
        `Modified: ${diff.modified.length}\n\n` +
        `Run '/reload' to apply changes`,
        "info"
      );
    } else {
      // Show diff
      const currentModels = getSyncModels();
      const diff = detectModelChanges(config, currentModels);
      const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0;
      
      if (!hasChanges) {
        ctx.ui.notify("No changes detected in models.json", "info");
      } else {
        const lines: string[] = [];
        
        if (diff.added.length > 0) {
          lines.push(`Added (${diff.added.length}):`);
          diff.added.forEach(m => lines.push(`  + ${m.id}: ${m.channels.join(", ")}`));
          lines.push("");
        }
        
        if (diff.removed.length > 0) {
          lines.push(`Removed (${diff.removed.length}):`);
          diff.removed.forEach(m => lines.push(`  - ${m.id}: ${m.channels.join(", ")}`));
          lines.push("");
        }
        
        if (diff.modified.length > 0) {
          lines.push(`Modified (${diff.modified.length}):`);
          diff.modified.forEach(m => {
            lines.push(`  ~ ${m.id}:`);
            if (m.channelsAdded.length > 0) {
              lines.push(`    + ${m.channelsAdded.join(", ")}`);
            }
            if (m.channelsRemoved.length > 0) {
              lines.push(`    - ${m.channelsRemoved.join(", ")}`);
            }
            if (m.propsChanged.length > 0) {
              lines.push(`    props: ${m.propsChanged.join(", ")}`);
            }
          });
        }
        
        lines.push("");
        lines.push("Run '/router sync accept' to apply changes");
        
        ctx.ui.notify(lines.join("\n"), "info");
      }
    }
  } else if (subcommand === "diff") {
    const currentModels = getSyncModels();
    const currentGroups = groupModelsByChannelsWithAliases(currentModels, config);
    const configModels = config.models || [];
    
    const lines: string[] = ["Config vs models.json:", ""];
    
    lines.push(`Config: ${configModels.length} models`);
    lines.push(`models.json: ${currentGroups.size} unique model IDs`);
    lines.push("");
    lines.push("Run '/router sync' to see detailed changes");
    
    ctx.ui.notify(lines.join("\n"), "info");
  } else if (subcommand === "sticky") {
    const stickyArg = parts[1];
    
    if (stickyArg === "clear") {
      const targetModel = parts[2];
      if (targetModel) {
        // Clear specific model's sticky
        if (config.stickyRecords?.[targetModel]) {
          delete config.stickyRecords[targetModel];
          saveConfig(config);
          ctx.ui.notify(`Sticky record cleared for ${targetModel}`, "info");
        } else {
          ctx.ui.notify(`No sticky record found for ${targetModel}`, "info");
        }
      } else {
        // Clear all sticky records
        config.stickyRecords = {};
        saveConfig(config);
        ctx.ui.notify("All sticky records cleared.\nNext request will route from the beginning.", "info");
      }
    } else {
      // Show sticky status
      const records = config.stickyRecords || {};
      const keys = Object.keys(records);
      
      if (keys.length === 0) {
        ctx.ui.notify("No sticky records.\nRouting will start from the beginning of the chain.", "info");
      } else {
        const lines: string[] = ["Sticky Routing Records:", ""];
        const now = Date.now();
        
        for (const key of keys) {
          const rec = records[key];
          const ago = Math.floor((now - rec.lastSuccess) / 1000);
          lines.push(`  ${key}:`);
          lines.push(`    Route: ${rec.modelId}@${rec.channel}`);
          lines.push(`    Success count: ${rec.successCount}`);
          lines.push(`    Last success: ${ago}s ago`);
          lines.push("");
        }
        
        lines.push("Run '/router sticky clear' to reset all");
        lines.push("Run '/router sticky clear <modelId>' to reset specific");
        
        ctx.ui.notify(lines.join("\n"), "info");
      }
    }
  } else if (subcommand === "debug-footer" || subcommand === "df") {
    // Debug footer display status
    const status = routerState.lastStatusUpdate;
    const lines: string[] = ["Footer Debug Information", "━".repeat(40), ""];

    // Router state
    lines.push("Router State:");
    if (status) {
      lines.push(`  modelId: ${status.modelId}`);
      lines.push(`  channel: ${status.channel}`);
      lines.push(`  actualModelId: ${status.actualModelId || "(none)"}`);
      lines.push(`  phase: ${status.phase}`);
      lines.push(`  attemptedChannels: ${status.attemptedChannels?.join(" -> ") || "(none)"}`);
      if (status.error) {
        lines.push(`  error: ${status.error}`);
      }
      lines.push(`  timestamp: ${new Date(status.timestamp).toISOString()}`);
    } else {
      lines.push("  (no status recorded yet)");
    }
    lines.push("");

    // Current context
    lines.push("Current Context:");
    lines.push(`  model.provider: ${ctx.model?.provider || "(none)"}`);
    lines.push(`  model.id: ${ctx.model?.id || "(none)"}`);
    lines.push("");

    // Expected footer
    if (status && ctx.model?.provider === "router") {
      lines.push("Expected Footer:");
      lines.push(`  ${formatFooterStatus({ fg: (_name: string, text: string) => text }, status)}`);
      lines.push("");
      lines.push("Status: ✓ Footer should be displayed");
    } else {
      lines.push("Expected Footer:");
      lines.push("  (not displayed)");
      lines.push("");
      if (!status) {
        lines.push("Status: ✗ No routing has occurred yet");
      } else if (ctx.model?.provider !== "router") {
        lines.push("Status: ✗ Current model is not a router model");
        lines.push(`  Current provider: ${ctx.model?.provider}`);
      }
    }

    ctx.ui.notify(lines.join("\n"), "info");
  } else {
    ctx.ui.notify(
      "pi-router v0.4.0\n\n" +
      "Commands:\n" +
      "  /router config    - Configuration management\n" +
      "  /router status    - Show router status\n" +
      "  /router list      - List configured models\n" +
      "  /router explain   - Show failures, latency, health\n" +
      "  /router decisions - Show recent routing decisions\n" +
      "  /router probes    - Show background health probes\n" +
      "  /router pricing   - Show per-channel pricing\n" +
      "  /router sync      - Check models.json changes\n" +
      "  /router diff      - Preview config differences\n" +
      "  /router sticky    - View/clear sticky routing records\n" +
      "\nTip: Run /router without args to open interactive menu",
      "info"
    );
  }
}

/**
 * Generate context summary for model switching
 * 
 * @param messages - Conversation history
 * @param fromModel - Source model that failed
 * @param toModel - Target fallback model
 * @param summaryModel - Model to use for generating summary (defaults to target model when not configured)
 * @param promptTemplate - Custom summary prompt
 * @param summaryMaxTokens - Target upper bound for summary output size
 */
async function generateContextSummary(
  messages: any[],
  fromModel: PiModel,
  toModel: PiModel,
  summaryModel: PiModel,
  promptTemplate: string,
  summaryMaxTokens: number,
  config?: RouterConfig
): Promise<SummaryResult> {
  // Build conversation context (outside try block so it's accessible in catch)
  const conversationText = messages
    .map((m, idx) => {
      const role = m.role || "unknown";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${idx + 1}] ${role}: ${content}`;
    })
    .join("\n\n");
  
  const summaryPrompt = `${promptTemplate}

Keep the final summary under approximately ${summaryMaxTokens} tokens unless preserving a critical detail requires less compression.

---

Conversation to summarize:

${conversationText}

---

Provide the summary now:`;
  
  try {
    debugLog("[pi-router] Generating context summary...");
    debugLog(`[pi-router] From: ${fromModel.id}@${fromModel.provider}`);
    debugLog(`[pi-router] To: ${toModel.id}@${toModel.provider}`);
    debugLog(`[pi-router] Using summary model: ${summaryModel.id}@${summaryModel.provider}`);

    const summaryContext: Context = {
      messages: [
        {
          role: "user",
          content: summaryPrompt,
          timestamp: Date.now(),
        },
      ],
    };

    const result = await generateSummaryWithModel(summaryModel, summaryPrompt, summaryMaxTokens, config, summaryContext);
    debugLog(`[pi-router] Summary generated: ${result.summary?.length || 0} chars, ${result.tokensUsed || 0} tokens`);
    return result;
  } catch (err) {
    debugLog("[pi-router] Failed to generate summary with summaryModel:", err);

    const isSameAsTarget = summaryModel.id === toModel.id && summaryModel.provider === toModel.provider;
    if (!isSameAsTarget) {
      debugLog("[pi-router] Trying fallback: use target model for summary...");
      
      // Fallback strategy 1: Try using the target model (toModel) itself
      try {
        const targetModelResult = await generateSummaryWithModel(toModel, summaryPrompt, summaryMaxTokens, config);
        debugLog(`[pi-router] Summary generated with target model: ${targetModelResult.summary?.length || 0} chars`);
        return targetModelResult;
      } catch (fallbackErr) {
        debugLog("[pi-router] Target model also failed:", fallbackErr);
      }
    }

    debugLog("[pi-router] Using simple text-based summary (no AI)...");
    
    // Fallback strategy 2: Simple text-based summary (no AI required)
    const simpleSummary = generateSimpleTextSummary(messages, fromModel, toModel);
    
    return {
      success: false,
      summary: simpleSummary,
      tokensUsed: 0,
      error: String(err),
    };
  }
}

async function collectTextResponseFromModel(
  model: PiModel,
  context: Context,
  maxTokens: number,
  config?: RouterConfig
): Promise<{ text: string; tokensUsed: number }> {
  const requestOptions: SimpleStreamOptions | undefined = maxTokens > 0
    ? { maxTokens }
    : undefined;
  const stream = forwardToProvider(model, context, requestOptions, config, undefined, false);

  let text = "";
  let tokensUsed = 0;

  for await (const event of stream) {
    const failure = getStreamEventFailure(event);
    if (failure) {
      throw new Error(failure);
    }

    if (event.type === "text_delta") {
      text += event.delta;
    } else if (event.type === "text_end" && !text && event.content) {
      text += event.content;
    } else if (event.type === "done") {
      const usage = event.message?.usage;
      tokensUsed = usage?.output ?? usage?.totalTokens ?? Math.ceil(text.length / 4);
    }
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Summary generation returned empty response");
  }

  return {
    text: trimmed,
    tokensUsed: tokensUsed || Math.ceil(trimmed.length / 4),
  };
}

/**
 * Helper function to generate summary using a specific model
 */
async function generateSummaryWithModel(
  model: PiModel,
  summaryPrompt: string,
  summaryMaxTokens: number,
  config?: RouterConfig,
  summaryContext?: Context,
): Promise<SummaryResult> {
  const context = summaryContext || {
    messages: [
      {
        role: "user",
        content: summaryPrompt,
        timestamp: Date.now(),
      },
    ],
  };

  const result = await collectTextResponseFromModel(model, context, summaryMaxTokens, config);

  return {
    success: true,
    summary: result.text,
    tokensUsed: result.tokensUsed,
  };
}

/**
 * Generate simple text-based summary (no AI required)
 * 
 * This is the ultimate fallback when no AI model is available.
 * Extracts key information from the conversation without using AI.
 */
function estimateContextTokens(context: any): number {
  const systemPrompt = typeof context?.systemPrompt === "string" ? context.systemPrompt : "";
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const raw = [
    systemPrompt,
    ...messages.map((m: any) => {
      const role = m?.role || "unknown";
      const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      return `${role}: ${content}`;
    }),
  ].join("\n\n");

  return Math.ceil(raw.length / 4);
}

function shouldSummarizeForTarget(context: any, targetModel: PiModel): boolean {
  const targetWindow = targetModel.contextWindow || 0;
  if (targetWindow <= 0) {
    return true;
  }
  return estimateContextTokens(context) > targetWindow;
}

function generateSimpleTextSummary(
  messages: any[],
  fromModel: PiModel,
  toModel: PiModel
): string {
  const userMessages = messages.filter(m => m.role === "user");
  const assistantMessages = messages.filter(m => m.role === "assistant");
  
  // Extract last user message (current task)
  const lastUserMessage = userMessages[userMessages.length - 1];
  const lastUserContent = lastUserMessage
    ? (typeof lastUserMessage.content === "string"
        ? lastUserMessage.content
        : JSON.stringify(lastUserMessage.content))
    : "(no user message)";
  
  // Truncate if too long
  const truncatedContent = lastUserContent.length > 500
    ? lastUserContent.substring(0, 500) + "..."
    : lastUserContent;
  
  // Build simple summary
  const lines = [
    "[Context Transfer Summary - Simple Mode]",
    "",
    `Switching from: ${fromModel.id}@${fromModel.provider}`,
    `Switching to: ${toModel.id}@${toModel.provider}`,
    `Conversation: ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant)`,
    "",
    "Latest user request:",
    truncatedContent,
    "",
    "Note: AI-powered summary unavailable. This is a basic text extraction.",
  ];
  
  return lines.join("\n");
}

/**
 * Sanitize context for model switch
 * 
 * @param context - Original context
 * @param fromModel - Source model
 * @param toModel - Target model
 * @param transferStrategy - How to transfer context
 * @param summary - Generated summary (if strategy is 'summary')
 */
function sanitizeContextForSwitch(
  context: any,
  fromModel: PiModel,
  toModel: PiModel,
  transferStrategy: ContextTransferStrategy,
  summary?: string
): any {
  const sanitized = { ...context };
  
  // Strategy: none - minimal context, just system prompt
  if (transferStrategy === "none") {
    sanitized.messages = [];
    if (summary) {
      sanitized.systemPrompt = `${context.systemPrompt || ""}

[Model switched: ${fromModel.id} → ${toModel.id}]
${summary}`;
    }
    return sanitized;
  }
  
  // Strategy: summary - replace conversation with summary
  if (transferStrategy === "summary" && summary) {
    sanitized.messages = [
      {
        role: "user",
        content: summary,
      },
    ];
    return sanitized;
  }
  
  // Strategy: full - transfer all messages (default)
  // But still need to handle compat differences
  
  // 1. Handle context window constraints
  if (toModel.contextWindow && fromModel.contextWindow) {
    if (toModel.contextWindow < fromModel.contextWindow) {
      // Truncate to fit target model
      const ratio = toModel.contextWindow / fromModel.contextWindow;
      const keepCount = Math.floor((sanitized.messages?.length || 0) * ratio);
      if (sanitized.messages && sanitized.messages.length > keepCount) {
        sanitized.messages = sanitized.messages.slice(-keepCount);
        debugLog(`[pi-router] Truncated context: ${sanitized.messages.length} messages kept`);
      }
    }
  }
  
  // 2. Handle developer role compatibility
  if (sanitized.messages && !toModel.compat?.supportsDeveloperRole) {
    sanitized.messages = sanitized.messages.map((m: any) => {
      if (m.role === "developer") {
        return { ...m, role: "system" };
      }
      return m;
    });
  }
  
  // 3. Handle reasoning/thinking compatibility
  if (fromModel.reasoning && !toModel.reasoning) {
    // Remove thinking-related fields
    delete sanitized.thinkingLevel;
    delete sanitized.thinkingLevelMap;
  }
  
  return sanitized;
}

/**
 * Router state for tracking active channels and cooldowns
 */
type RouterStatusPhase = "trying" | "success" | "failed" | "fallback" | "aborted";

type RouterState = {
  activeChannels: Map<string, string>;  // modelId -> current active channel
  cooldowns: Map<string, number>;  // "modelId@channel" -> cooldown end timestamp
  lastFailures: Map<string, { channel: string; error: string; timestamp: number }[]>;  // modelId -> failure history
  currentUi?: any;
  currentTheme?: any;
  currentModel?: any;
  currentModelProvider?: string;
  currentThinkingLevel?: string;
  currentSessionManager?: any;
  currentSessionHash?: string;
  currentRouterModelId?: string;
  currentGetContextUsage?: (() => { tokens: number | null; contextWindow: number; percent: number | null } | undefined);
  currentModelRegistry?: any;
  customFooterInstalled?: boolean;
  customFooterEnabled?: boolean;
  footerStatusLineEnabled?: boolean;
  lastStatusUpdate?: {
    modelId: string;           // router model ID (e.g., "claude-fable-5" or "auto")
    channel: string;           // actual channel used (e.g., "lan")
    actualModelId?: string;    // actual upstream model ID when it differs or auto/fallback mode is active
    api?: string;
    phase: RouterStatusPhase;
    attemptedChannels?: string[];
    error?: string;
    timestamp: number;
  };  // last active routing info
  activeRouteSnapshots: Map<string, PiRouteSnapshot>; // route key -> latest route snapshot
  routeListeners: Set<(event: PiRouteSnapshot) => void>;
  unregisterRoutingAdapter?: () => void;
};

const routerState: RouterState = {
  activeChannels: new Map(),
  cooldowns: new Map(),
  lastFailures: new Map(),
  activeRouteSnapshots: new Map(),
  routeListeners: new Set(),
};

// FIX #1, #10: Cache modelMap to avoid rebuilding on every request
let cachedModelMap: Map<string, PiModel> | null = null;
let cachedModelMapTimestamp = 0;
let cachedModelMapRegistryRef: any = null;
let cachedModelMapModelsMtime: number | null = null;
let cachedModelMapAuthMtime: number | null = null;

/**
 * Get or build modelMap with caching
 * FIX #1, #10: Cache modelMap and invalidate on config/registry changes
 */
function getCachedModelMap(modelRegistry?: any): Map<string, PiModel> {
  const now = Date.now();
  const modelsMtime = getFileMtimeMs(getModelsJsonPath());
  const authMtime = getFileMtimeMs(path.join(getPiConfigDir(), "auth.json"));

  const shouldRebuild = !cachedModelMap ||
    cachedModelMapRegistryRef !== modelRegistry ||
    cachedModelMapModelsMtime !== modelsMtime ||
    cachedModelMapAuthMtime !== authMtime ||
    (now - cachedModelMapTimestamp > CACHE_TTL);

  if (shouldRebuild) {
    cachedModelMap = buildModelMap(getEffectiveModels(modelRegistry));
    cachedModelMapTimestamp = now;
    cachedModelMapRegistryRef = modelRegistry;
    cachedModelMapModelsMtime = modelsMtime;
    cachedModelMapAuthMtime = authMtime;
    debugLog("[pi-router] Rebuilt modelMap cache");
  }

  return cachedModelMap;
}

/**
 * FIX #9, #14: Use first configured channel, not first available
 * This preserves user's explicit failover order
 */
function findFirstConfiguredModel(
  configModel: RouterModelConfig,
  modelMap: Map<string, PiModel>
): { channel: string; routeKey: string; model: PiModel; upstreamId: string } | undefined {
  // Try configured routes in order. This preserves duplicate same-provider routes
  // such as `wx-api` and `wx-api (oc/deepseek-v4-flash-free)`.
  for (const routeEntry of getModelRouteEntries(configModel)) {
    const route = resolveConfiguredRouteByEntry(configModel, routeEntry, modelMap);
    if (route) {
      return { channel: route.channel, routeKey: route.routeKey, model: route.model, upstreamId: route.upstreamId };
    }
  }
  return undefined;
}

function createMirrorModels(
  configuredModels: RouterModelConfig[],
  modelMap: Map<string, PiModel>
): any[] {
  const mirrorModels: any[] = [];

  // Add the special "router" meta-model (auto mode)
  // FIX #14: Use first configured model (not first available) for defaults
  const firstConfigModel = configuredModels[0];
  const firstConfigured = firstConfigModel ? findFirstConfiguredModel(firstConfigModel, modelMap) : undefined;
  const firstPrimaryModel = firstConfigured?.model;
  
  if (firstPrimaryModel) {
    mirrorModels.push({
      id: "auto",
      name: "Auto Router",
      // Must be the router provider API so pi-ai dispatches to pi-router's
      // custom streamSimple handler. The real upstream API comes from modelMap.
      api: ROUTER_API,
      reasoning: firstPrimaryModel.reasoning,
      input: firstPrimaryModel.input,
      contextWindow: firstPrimaryModel.contextWindow,
      maxTokens: firstPrimaryModel.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: firstPrimaryModel.compat,
      thinkingLevelMap: firstPrimaryModel.thinkingLevelMap,
    });
    debugLog(`[pi-router] Registered router/auto (auto mode) with ${configuredModels.length} models in chain`);
  }
  
  for (const configModel of configuredModels) {
    // FIX #14: Use first configured channel for primary model
    const primary = findFirstConfiguredModel(configModel, modelMap);
    const primaryModel = primary?.model;

    if (!primaryModel) {
      console.warn(`[pi-router] No available model found for configured router/${configModel.id}`);
      continue;
    }
    
    // Create mirror model with router provider
    mirrorModels.push({
      id: configModel.id,
      name: `${primaryModel.name} (router)`,
      // Must be the router provider API so pi-ai dispatches to pi-router's
      // custom streamSimple handler. The real upstream API comes from modelMap.
      api: ROUTER_API,
      reasoning: primaryModel.reasoning,
      input: primaryModel.input,
      contextWindow: primaryModel.contextWindow,
      maxTokens: primaryModel.maxTokens,
      cost: primaryModel.cost,
      compat: primaryModel.compat,
      thinkingLevelMap: primaryModel.thinkingLevelMap,
    });
    
    debugLog(`[pi-router] Configured router/${configModel.id} with ${configModel.channels.length} channels`);
  }
  
  return mirrorModels;
}

/**
 * Register router provider with mirror entries for configured models
 */
function registerRouterProvider(
  pi: ExtensionAPI,
  config: RouterConfig,
  allModels: PiModel[]
): void {
  const configuredModels = config.models || [];

  if (configuredModels.length === 0) {
    debugLog("[pi-router] No models configured, skipping provider registration");
    return;
  }

  // Build a map of all available real models by id@provider.
  const modelMap = buildModelMap(allModels);

  const mirrorModels = createMirrorModels(configuredModels, modelMap);

  if (mirrorModels.length === 0) {
    console.warn("[pi-router] No valid mirror models created");
    return;
  }
  
  // Register with custom streamSimple handler
  pi.registerProvider("router", {
    api: ROUTER_API,
    baseUrl: "https://router.internal",  // Dummy URL for custom provider
    apiKey: "router",  // Dummy API key for custom provider
    models: mirrorModels,
    streamSimple: (model: any, context: any, options?: any) => {
      // Get the latest config if it changed on disk.
      const currentConfig = refreshConfigFromDisk();

      // Check auto-sync on first use (if not already checked)
      checkAutoSyncOnce();

      return routeRequest(
        model,
        context,
        options,
        currentConfig,
        // FIX #1, #10, #15: Use cached modelMap instead of rebuilding on every request
        getCachedModelMap(routerState.currentModelRegistry),
      );
    },
  });
  
  debugLog(`[pi-router] Registered ${mirrorModels.length} router models`);
}

/**
 * Auto mode routing: try all configured models in order based on strategy
 * With sticky support: if a previous successful route is recorded, try it first.
 */
function routeAutoMode(
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>
): AssistantMessageEventStream {
  const configuredModels = config.models || [];
  
  if (configuredModels.length === 0) {
    throw new Error("[pi-router] Auto mode requires at least one configured model");
  }
  
  debugLog(`[pi-router] Auto mode: trying ${configuredModels.length} models`);
  
  // Check sticky record first
  const stickyRecord = config.stickyRecords?.["auto"];
  if (stickyRecord && config.sticky !== false) {
    debugLog(`[pi-router] Auto mode: sticky hint ${stickyRecord.modelId}@${stickyRecord.channel}`);
  }
  
  const strategy = config.strategy || "channelFirst";

  if (strategy === "channelFirst") {
    return routeAutoChannelFirst(context, options, config, modelMap, configuredModels, stickyRecord);
  } else if (strategy === "custom") {
    return routeAutoCustom(context, options, config, modelMap, stickyRecord);
  } else {
    // Fallback for unknown strategy
    return routeAutoChannelFirst(context, options, config, modelMap, configuredModels, stickyRecord);
  }
}

/**
 * Check if a channel can be attempted (cooldown + circuit breaker)
 */
function getRouteStateKey(modelId: string, routeKey: string): string {
  return `${modelId}@${routeKey}`;
}

function canTryAutoChannel(modelId: string, channel: string, routeKey = channel): boolean {
  const key = getRouteStateKey(modelId, routeKey);
  
  // Check cooldown
  const cooldownEnd = routerState.cooldowns.get(key);
  if (cooldownEnd && Date.now() < cooldownEnd) {
    return false;
  }
  
  // Check circuit breaker
  return canAttemptChannel(modelId, routeKey);
}

/**
 * Update sticky record on successful route
 */
function updateStickyRecord(routerModelId: string, modelId: string, channel: string, config: RouterConfig, routeKey = channel, upstreamModelId?: string): void {
  if (config.sticky === false) return;
  
  if (!config.stickyRecords) {
    config.stickyRecords = {};
  }
  
  const existing = config.stickyRecords[routerModelId];
  const now = Date.now();
  
  if (existing && existing.modelId === modelId && existing.channel === channel && (existing.routeKey || existing.channel) === routeKey) {
    // Same route, increment success count
    existing.successCount++;
    existing.lastSuccess = now;
    existing.lastUpdate = now;
    existing.routeKey = routeKey;
    existing.upstreamModelId = upstreamModelId;
  } else {
    // New route
    config.stickyRecords[routerModelId] = {
      modelId,
      channel,
      routeKey,
      upstreamModelId,
      successCount: 1,
      lastSuccess: now,
      lastUpdate: now,
    };
  }
  
  // Debounced save (write at most once every 5 seconds)
  scheduleStickyPersist(config);
}

/**
 * Clear sticky record on failure
 */
function clearStickyRecord(routerModelId: string, config: RouterConfig): void {
  if (config.stickyRecords?.[routerModelId]) {
    delete config.stickyRecords[routerModelId];
    scheduleStickyPersist(config);
  }
}

let stickyPersistTimer: NodeJS.Timeout | null = null;

function scheduleStickyPersist(config: RouterConfig): void {
  if (stickyPersistTimer) return;
  stickyPersistTimer = setTimeout(() => {
    stickyPersistTimer = null;
    saveConfig(config);
    debugLog("[pi-router] Sticky records persisted");
  }, 5000);
}

async function relayAutoAttempt(
  routerModelId: string,
  modelConfig: RouterModelConfig,
  route: ResolvedModelRoute,
  reason: string,
  sortStrategy: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  eventStream: AssistantMessageEventStream,
  attemptedRoutes: string[],
  attemptedChannels: string[]
): Promise<boolean> {
  const channel = route.channel;
  const targetModel = route.model;
  const canonicalKey = `${modelConfig.id}@${channel}`;
  const upstreamKey = `${targetModel.id}@${channel}`;
  const displayKey = upstreamKey === canonicalKey ? canonicalKey : `${canonicalKey} -> ${upstreamKey}`;
  attemptedRoutes.push(displayKey);
  attemptedChannels.push(route.routeLabel);
  updateRouteSnapshot(routerModelId, modelConfig.id, targetModel, "trying");
  updateFooterStatus(routerModelId, channel, targetModel.id, "trying", [...attemptedChannels], undefined, targetModel.api);

  let stream: AssistantMessageEventStream;
  try {
    stream = forwardToProvider(targetModel, context, options, config, routerModelId);
  } catch (err) {
    const error = getErrorMessage(err);
    const aborted = isAbortError(error) || isAbortSignalAborted(options);
    debugLog(`[pi-router] Auto mode failed to start ${displayKey}:`, err);

    updateRouteSnapshot(routerModelId, modelConfig.id, targetModel, "failed");
    if (aborted) {
      updateFooterStatus(routerModelId, channel, targetModel.id, "aborted", [...attemptedChannels], error, targetModel.api);
      eventStream.push(createRouterErrorEvent(routerModelId, "router", ROUTER_API, error, "aborted"));
      eventStream.end();
      return true;
    }

    recordFailure(modelConfig.id, route.routeKey, error, config, modelConfig);
    updateHealthStatus(modelConfig.id, route.routeKey, false);
    recordCircuitOutcome(modelConfig.id, route.routeKey, false);
    updateFooterStatus(routerModelId, channel, targetModel.id, "failed", [...attemptedChannels], error, targetModel.api);
    return false;
  }

  logDecision({
    timestamp: Date.now(),
    modelId: "auto (router)",
    selectedChannel: displayKey,
    attemptedChannels: [...attemptedRoutes],
    sortStrategy,
    fallbackUsed: false,
    reason,
  });

  const streamStartTime = Date.now();
  const relayResult = await relayProviderStream(
    stream,
    eventStream,
    options,
    config,
    () => {
      const latency = Date.now() - streamStartTime;
      recordLatency(modelConfig.id, route.routeKey, latency);
      updateHealthStatus(modelConfig.id, route.routeKey, true);
      recordCircuitOutcome(modelConfig.id, route.routeKey, true);
      routerState.activeChannels.set(routerModelId, route.routeKey);
      updateStickyRecord(routerModelId, modelConfig.id, channel, config, route.routeKey, route.upstreamId);
      updateRouteSnapshot(routerModelId, modelConfig.id, targetModel, "success");
      updateFooterStatus(routerModelId, channel, targetModel.id, "success", [...attemptedChannels], undefined, targetModel.api);
    }
  );

  if (relayResult.ok) {
    eventStream.end();
    return true;
  }

  const failedRelayResult = relayResult as Extract<RelayProviderStreamResult, { ok: false }>;
  const { error, aborted, committed } = failedRelayResult;
  debugLog(`[pi-router] Auto mode failed on ${displayKey}:`, error);

  updateRouteSnapshot(routerModelId, modelConfig.id, targetModel, "failed");
  if (aborted) {
    updateFooterStatus(routerModelId, channel, targetModel.id, "aborted", [...attemptedChannels], error, targetModel.api);
    eventStream.push(createRouterErrorEvent(routerModelId, "router", ROUTER_API, error, "aborted"));
    eventStream.end();
    return true;
  }

  if (committed) {
    updateFooterStatus(routerModelId, channel, targetModel.id, "failed", [...attemptedChannels], error, targetModel.api);
    eventStream.push(createRouterErrorEvent(routerModelId, "router", ROUTER_API, formatUserFacingFailure(error)));
    eventStream.end();
    return true;
  }

  recordFailure(modelConfig.id, route.routeKey, error, config, modelConfig);
  updateHealthStatus(modelConfig.id, route.routeKey, false);
  recordCircuitOutcome(modelConfig.id, route.routeKey, false);
  updateFooterStatus(routerModelId, channel, targetModel.id, "failed", [...attemptedChannels], error, targetModel.api);
  return false;
}

/**
 * Auto mode with channelFirst strategy
 */
function routeAutoChannelFirst(
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>,
  configuredModels: RouterModelConfig[],
  stickyRecord: StickyRecord | undefined
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();
  const attemptedRoutes: string[] = [];
  const attemptedChannels: string[] = [];
  
  (async () => {
    try {
      // Try sticky route first if available
      if (stickyRecord) {
        const stickyKey = `${stickyRecord.modelId}@${stickyRecord.routeKey || stickyRecord.channel}`;
        const stickyModelConfig = configuredModels.find(m => m.id === stickyRecord.modelId);
        const stickyRoute = stickyModelConfig
          ? resolveConfiguredRouteByKey(stickyModelConfig, stickyRecord.routeKey || stickyRecord.channel, modelMap)
          : undefined;
        
        if (stickyRoute && stickyModelConfig && canTryAutoChannel(stickyRecord.modelId, stickyRoute.channel, stickyRoute.routeKey)) {
          debugLog(`[pi-router] Auto mode: trying sticky ${stickyKey}`);
          const ok = await relayAutoAttempt(
            "auto",
            stickyModelConfig,
            stickyRoute,
            "sticky route",
            config.sortBy || "manual",
            context,
            options,
            config,
            eventStream,
            attemptedRoutes,
            attemptedChannels
          );
          if (ok) return;
          debugLog(`[pi-router] Auto mode: sticky ${stickyKey} failed, falling back`);
          clearStickyRecord("auto", config);
        } else {
          debugLog(`[pi-router] Auto mode: sticky model unavailable, clearing`);
          clearStickyRecord("auto", config);
        }
      }
      
      // Normal channel-first routing
      for (const modelConfig of configuredModels) {
        debugLog(`[pi-router] Auto mode trying model: ${modelConfig.id}`);
        
        const routeOrder = determineRouteOrder(modelConfig.id, modelConfig, config);
        
        for (const routeEntry of routeOrder) {
          const key = `${modelConfig.id}@${routeEntry.routeKey}`;
          const route = resolveConfiguredRouteByEntry(modelConfig, routeEntry, modelMap);

          if (!route) {
            debugLog(`[pi-router] Auto mode: ${key} not found in modelMap`);
            continue;
          }

          if (!canTryAutoChannel(modelConfig.id, route.channel, route.routeKey)) {
            debugLog(`[pi-router] Auto mode: ${key} skipped (cooldown or circuit breaker)`);
            continue;
          }

          debugLog(`[pi-router] Auto mode attempting ${key}...`);
          const ok = await relayAutoAttempt(
            "auto",
            modelConfig,
            route,
            "auto mode (channelFirst)",
            config.sortBy || "manual",
            context,
            options,
            config,
            eventStream,
            attemptedRoutes,
            attemptedChannels
          );
          if (ok) return;
        }
      }

      const failures = Array.from(routerState.lastFailures.values()).flat().slice(-Math.max(1, attemptedRoutes.length));
      const errorMsg = [
        `[pi-router] Auto router failed: all configured routes were exhausted.`,
        attemptedRoutes.length > 0 ? `Tried routes: ${attemptedRoutes.join(" → ")}` : "Tried routes: none",
        failures.length > 0 ? "Recent failures:\n" + failures.map((f, i) => `  ${i + 1}. ${f.channel}: ${formatUserFacingFailure(f.error)}`).join("\n") : "Recent failures: none recorded",
        "Run '/router explain' for detailed diagnostics.",
      ].join("\n");
      debugLog(errorMsg);
      eventStream.push(createRouterErrorEvent("auto", "router", ROUTER_API, errorMsg));
      eventStream.end();
    } catch (err) {
      const error = getErrorMessage(err);
      debugLog("[pi-router] Auto mode error:", err);
      eventStream.push(createRouterErrorEvent("auto", "router", ROUTER_API, formatUserFacingFailure(error)));
      eventStream.end();
    }
  })();
  
  return eventStream;
}

/**
 * Auto mode with custom strategy - uses customOrder array
 */
function getCustomRouteOrder(config: RouterConfig): RouterCustomRouteConfig[] {
  if (Array.isArray(config.customRoutes) && config.customRoutes.length > 0) {
    return config.customRoutes.filter(route => !!route?.model && !!route?.channel);
  }

  return (config.customOrder || []).flatMap((item) => {
    if (!item || typeof item !== "string" || !item.includes("@")) return [];
    const parts = item.split("@");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return [];
    const [channel, upstreamModel] = parts[1].split("#");
    return [{ model: parts[0], channel, ...(upstreamModel ? { upstreamModel } : {}) }];
  });
}

function routeAutoCustom(
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>,
  stickyRecord: StickyRecord | undefined
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();
  const attemptedRoutes: string[] = [];
  const attemptedChannels: string[] = [];

  (async () => {
    try {
      const customRoutes = getCustomRouteOrder(config);
      if (customRoutes.length === 0) {
        const errorMsg = "[pi-router] Custom strategy requires customOrder or customRoutes array";
        debugLog(errorMsg);
        eventStream.push(createRouterErrorEvent("auto", "router", ROUTER_API, errorMsg));
        eventStream.end();
        return;
      }

      // Try sticky route first if available
      if (stickyRecord) {
        const stickyKey = `${stickyRecord.modelId}@${stickyRecord.routeKey || stickyRecord.channel}`;
        const stickyModelConfig = config.models?.find(m => m.id === stickyRecord.modelId);
        const stickyRoute = stickyModelConfig
          ? resolveConfiguredRouteByKey(stickyModelConfig, stickyRecord.routeKey || stickyRecord.channel, modelMap)
          : undefined;

        if (stickyRoute && stickyModelConfig && canTryAutoChannel(stickyRecord.modelId, stickyRoute.channel, stickyRoute.routeKey)) {
          debugLog(`[pi-router] Auto mode: trying sticky ${stickyKey}`);
          const ok = await relayAutoAttempt(
            "auto",
            stickyModelConfig,
            stickyRoute,
            "sticky route",
            "custom",
            context,
            options,
            config,
            eventStream,
            attemptedRoutes,
            attemptedChannels
          );
          if (ok) return;
          debugLog(`[pi-router] Auto mode: sticky ${stickyKey} failed, falling back`);
          clearStickyRecord("auto", config);
        } else {
          debugLog(`[pi-router] Auto mode: sticky model unavailable, clearing`);
          clearStickyRecord("auto", config);
        }
      }

      // Try routes in custom order
      for (const customRoute of customRoutes) {
        const modelId = customRoute.model;
        const channel = customRoute.channel;
        const key = customRoute.upstreamModel ? `${modelId}@${channel}#${customRoute.upstreamModel}` : `${modelId}@${channel}`;
        const modelConfig = config.models?.find(m => m.id === modelId) || { id: modelId, channels: [channel] };
        const routeEntry: RouterRouteEntry = {
          modelId,
          channel,
          upstreamModelId: customRoute.upstreamModel || modelConfig.modelByChannel?.[channel] || modelId,
          routeKey: makeRouteKey(channel, customRoute.upstreamModel || modelConfig.modelByChannel?.[channel], modelId),
          label: channel,
          explicitModel: !!customRoute.upstreamModel || !!modelConfig.modelByChannel?.[channel],
        };
        routeEntry.label = getRouteDisplayLabel(routeEntry);
        const route = resolveConfiguredRouteByEntry(modelConfig, routeEntry, modelMap);

        if (!route) {
          debugLog(`[pi-router] Auto mode: ${key} not found in modelMap`);
          continue;
        }

        if (!canTryAutoChannel(modelId, route.channel, route.routeKey)) {
          debugLog(`[pi-router] Auto mode: ${key} skipped (cooldown or circuit breaker)`);
          continue;
        }

        debugLog(`[pi-router] Auto mode attempting ${key}...`);
        const ok = await relayAutoAttempt(
          "auto",
          modelConfig,
          route,
          "auto mode (custom order)",
          "custom",
          context,
          options,
          config,
          eventStream,
          attemptedRoutes,
          attemptedChannels
        );
        if (ok) return;
      }

      const failures = Array.from(routerState.lastFailures.values()).flat().slice(-Math.max(1, attemptedRoutes.length));
      const errorMsg = [
        `[pi-router] Auto router failed: all custom routes were exhausted.`,
        attemptedRoutes.length > 0 ? `Tried routes: ${attemptedRoutes.join(" → ")}` : "Tried routes: none",
        failures.length > 0 ? "Recent failures:\n" + failures.map((f, i) => `  ${i + 1}. ${f.channel}: ${formatUserFacingFailure(f.error)}`).join("\n") : "Recent failures: none recorded",
        "Run '/router explain' for detailed diagnostics.",
      ].join("\n");
      debugLog(errorMsg);
      eventStream.push(createRouterErrorEvent("auto", "router", ROUTER_API, errorMsg));
      eventStream.end();
    } catch (err) {
      const error = getErrorMessage(err);
      debugLog("[pi-router] Auto mode error:", err);
      eventStream.push(createRouterErrorEvent("auto", "router", ROUTER_API, formatUserFacingFailure(error)));
      eventStream.end();
    }
  })();

  return eventStream;
}

/**
 * Route request through configured channels with failover
 */
function routeRequest(
  routerModel: any,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>
): AssistantMessageEventStream {
  const modelId = routerModel.id;
  routerState.currentRouterModelId = modelId;
  
  // Special handling for "auto" meta-model (auto mode)
  if (modelId === "auto") {
    return routeAutoMode(context, options, config, modelMap);
  }
  
  const modelConfig = config.models?.find(m => m.id === modelId);
  
  if (!modelConfig) {
    throw new Error(`[pi-router] No configuration found for ${modelId}`);
  }

  debugLog(`[pi-router] Routing request for ${modelId}`);
  debugLog(`[pi-router] Available channels: ${modelConfig.channels.join(", ")}`);
  
  // Determine channel order based on strategy
  const channelOrder = determineChannelOrder(modelId, modelConfig, config);
  
  debugLog(`[pi-router] Channel order: ${channelOrder.join(" → ")}`);
  
  // Create a wrapper stream that tries channels in order
  return createFailoverStream(
    modelId,
    channelOrder,
    context,
    options,
    config,
    modelConfig,
    modelMap
  );
}

/**
 * Determine channel order based on strategy and config
 */
function determineRouteOrder(
  modelId: string,
  modelConfig: RouterModelConfig,
  config: RouterConfig
): RouterRouteEntry[] {
  const routes = [...getModelRouteEntries(modelConfig)];

  // If sticky mode and we have an active route, try it first. activeChannels
  // stores a routeKey for new configs and a channel name for legacy configs.
  if (modelConfig.sticky !== false && config.sticky !== false) {
    const activeRouteKey = routerState.activeChannels.get(modelId);
    const activeRoute = routes.find(route => route.routeKey === activeRouteKey || route.channel === activeRouteKey);
    if (activeRoute) {
      const activeSignature = getRouteSignature(activeRoute);
      return [activeRoute, ...routes.filter(route => getRouteSignature(route) !== activeSignature)];
    }
  }

  const sortBy = modelConfig.sortBy || config.sortBy || "config";
  if (sortBy === "latency") {
    return sortRoutesByLatency(modelId, routes);
  }
  if (sortBy === "cost" || sortBy === "costFirst") {
    return sortRoutesByCost(modelId, routes);
  }
  if (sortBy === "capabilityFirst") {
    return routes;
  }
  return routes;
}

function routeEntriesFromOrder(modelConfig: RouterModelConfig, order: string[]): RouterRouteEntry[] {
  const configuredRoutes = getModelRouteEntries(modelConfig);
  const consumed = new Set<string>();
  const result: RouterRouteEntry[] = [];

  const takeRoute = (key: string): RouterRouteEntry | undefined => {
    const exact = configuredRoutes.find(route => !consumed.has(getRouteSignature(route)) && route.routeKey === key);
    if (exact) return exact;
    return configuredRoutes.find(route => !consumed.has(getRouteSignature(route)) && route.channel === key);
  };

  for (const key of order) {
    const route = takeRoute(key);
    if (route) {
      consumed.add(getRouteSignature(route));
      result.push(route);
      continue;
    }

    const fallback: RouterRouteEntry = {
      modelId: modelConfig.id,
      channel: key,
      upstreamModelId: modelConfig.modelByChannel?.[key] || modelConfig.id,
      routeKey: makeRouteKey(key, modelConfig.modelByChannel?.[key], modelConfig.id),
      label: key,
      explicitModel: !!modelConfig.modelByChannel?.[key],
    };
    fallback.label = getRouteDisplayLabel(fallback);
    result.push(fallback);
  }

  return result;
}

function determineChannelOrder(
  modelId: string,
  modelConfig: RouterModelConfig,
  config: RouterConfig
): string[] {
  return determineRouteOrder(modelId, modelConfig, config).map(route => route.routeKey);
}

function sortRoutesByCost(modelId: string, routes: RouterRouteEntry[]): RouterRouteEntry[] {
  return [...routes].sort((a, b) => {
    const aPricing = getChannelPricing(modelId, a.channel);
    const bPricing = getChannelPricing(modelId, b.channel);
    const aCost = aPricing ? estimateRequestCost(modelId, a.channel, 1000, 500, 0, 0) : Infinity;
    const bCost = bPricing ? estimateRequestCost(modelId, b.channel, 1000, 500, 0, 0) : Infinity;
    return aCost - bCost;
  });
}

function sortRoutesByLatency(modelId: string, routes: RouterRouteEntry[]): RouterRouteEntry[] {
  return [...routes].sort((a, b) => (getAverageLatency(modelId, a.routeKey) ?? Infinity) - (getAverageLatency(modelId, b.routeKey) ?? Infinity));
}

/**
 * Forward request to actual provider's streamSimple
 */
function createRouterErrorMessage(
  modelId: string,
  provider: string,
  api: Api,
  error: string,
  stopReason: "error" | "aborted" = "error"
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider,
    model: modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: error,
    timestamp: Date.now(),
  };
}

function createRouterErrorEvent(
  modelId: string,
  provider: string,
  api: Api,
  error: string,
  stopReason: "error" | "aborted" = "error"
): AssistantMessageEvent {
  return {
    type: "error",
    reason: stopReason,
    error: createRouterErrorMessage(modelId, provider, api, error, stopReason),
  };
}

function getStreamEventFailure(event: AssistantMessageEvent): string | undefined {
  if (event.type !== "error") return undefined;

  const errorMessage = event.error.errorMessage;
  if (typeof errorMessage === "string" && errorMessage.trim().length > 0) {
    return errorMessage;
  }

  return "Provider stream returned an error event";
}

function isResponseCommitEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "done":
    case "toolcall_start":
    case "toolcall_end":
      return true;
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return !!event.delta;
    case "text_end":
      return !!event.content;
    case "thinking_end":
      return !!event.content;
    default:
      return false;
  }
}

async function nextStreamEventWithTimeout(
  iterator: AsyncIterator<AssistantMessageEvent>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<IteratorResult<AssistantMessageEvent>> {
  if (signal?.aborted) {
    throw new Error("Request was aborted");
  }

  let timeout: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  try {
    return await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          reject(new Error(`Router attempt timed out after ${timeoutMs}ms waiting for provider stream`));
        }, timeoutMs);
      }

      abortHandler = () => reject(new Error("Request was aborted"));
      signal?.addEventListener("abort", abortHandler, { once: true });

      iterator.next().then(resolve, reject);
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

function getRouterTimeoutMs(
  options: SimpleStreamOptions | undefined,
  config?: RouterConfig
): number {
  if (config?.request?.timeoutMs !== undefined) {
    return config.request.timeoutMs;
  }

  // pi may pass a global/provider timeout (often 10s) into custom providers.
  // That is too aggressive for router failover: it makes every real channel,
  // including official providers, fail before they can emit the first token.
  // Treat it as a ceiling only when it is more generous than the router default.
  const incomingTimeoutMs = options?.timeoutMs;
  if (incomingTimeoutMs !== undefined && incomingTimeoutMs > DEFAULT_ROUTER_TIMEOUT_MS) {
    return incomingTimeoutMs;
  }

  return DEFAULT_ROUTER_TIMEOUT_MS;
}

type RelayProviderStreamResult =
  | { ok: true }
  | { ok: false; error: string; aborted: boolean; committed: boolean };

const providerStreamAborters = new WeakMap<AssistantMessageEventStream, () => void>();

function abortProviderStream(stream: AssistantMessageEventStream): void {
  providerStreamAborters.get(stream)?.();
}

function createLinkedAbortController(signal?: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  let abortHandler: (() => void) | undefined;

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      abortHandler = () => controller.abort();
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  return {
    controller,
    cleanup: () => {
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    },
  };
}

async function relayProviderStream(
  stream: AssistantMessageEventStream,
  outputStream: AssistantMessageEventStream,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig | undefined,
  onCommit: () => void
): Promise<RelayProviderStreamResult> {
  const iterator = stream[Symbol.asyncIterator]();
  const bufferedEvents: AssistantMessageEvent[] = [];
  const timeoutMs = getRouterTimeoutMs(options, config);
  let committed = false;
  let terminalPushed = false;

  try {
    while (true) {
      const result = await nextStreamEventWithTimeout(iterator, timeoutMs, options?.signal);
      if (result.done) {
        if (terminalPushed) {
          return { ok: true };
        }
        throw new Error(committed
          ? "Provider stream ended before final message"
          : "Provider stream ended before producing a response");
      }

      const event = result.value;
      const failure = getStreamEventFailure(event);
      if (failure) {
        throw new Error(failure);
      }

      if (!committed) {
        if (isResponseCommitEvent(event)) {
          onCommit();
          committed = true;
          for (const bufferedEvent of bufferedEvents) {
            outputStream.push(bufferedEvent);
          }
          bufferedEvents.length = 0;
          outputStream.push(event);
        } else {
          bufferedEvents.push(event);
        }
      } else {
        outputStream.push(event);
      }

      if (event.type === "done") {
        terminalPushed = true;
      }
    }
  } catch (err) {
    abortProviderStream(stream);
    const error = getErrorMessage(err);
    return {
      ok: false,
      error,
      aborted: isAbortError(error) || isAbortSignalAborted(options),
      committed,
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("aborted") || lower.includes("aborterror") || lower.includes("the operation was aborted");
}

function isAbortSignalAborted(options: SimpleStreamOptions | undefined): boolean {
  return !!options?.signal?.aborted;
}

function formatUserFacingFailure(error: string): string {
  const text = error || "";
  const lower = text.toLowerCase();
  const code = text.match(/(?:^|\D)(401|403|408|409|429|500|502|503|504)(?:\D|$)/)?.[1];

  if (code === "401" || lower.includes("invalid token") || lower.includes("invalid api key") || text.includes("无效的令牌")) {
    return "认证失败（401/token 无效）";
  }
  if (code === "403" || lower.includes("forbidden") || lower.includes("blocked")) {
    return lower.includes("blocked") ? "请求被平台拦截（403）" : "请求被拒绝（403）";
  }
  if (code === "429" || lower.includes("rate limit") || lower.includes("too many requests")) {
    return "触发限流（429）";
  }
  if (lower.includes("router attempt timed out")) {
    return "等待首个响应超时";
  }
  if (code === "408" || lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return "上游请求超时";
  }
  if (lower.includes("connection error") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("connect")) {
    return "连接失败";
  }
  if (code && code.startsWith("5")) {
    return `上游服务错误（${code}）`;
  }

  return "上游返回错误（详见 /router explain）";
}

function formatUserFacingFailureList(failures: Array<{ channel: string; error: string }>): string[] {
  return failures.map(f => `  • ${f.channel}: ${formatUserFacingFailure(f.error)}`);
}

function toPiAiModel(model: PiModel): Model<Api> {
  return {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider,
    api: (model.api || "openai-completions") as Api,
    baseUrl: model.baseUrl || "",
    headers: model.headers,
    reasoning: model.reasoning || false,
    input: (model.input || ["text"]) as ("text" | "image")[],
    contextWindow: model.contextWindow || 200000,
    maxTokens: model.maxTokens || 16384,
    cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}
  
async function applyUpstreamRequestAuth(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): Promise<SimpleStreamOptions | undefined> {
  const nextOptions: SimpleStreamOptions | undefined = options ? { ...options } : undefined;

  if (nextOptions?.apiKey === ROUTER_DUMMY_API_KEY) {
    // pi authenticates the selected router/* model before entering our custom
    // streamSimple, so options.apiKey is the router provider's dummy key. If we
    // forward it, pi-ai will prefer that explicit key over the real upstream
    // provider auth and every channel fails with 401 (often visible as
    // "api key: ****uter"). Drop it before resolving real upstream auth.
    delete nextOptions.apiKey;
  }

  const modelRegistry = routerState.currentModelRegistry;
  if (!modelRegistry?.getApiKeyAndHeaders) {
    return nextOptions;
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error || `No API key found for "${model.provider}"`);
  }

  const headers = auth.headers || nextOptions?.headers
    ? { ...auth.headers, ...nextOptions?.headers }
    : undefined;

  return {
    ...nextOptions,
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(headers ? { headers } : {}),
  };
}

function forwardToProvider(
  model: PiModel,
  context: Context,
  options?: SimpleStreamOptions,
  config?: RouterConfig,
  virtualModelId?: string,
  useCacheHints = true
): AssistantMessageEventStream {
  const realModel = toPiAiModel(model);
  const hintedRequest = useCacheHints
    ? applyCacheHintsToRequest(context, options, model, virtualModelId)
    : { context, options };
  const routedOptions = applyRouterRequestOptions(hintedRequest.options, config);
  const eventStream = createAssistantMessageEventStream();
  const linkedAbort = createLinkedAbortController(routedOptions?.signal);
  providerStreamAborters.set(eventStream, () => linkedAbort.controller.abort());

  (async () => {
    try {
      if (linkedAbort.controller.signal.aborted) {
        eventStream.push(createRouterErrorEvent(model.id, model.provider, realModel.api, "Request was aborted", "aborted"));
        eventStream.end();
        return;
      }

      const upstreamOptions = await applyUpstreamRequestAuth(realModel, routedOptions);
      const providerOptions = upstreamOptions
        ? { ...upstreamOptions, signal: linkedAbort.controller.signal }
        : { signal: linkedAbort.controller.signal };
      // Do not pass pi/router timeoutMs into the provider SDK. Some SDKs apply it
      // as a hard request timer and still surface the generic "Request timed out."
      // message, which makes slow first-token models (DeepSeek reasoning variants)
      // look dead after the outer 10s provider timeout. pi-router enforces the
      // per-attempt timeout in relayProviderStream and aborts this upstream request
      // itself when moving to the next channel.
      delete providerOptions.timeoutMs;
      debugLog(`[pi-router] Forwarding to ${model.provider} streamSimple`);

      const upstreamStream = streamSimple(realModel, hintedRequest.context, providerOptions);
      for await (const event of upstreamStream) {
        eventStream.push(event);
      }
      eventStream.end();
    } catch (err) {
      const error = getErrorMessage(err);
      const stopReason = isAbortError(error) || linkedAbort.controller.signal.aborted ? "aborted" : "error";
      debugLog(`[pi-router] Upstream ${model.id}@${model.provider} failed:`, err);
      eventStream.push(createRouterErrorEvent(model.id, model.provider, realModel.api, error, stopReason));
      eventStream.end();
    } finally {
      providerStreamAborters.delete(eventStream);
      linkedAbort.cleanup();
    }
  })();

  return eventStream;
}

function applyRouterRequestOptions(
  options: SimpleStreamOptions | undefined,
  config?: RouterConfig
): SimpleStreamOptions | undefined {
  if (!config) return options;

  const routedOptions: SimpleStreamOptions = {
    ...options,
    // pi may pass provider-level retries into streamSimple. pi-router owns
    // retries/failover, so default the provider client to fail fast and let the
    // next configured channel run. Users can opt back in via request.maxRetries.
    maxRetries: config.request?.maxRetries ?? 0,
    // Avoid hanging indefinitely on an upstream stream that never produces an
    // event. Users can override with request.timeoutMs.
    timeoutMs: getRouterTimeoutMs(options, config),
  };

  const configuredMaxTokens = config.request?.maxTokens;
  const incomingMaxTokens = options?.maxTokens;
  const maxTokens = configuredMaxTokens ?? (
    incomingMaxTokens === undefined
      ? undefined
      : Math.min(incomingMaxTokens, DEFAULT_ROUTER_MAX_TOKENS)
  );
  if (maxTokens !== undefined && maxTokens > 0) {
    routedOptions.maxTokens = maxTokens;
  }

  if (routedOptions.timeoutMs !== undefined && routedOptions.timeoutMs <= 0) {
    delete routedOptions.timeoutMs;
  }

  if (!routedOptions.signal && options?.signal) {
    routedOptions.signal = options.signal;
  }

  if (config.request?.maxRetryDelayMs !== undefined) {
    routedOptions.maxRetryDelayMs = config.request.maxRetryDelayMs;
  }

  return routedOptions;
}

/**
 * Create a failover stream that tries channels in order
 */
function createFailoverStream(
  modelId: string,
  channelOrder: string[],
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelConfig: RouterModelConfig,
  modelMap: Map<string, PiModel>
): AssistantMessageEventStream {
  let currentChannelIndex = 0;
  let attemptedChannels: string[] = [];
  const sortStrategy = modelConfig.sortBy || config.sortBy || "config";
  const eventStream = createAssistantMessageEventStream();
  const routeOrder = routeEntriesFromOrder(modelConfig, channelOrder);
  
  const tryNextChannel = (): { channel: string; route: ResolvedModelRoute; targetModel: PiModel; routeDisplay: string; stream: AssistantMessageEventStream } | null => {
    while (currentChannelIndex < routeOrder.length) {
      const routeEntry = routeOrder[currentChannelIndex];
      currentChannelIndex++;
      const channel = routeEntry.channel;
      const key = getRouteStateKey(modelId, routeEntry.routeKey);
      
      // Check cooldown
      const cooldownEnd = routerState.cooldowns.get(key);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        const remainingMs = cooldownEnd - Date.now();
        debugLog(`[pi-router] Route ${routeEntry.label} in cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`);
        continue;
      }
      
      // Check circuit breaker
      if (!canAttemptChannel(modelId, routeEntry.routeKey)) {
        debugLog(`[pi-router] Circuit breaker open for ${routeEntry.label}, skipping`);
        continue;
      }
      
      const route = resolveConfiguredRouteByEntry(modelConfig, routeEntry, modelMap);
      const targetModel = route?.model;
      if (!route || !targetModel) {
        debugLog(`[pi-router] Model not found: ${key}`);
        continue;
      }
      const routeDisplay = targetModel.id === modelId ? route.routeLabel : `${channel} -> ${targetModel.id}`;
      
      debugLog(`[pi-router] Attempting ${routeDisplay}...`);
      attemptedChannels.push(route.routeLabel);
      updateRouteSnapshot(modelId, modelConfig.id, targetModel, "trying");
      updateFooterStatus(modelId, channel, targetModel.id, "trying", [...attemptedChannels], undefined, targetModel.api);

      try {
        const stream = forwardToProvider(targetModel, context, options, config, modelId);
        debugLog(`[pi-router] Started stream on ${targetModel.id}@${channel}`);

        logDecision({
          timestamp: Date.now(),
          modelId,
          selectedChannel: routeDisplay,
          attemptedChannels: [...attemptedChannels],
          sortStrategy,
          fallbackUsed: false,
          reason: attemptedChannels.length === 1 ? "first choice" : `failover after ${attemptedChannels.length - 1} failures`,
        });

        return { channel, route, targetModel, routeDisplay, stream };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        debugLog(`[pi-router] Failed to start stream on ${routeDisplay}:`, err);
        updateRouteSnapshot(modelId, modelConfig.id, targetModel, "failed");
        recordFailure(modelId, route.routeKey, error, config, modelConfig);
        updateHealthStatus(modelId, route.routeKey, false);
        recordCircuitOutcome(modelId, route.routeKey, false);
        updateFooterStatus(modelId, channel, targetModel.id, "failed", [...attemptedChannels], error, targetModel.api);
      }
    }
    
    return null;
  };
  
  const relayAttempt = async (
    route: ResolvedModelRoute,
    routeDisplay: string,
    stream: AssistantMessageEventStream
  ): Promise<RelayProviderStreamResult> => {
    const channel = route.channel;
    const targetModel = route.model;
    const streamStartTime = Date.now();
    return relayProviderStream(
      stream,
      eventStream,
      options,
      config,
      () => {
        const latency = Date.now() - streamStartTime;
        recordLatency(modelId, route.routeKey, latency);
        updateHealthStatus(modelId, route.routeKey, true);
        recordCircuitOutcome(modelId, route.routeKey, true);
        routerState.activeChannels.set(modelId, route.routeKey);
        updateRouteSnapshot(modelId, modelConfig.id, targetModel, "success");
        updateFooterStatus(modelId, channel, targetModel.id, "success", [...attemptedChannels], undefined, targetModel.api);
  
        const lastDecision = decisionLogger.decisions[decisionLogger.decisions.length - 1];
        if (lastDecision?.modelId === modelId && lastDecision.selectedChannel === routeDisplay) {
          lastDecision.latencyMs = latency;
        }
      }
    );
  };
  
  (async () => {
    while (true) {
      const attempt = tryNextChannel();
    
      if (!attempt) {
        await tryModelFallback(
          modelId,
          context,
          options,
          config,
          modelConfig,
          modelMap,
          eventStream
        );
        return;
      }
      
      const relayResult = await relayAttempt(attempt.route, attempt.routeDisplay, attempt.stream);
      if (relayResult.ok) {
        eventStream.end();
        return;
      }
      
      const { error, aborted, committed } = relayResult as Extract<RelayProviderStreamResult, { ok: false }>;
      debugLog(`[pi-router] Stream error on ${attempt.routeDisplay}:`, error);

      updateRouteSnapshot(modelId, modelConfig.id, attempt.targetModel, "failed");
      if (aborted) {
        updateFooterStatus(modelId, attempt.channel, attempt.targetModel.id, "aborted", [...attemptedChannels], error, attempt.targetModel.api);
        eventStream.push(createRouterErrorEvent(modelId, "router", ROUTER_API, error, "aborted"));
        eventStream.end();
        return;
      }

      if (committed) {
        updateFooterStatus(modelId, attempt.channel, attempt.targetModel.id, "failed", [...attemptedChannels], error, attempt.targetModel.api);
        eventStream.push(createRouterErrorEvent(modelId, "router", ROUTER_API, formatUserFacingFailure(error)));
        eventStream.end();
        return;
      }

      recordFailure(modelId, attempt.route.routeKey, error, config, modelConfig);
      updateHealthStatus(modelId, attempt.route.routeKey, false);
      recordCircuitOutcome(modelId, attempt.route.routeKey, false);
      updateFooterStatus(modelId, attempt.channel, attempt.targetModel.id, "failed", [...attemptedChannels], error, attempt.targetModel.api);
    }
  })().catch((err) => {
    const error = err instanceof Error ? err.message : String(err);
    debugLog(`[pi-router] Unexpected router error for ${modelId}:`, err);
    eventStream.push(createRouterErrorEvent(modelId, "router", ROUTER_API, error));
    eventStream.end();
  });
  
  return eventStream;
}

/**
 * Record a channel failure and apply cooldown
 */
function recordFailure(
  modelId: string,
  channel: string,
  error: string,
  config: RouterConfig,
  modelConfig: RouterModelConfig
): void {
  const key = `${modelId}@${channel}`;

  // Record failure
  if (!routerState.lastFailures.has(modelId)) {
    routerState.lastFailures.set(modelId, []);
  }
  routerState.lastFailures.get(modelId)!.push({
    channel,
    error,
    timestamp: Date.now(),
  });

  // Determine cooldown based on error type
  let cooldownMs: number;

  // Fast-fail errors (connection issues) should have shorter cooldown
  const lowerError = error.toLowerCase();
  const isFastFailError =
    lowerError.includes("econnrefused") ||
    lowerError.includes("etimedout") ||
    lowerError.includes("enotfound") ||
    lowerError.includes("connection error") ||
    lowerError.includes("timeout") ||
    lowerError.includes("timed out") ||
    lowerError.includes("connect");

  if (isFastFailError) {
    // Short cooldown for connection errors (5 seconds)
    cooldownMs = 5000;
    debugLog(`[pi-router] Fast-fail error detected, applying short cooldown: ${cooldownMs}ms`);
  } else {
    // Normal cooldown for other errors (use configured value)
    cooldownMs = modelConfig.failover?.cooldownMs || config.failover?.cooldownMs || 60000;
  }

  routerState.cooldowns.set(key, Date.now() + cooldownMs);

  debugLog(`[pi-router] Applied ${cooldownMs}ms cooldown to ${key}`);
}

/**
 * Resolve the model used for AI summary generation.
 *
 * config.summaryModel supports either:
 * - model-id
 * - model-id@provider
 *
 * When unset or not found, the target model is used.
 */
function resolveSummaryModel(
  configuredSummaryModel: string | undefined,
  modelMap: Map<string, PiModel>,
  targetModel: PiModel
): PiModel {
  if (!configuredSummaryModel) return targetModel;

  if (configuredSummaryModel.includes("@")) {
    const exact = modelMap.get(configuredSummaryModel);
    if (exact) return exact;
  }

  for (const model of modelMap.values()) {
    if (model.id === configuredSummaryModel) {
      return model;
    }
  }

  debugLog(`[pi-router] Configured summaryModel not found: ${configuredSummaryModel}; using target model`);
  return targetModel;
}

/**
 * Try fallback model when all channels exhausted
 */
async function tryModelFallback(
  modelId: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelConfig: RouterModelConfig,
  modelMap: Map<string, PiModel>,
  eventStream: AssistantMessageEventStream
): Promise<void> {
  const fallbackModels = modelConfig.fallbackModels || [];
  const attemptedFallbackRoutes: string[] = [];
  const fallbackFailures: Array<{ route: string; error: string }> = [];

  if (fallbackModels.length === 0) {
    // No fallback configured - show detailed error to user
    const failures = routerState.lastFailures.get(modelId) || [];
    const recentFailures = failures.slice(-modelConfig.channels.length);

    const errorLines = [
      `[pi-router] All channels failed for ${modelId}:`,
      "",
    ];

    errorLines.push(...formatUserFacingFailureList(recentFailures));

    errorLines.push("");
    errorLines.push("Tried channels: " + modelConfig.channels.join(", "));
    errorLines.push("No fallback models configured.");
    errorLines.push("");
    errorLines.push("Suggestions:");
    errorLines.push("  1. Check channel connectivity with /router probes");
    errorLines.push("  2. View failures with /router explain");
    errorLines.push("  3. Configure fallback models in pi-router.json");

    const errorMsg = errorLines.join("\n");
    debugLog(errorMsg);

    debugLog(`[pi-router] No fallback models configured for ${modelId}`);
    eventStream.push(createRouterErrorEvent(modelId, "router", ROUTER_API, errorMsg));
    eventStream.end();
    return;
  }

  debugLog(`[pi-router] All channels exhausted, trying fallback model...`);
  
  for (const fallbackSpec of fallbackModels) {
    debugLog(`[pi-router] Attempting fallback to ${fallbackSpec.id}...`);
    
    const fallbackChannels = fallbackSpec.channels;
    const fallbackModelConfig: RouterModelConfig = {
      id: fallbackSpec.id,
      channels: fallbackChannels,
      aliases: fallbackSpec.aliases,
      modelByChannel: fallbackSpec.modelByChannel,
      sortBy: modelConfig.sortBy,
      failover: modelConfig.failover,
      sticky: false,
      contextTransfer: modelConfig.contextTransfer,
    };
    
    for (const channel of fallbackChannels) {
      const key = `${fallbackSpec.id}@${channel}`;
      const fallbackRoute = resolveConfiguredRoute(fallbackModelConfig, channel, modelMap);
      const targetModel = fallbackRoute?.model;
      const routeDisplay = targetModel && targetModel.id !== fallbackSpec.id
        ? `${key} -> ${targetModel.id}@${channel}`
        : key;
      attemptedFallbackRoutes.push(routeDisplay);
      
      if (!targetModel) {
        debugLog(`[pi-router] Fallback model not found: ${key}`);
        fallbackFailures.push({ route: key, error: "model not found" });
        continue;
      }
      
      // Get primary model for context transfer
      const primaryConfigured = findFirstConfiguredModel(modelConfig, modelMap);
      const primaryModel = primaryConfigured?.model;
      
      if (!primaryModel) {
        const error = `Primary model not found for context transfer: ${modelId}`;
        debugLog(`[pi-router] ${error}`);
        fallbackFailures.push({ route: routeDisplay, error });
        continue;
      }
      
      // Determine context transfer strategy
      const transferStrategy = modelConfig.contextTransfer || config.contextTransfer || "summary";
      
      // Sanitize context for model switch
      let modifiedContext = context;
      
      if (transferStrategy === "summary") {
        const estimatedTokens = estimateContextTokens(context);
        const targetWindow = targetModel.contextWindow || 0;

        if (!shouldSummarizeForTarget(context, targetModel)) {
          debugLog(`[pi-router] Context fits target model window (${estimatedTokens}/${targetWindow}), skipping summary`);
          modifiedContext = sanitizeContextForSwitch(
            context,
            primaryModel,
            targetModel,
            "full"
          );
        } else {
          debugLog(`[pi-router] Generating context summary for model switch...`);
          const summaryModel = resolveSummaryModel(config.summaryModel, modelMap, targetModel);
          const summaryResult = await generateContextSummary(
            context.messages || [],
            primaryModel,
            targetModel,
            summaryModel,
            config.summaryPrompt || DEFAULT_SUMMARY_PROMPT,
            config.summaryMaxTokens || 2000,
            config,
          );
          
          if (summaryResult.summary) {
            modifiedContext = sanitizeContextForSwitch(
              context,
              primaryModel,
              targetModel,
              transferStrategy,
              summaryResult.summary
            );
            if (summaryResult.success) {
              debugLog(`[pi-router] Context summary generated (${summaryResult.tokensUsed || 0} tokens)`);
            } else {
              debugLog("[pi-router] AI summary unavailable, using fallback summary text");
            }
          } else {
            debugLog(`[pi-router] Summary generation failed, using full context`);
            modifiedContext = sanitizeContextForSwitch(
              context,
              primaryModel,
              targetModel,
              "full"
            );
          }
        }
      } else if (transferStrategy === "none" || transferStrategy === "full") {
        modifiedContext = sanitizeContextForSwitch(
          context,
          primaryModel,
          targetModel,
          transferStrategy
        );
      }
      
      debugLog(`[pi-router] Forwarding to fallback ${routeDisplay}...`);
      updateRouteSnapshot(modelId, fallbackSpec.id, targetModel, "trying");
      updateFooterStatus(modelId, channel, targetModel.id, "fallback", [...attemptedFallbackRoutes], undefined, targetModel.api);
      logDecision({
        timestamp: Date.now(),
        modelId,
        selectedChannel: routeDisplay,
        attemptedChannels: [...attemptedFallbackRoutes],
        sortStrategy: "fallback",
        fallbackUsed: true,
        fallbackModel: fallbackSpec.id,
        reason: `fallback after primary channels exhausted for ${modelId}`,
      });

      const streamStartTime = Date.now();
      const fallbackStream = forwardToProvider(targetModel, modifiedContext, options, config, modelId);
      const relayResult = await relayProviderStream(
        fallbackStream,
        eventStream,
        options,
        config,
        () => {
          const latency = Date.now() - streamStartTime;
          recordLatency(fallbackSpec.id, channel, latency);
          updateHealthStatus(fallbackSpec.id, channel, true);
          recordCircuitOutcome(fallbackSpec.id, channel, true);
          routerState.activeChannels.set(modelId, channel);
          updateRouteSnapshot(modelId, fallbackSpec.id, targetModel, "success");
          updateFooterStatus(modelId, channel, targetModel.id, "success", [...attemptedFallbackRoutes], undefined, targetModel.api);

          const lastDecision = decisionLogger.decisions[decisionLogger.decisions.length - 1];
          if (lastDecision?.modelId === modelId && lastDecision.selectedChannel === routeDisplay) {
            lastDecision.latencyMs = latency;
          }
        }
      );

      if (relayResult.ok) {
        eventStream.end();
        debugLog(`[pi-router] Successfully failed over to ${routeDisplay}`);
        return;
      }

      const { error, aborted, committed } = relayResult as Extract<RelayProviderStreamResult, { ok: false }>;
      fallbackFailures.push({ route: routeDisplay, error });
      debugLog(`[pi-router] Fallback failed on ${routeDisplay}:`, error);

      updateRouteSnapshot(modelId, fallbackSpec.id, targetModel, "failed");
      if (aborted) {
        updateFooterStatus(modelId, channel, targetModel.id, "aborted", [...attemptedFallbackRoutes], error, targetModel.api);
        eventStream.push(createRouterErrorEvent(modelId, "router", ROUTER_API, error, "aborted"));
        eventStream.end();
        return;
      }

      if (committed) {
        updateFooterStatus(modelId, channel, targetModel.id, "failed", [...attemptedFallbackRoutes], error, targetModel.api);
        eventStream.push(createRouterErrorEvent(modelId, "router", ROUTER_API, formatUserFacingFailure(error)));
        eventStream.end();
        return;
      }

      recordFailure(fallbackSpec.id, channel, error, config, fallbackModelConfig);
      updateHealthStatus(fallbackSpec.id, channel, false);
      recordCircuitOutcome(fallbackSpec.id, channel, false);
      updateFooterStatus(modelId, channel, targetModel.id, "failed", [...attemptedFallbackRoutes], error, targetModel.api);
    }
  }

  // All fallback attempts exhausted - show detailed summary
  const failures = routerState.lastFailures.get(modelId) || [];
  const recentFailures = failures.slice(-10); // Last 10 failures

  debugLog(`[pi-router] ═══════════════════════════════════════════════════`);
  debugLog(`[pi-router] All channels exhausted for ${modelId}`);
  debugLog(`[pi-router] ═══════════════════════════════════════════════════`);
  debugLog(`[pi-router] Configured channels: ${modelConfig.channels.join(", ")}`);
  debugLog(`[pi-router] Recent failures (${recentFailures.length}):`);
  recentFailures.forEach((f, i) => {
    const errPreview = f.error.substring(0, 80);
    debugLog(`[pi-router]   ${i + 1}. ${f.channel}: ${errPreview}`);
  });

  if (!modelConfig.fallbackModels || modelConfig.fallbackModels.length === 0) {
    debugLog(`[pi-router] No fallback models configured`);
    debugLog(`[pi-router] Hint: Add fallbackModels in pi-router.json or run /router config wizard`);
  } else {
    debugLog(`[pi-router] Fallback models also failed: ${modelConfig.fallbackModels.map(f => f.id).join(", ")}`);
  }

  debugLog(`[pi-router] Run '/router explain' for detailed diagnostics`);
  debugLog(`[pi-router] ═══════════════════════════════════════════════════`);

  const finalErrorMsg = [
    `[pi-router] All channels and fallback models failed for ${modelId}.`,
    `Configured channels: ${modelConfig.channels.join(", ")}`,
    recentFailures.length > 0 ? "Recent failures:\n" + recentFailures.map((f, i) => `  ${i + 1}. ${f.channel}: ${formatUserFacingFailure(f.error)}`).join("\n") : "Recent failures: none recorded",
    fallbackFailures.length > 0 ? "Fallback failures:\n" + fallbackFailures.map((f, i) => `  ${i + 1}. ${f.route}: ${formatUserFacingFailure(f.error)}`).join("\n") : "Fallback failures: none recorded",
    `Fallback models: ${modelConfig.fallbackModels?.map(f => f.id).join(", ") || "none"}`,
    "Run '/router explain' for detailed diagnostics.",
  ].join("\n");

  eventStream.push(createRouterErrorEvent(modelId, "router", ROUTER_API, finalErrorMsg));
  eventStream.end();
}

/**
 * Sort channels by cost (lower cost first)
 */
function sortChannelsByCost(modelId: string, channels: string[]): string[] {
  // Get pricing for each channel
  const channelsWithPricing = channels.map(channel => {
    const pricing = getChannelPricing(modelId, channel);
    if (!pricing) {
      return { channel, cost: Infinity };
    }
    
    // Calculate weighted average cost (assume typical usage: 1000 input, 500 output tokens)
    const estimatedCost = estimateRequestCost(modelId, channel, 1000, 500, 0, 0);
    
    return { channel, cost: estimatedCost };
  });
  
  // Sort by cost (lowest first)
  channelsWithPricing.sort((a, b) => a.cost - b.cost);
  
  debugLog(`[pi-router] Sorted channels by cost for ${modelId}:`);
  channelsWithPricing.forEach(({ channel, cost }) => {
    const costStr = cost === Infinity ? "unknown" : cost === 0 ? "free" : `$${cost.toFixed(6)}`;
    debugLog(`  ${channel}: ${costStr}`);
  });
  
  return channelsWithPricing.map(c => c.channel);
}

/**
 * Sort channels by capability score (higher capability first)
 */
function sortChannelsByCapability(modelId: string, channels: string[]): string[] {
  const capability = CAPABILITY_SCORES[modelId];
  
  if (!capability) {
    debugLog(`[pi-router] No capability data for ${modelId}, using config order`);
    return channels;
  }
  
  debugLog(`[pi-router] Model ${modelId} has capability score: ${capability}`);
  
  // For capabilityFirst, we prefer higher-quality providers
  // In practice, this means providers with better reliability/uptime
  // Since we don't have per-provider quality data yet, just return config order
  // TODO: Track provider reliability and sort by it
  
  return channels;
}

/**
 * Latency tracking for channel performance
 */
type LatencyRecord = {
  channel: string;
  latencyMs: number;
  timestamp: number;
};

type LatencyTracker = {
  records: Map<string, LatencyRecord[]>; // "modelId@channel" -> recent latencies
  maxRecords: number; // Keep last N measurements
};

const latencyTracker: LatencyTracker = {
  records: new Map(),
  maxRecords: 10, // Keep last 10 measurements per channel
};

/**
 * Record latency for a channel
 */
function recordLatency(modelId: string, channel: string, latencyMs: number): void {
  const key = `${modelId}@${channel}`;
  
  if (!latencyTracker.records.has(key)) {
    latencyTracker.records.set(key, []);
  }
  
  const records = latencyTracker.records.get(key)!;
  records.push({
    channel,
    latencyMs,
    timestamp: Date.now(),
  });
  
  // Keep only recent measurements
  if (records.length > latencyTracker.maxRecords) {
    records.shift();
  }
  
  debugLog(`[pi-router] Recorded latency for ${key}: ${latencyMs}ms`);
}

/**
 * Get average latency for a channel
 */
function getAverageLatency(modelId: string, channel: string): number | null {
  const key = `${modelId}@${channel}`;
  const records = latencyTracker.records.get(key);
  
  if (!records || records.length === 0) {
    return null;
  }
  
  const sum = records.reduce((acc, r) => acc + r.latencyMs, 0);
  return sum / records.length;
}

/**
 * Sort channels by latency (lower is better)
 */
function sortChannelsByLatency(modelId: string, channels: string[]): string[] {
  const channelLatencies = channels.map(channel => {
    const avgLatency = getAverageLatency(modelId, channel);
    return {
      channel,
      latency: avgLatency ?? Infinity, // Unknown latencies go last
    };
  });
  
  // Sort by latency (ascending)
  channelLatencies.sort((a, b) => a.latency - b.latency);
  
  const sorted = channelLatencies.map(c => c.channel);
  debugLog(
    `[pi-router] Latency-sorted channels for ${modelId}:`,
    sorted.map((c, i) => {
      const lat = channelLatencies[i].latency;
      return lat === Infinity ? `${c}(unknown)` : `${c}(${lat.toFixed(0)}ms)`;
    }).join(", ")
  );
  
  return sorted;
}

/**
 * Health check system for periodic channel monitoring
 */
type HealthCheckStatus = {
  channel: string;
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
};

type HealthChecker = {
  status: Map<string, HealthCheckStatus>; // "modelId@channel" -> status
  intervalMs: number;
  enabled: boolean;
};

const healthChecker: HealthChecker = {
  status: new Map(),
  intervalMs: 60000, // Check every 60s
  enabled: false, // Disabled by default (will enable in v0.2)
};

/**
 * Mark channel health status
 */
function updateHealthStatus(
  modelId: string,
  channel: string,
  healthy: boolean
): void {
  const key = `${modelId}@${channel}`;
  const current = healthChecker.status.get(key);
  
  if (!current) {
    healthChecker.status.set(key, {
      channel,
      healthy,
      lastCheck: Date.now(),
      consecutiveFailures: healthy ? 0 : 1,
    });
  } else {
    current.healthy = healthy;
    current.lastCheck = Date.now();
    current.consecutiveFailures = healthy ? 0 : current.consecutiveFailures + 1;
  }
  
  debugLog(`[pi-router] Health status updated: ${key} = ${healthy ? 'healthy' : 'unhealthy'}`);
}

/**
 * Get health status for a channel
 */
function isChannelHealthy(modelId: string, channel: string): boolean {
  const key = `${modelId}@${channel}`;
  const status = healthChecker.status.get(key);
  
  // If no health data, assume healthy
  if (!status) {
    return true;
  }
  
  // Mark unhealthy if 3+ consecutive failures
  if (status.consecutiveFailures >= 3) {
    return false;
  }
  
  return status.healthy;
}

/**
 * Circuit breaker for fast-fail on consistently failing channels
 */
type CircuitState = "closed" | "open" | "half-open";

type CircuitBreakerStatus = {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  nextRetryTime: number;
};

type CircuitBreaker = {
  circuits: Map<string, CircuitBreakerStatus>; // "modelId@channel" -> status
  failureThreshold: number; // Open circuit after N failures
  resetTimeoutMs: number; // Try half-open after this duration
  enabled: boolean;
};

const circuitBreaker: CircuitBreaker = {
  circuits: new Map(),
  failureThreshold: 5, // Open after 5 consecutive failures
  resetTimeoutMs: 120000, // Try again after 2 minutes
  enabled: true,
};

/**
 * Check if circuit breaker allows request
 */
function canAttemptChannel(modelId: string, channel: string): boolean {
  if (!circuitBreaker.enabled) {
    return true;
  }
  
  const key = `${modelId}@${channel}`;
  const status = circuitBreaker.circuits.get(key);
  
  if (!status) {
    return true; // No circuit breaker for this channel yet
  }
  
  const now = Date.now();
  
  if (status.state === "closed") {
    return true; // Circuit closed, allow requests
  }
  
  if (status.state === "open") {
    // Check if it's time to try half-open
    if (now >= status.nextRetryTime) {
      status.state = "half-open";
      debugLog(`[pi-router] Circuit half-open for ${key}, allowing test request`);
      return true;
    }
    debugLog(`[pi-router] Circuit open for ${key}, blocking request`);
    return false;
  }
  
  if (status.state === "half-open") {
    // Allow one test request in half-open state
    return true;
  }
  
  return true;
}

/**
 * Record circuit breaker outcome
 */
function recordCircuitOutcome(
  modelId: string,
  channel: string,
  success: boolean
): void {
  if (!circuitBreaker.enabled) {
    return;
  }
  
  const key = `${modelId}@${channel}`;
  let status = circuitBreaker.circuits.get(key);
  
  if (!status) {
    status = {
      state: "closed",
      failureCount: 0,
      lastFailureTime: 0,
      nextRetryTime: 0,
    };
    circuitBreaker.circuits.set(key, status);
  }
  
  if (success) {
    // Reset on success
    if (status.state === "half-open") {
      debugLog(`[pi-router] Circuit closed for ${key} after successful test`);
    }
    status.state = "closed";
    status.failureCount = 0;
  } else {
    // Increment failure count
    status.failureCount++;
    status.lastFailureTime = Date.now();
    
    if (status.state === "half-open") {
      // Failed during test, reopen circuit
      status.state = "open";
      status.nextRetryTime = Date.now() + circuitBreaker.resetTimeoutMs;
      debugLog(`[pi-router] Circuit reopened for ${key}, retry in ${circuitBreaker.resetTimeoutMs / 1000}s`);
    } else if (status.failureCount >= circuitBreaker.failureThreshold) {
      // Open circuit after threshold
      status.state = "open";
      status.nextRetryTime = Date.now() + circuitBreaker.resetTimeoutMs;
      debugLog(`[pi-router] Circuit opened for ${key} after ${status.failureCount} failures`);
    }
  }
}

/**
 * Decision logger for observability
 */
type RoutingDecision = {
  timestamp: number;
  modelId: string;
  selectedChannel: string;
  attemptedChannels: string[];
  sortStrategy: string;
  latencyMs?: number;
  fallbackUsed: boolean;
  fallbackModel?: string;
  reason: string;
  estimatedCost?: number;  // v0.3.0: Estimated cost in USD
};

type DecisionLogger = {
  decisions: RoutingDecision[];
  maxDecisions: number;
  enabled: boolean;
};

const decisionLogger: DecisionLogger = {
  decisions: [],
  maxDecisions: 50, // Keep last 50 decisions
  enabled: true,
};

/**
 * Log routing decision
 */
function logDecision(decision: RoutingDecision): void {
  if (!decisionLogger.enabled) {
    return;
  }
  
  decisionLogger.decisions.push(decision);
  
  // Keep only recent decisions
  if (decisionLogger.decisions.length > decisionLogger.maxDecisions) {
    decisionLogger.decisions.shift();
  }
  
  debugLog(
    `[pi-router] Decision: ${decision.modelId} -> ${decision.selectedChannel}` +
    (decision.fallbackUsed ? ` (fallback: ${decision.fallbackModel})` : "") +
    ` | ${decision.reason}`
  );
}

/**
 * Get recent routing decisions
 */
function getRecentDecisions(limit: number = 10): RoutingDecision[] {
  return decisionLogger.decisions.slice(-limit);
}

// ============================================================================
// Background Health Probes (v0.2.0)
// ============================================================================

interface HealthProbeConfig {
  enabled: boolean;
  intervalMs: number;        // Probe interval (default: 5 minutes)
  timeoutMs: number;         // Probe timeout (default: 10 seconds)
  probeMessage: string;      // Simple test message
}

interface HealthProbeResult {
  channel: string;
  success: boolean;
  latencyMs?: number;
  error?: string;
  timestamp: number;
}

const healthProber = {
  enabled: false,
  intervalMs: 5 * 60 * 1000,  // 5 minutes
  timeoutMs: 10 * 1000,       // 10 seconds
  probeMessage: "ping",
  timers: new Map<string, NodeJS.Timeout>(),
  lastProbe: new Map<string, HealthProbeResult>(),
};

/**
 * Start background health probes for all channels
 */
function startHealthProbes(config: RouterConfig): void {
  if (!config.healthProbe?.enabled) {
    debugLog("[pi-router] Health probes disabled");
    return;
  }
  
  healthProber.enabled = true;
  healthProber.intervalMs = config.healthProbe.intervalMs || 5 * 60 * 1000;
  healthProber.timeoutMs = config.healthProbe.timeoutMs || 10 * 1000;
  healthProber.probeMessage = config.healthProbe.probeMessage || "ping";
  
  debugLog(`[pi-router] Starting health probes (interval: ${healthProber.intervalMs}ms)`);
  
  // Probe all configured routes. Route keys distinguish same-provider variants.
  for (const modelConfig of config.models) {
    for (const routeEntry of getModelRouteEntries(modelConfig)) {
      const key = getRouteStateKey(modelConfig.id, routeEntry.routeKey);
      scheduleProbe(key, modelConfig, routeEntry, config);
    }
  }
}

/**
 * Schedule periodic probe for a channel/route
 */
function scheduleProbe(
  key: string,
  modelConfig: RouterModelConfig,
  routeEntry: RouterRouteEntry,
  config: RouterConfig
): void {
  // Clear existing timer if any
  const existingTimer = healthProber.timers.get(key);
  if (existingTimer) {
    clearInterval(existingTimer);
  }

  // Schedule periodic probe
  const timer = setInterval(() => {
    probeChannel(key, modelConfig, routeEntry, config);
  }, healthProber.intervalMs);

  healthProber.timers.set(key, timer);

  // Delay initial probe by 30 seconds to avoid startup noise
  // This gives pi time to fully initialize before probing
  setTimeout(() => {
    probeChannel(key, modelConfig, routeEntry, config);
  }, 30000);
}

/**
 * Probe a single channel/route
 */
async function probeChannel(
  key: string,
  modelConfig: RouterModelConfig,
  routeEntry: RouterRouteEntry,
  config: RouterConfig
): Promise<void> {
  const modelId = modelConfig.id;
  const channel = routeEntry.channel;
  
  // Skip if circuit breaker is open
  if (!canAttemptChannel(modelId, routeEntry.routeKey)) {
    debugLog(`[pi-router] Skipping probe for ${key} (circuit breaker open)`);
    return;
  }
  
  debugLog(`[pi-router] Probing ${key}...`);
  
  const startTime = Date.now();
  
  try {
    // FIX #15: Use cached modelMap instead of rebuilding
    const modelMap = getCachedModelMap(routerState.currentModelRegistry);

    const route = resolveConfiguredRouteByEntry(modelConfig, routeEntry, modelMap);
    const targetModel = route?.model;

    if (!route || !targetModel) {
      throw new Error(`Model not found: ${key}`);
    }
    
    // Create probe context
    const probeContext: Context = {
      messages: [
        {
          role: "user",
          content: healthProber.probeMessage,
          timestamp: Date.now(),
        },
      ],
    };
    
    // Forward to provider with timeout
    const stream = forwardToProvider(targetModel, probeContext, {
      timeoutMs: healthProber.timeoutMs,
      maxRetries: 0,
    }, config, modelConfig.id, false);
    
    // Wait for first event
    let gotResponse = false;
    for await (const event of stream) {
      if (event.type === "text_delta" || event.type === "text_start") {
        gotResponse = true;
        break;
      }
      if (event.type === "error") {
        throw new Error("Probe received error event");
      }
    }
    
    if (!gotResponse) {
      throw new Error("No response from probe");
    }
    
    const latencyMs = Date.now() - startTime;
    
    // Record success
    healthProber.lastProbe.set(key, {
      channel: route.routeLabel,
      success: true,
      latencyMs,
      timestamp: Date.now(),
    });
    
    // Update health status and circuit breaker
    updateHealthStatus(modelId, route.routeKey, true);
    recordCircuitOutcome(modelId, route.routeKey, true);
    
    debugLog(`[pi-router] Probe ${key} succeeded (${latencyMs}ms)`);
    
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    
    // Record failure in the probe-only diagnostics. Do not mark the main
    // routing health/circuit breaker as failed: health probes are best-effort
    // and can be false negatives for providers that reject `ping`, have cold
    // starts, or need longer than the probe timeout. Real user traffic is the
    // source of truth for failover health.
    healthProber.lastProbe.set(key, {
      channel: routeEntry.label,
      success: false,
      error: String(err),
      timestamp: Date.now(),
    });
    
    debugLog(`[pi-router] Probe ${key} failed (${latencyMs}ms): ${err}`);
  }
}

/**
 * Stop all background health probes
 */
function stopHealthProbes(): void {
  debugLog("[pi-router] Stopping health probes");
  
  for (const timer of healthProber.timers.values()) {
    clearInterval(timer);
  }
  
  healthProber.timers.clear();
  healthProber.enabled = false;
}

/**
 * Get health probe results
 */
function getHealthProbeResults(): HealthProbeResult[] {
  return Array.from(healthProber.lastProbe.values());
}

function __testResetInternalState(): void {
  routerState.activeChannels.clear();
  routerState.cooldowns.clear();
  routerState.lastFailures.clear();
  routerState.currentUi = undefined;
  routerState.currentTheme = undefined;
  routerState.currentModel = undefined;
  routerState.currentModelProvider = undefined;
  routerState.currentThinkingLevel = undefined;
  routerState.currentSessionManager = undefined;
  routerState.currentSessionHash = undefined;
  routerState.currentRouterModelId = undefined;
  routerState.currentGetContextUsage = undefined;
  routerState.currentModelRegistry = undefined;
  routerState.customFooterInstalled = undefined;
  routerState.customFooterEnabled = undefined;
  routerState.footerStatusLineEnabled = undefined;
  routerState.lastStatusUpdate = undefined;
  routerState.activeRouteSnapshots.clear();
  routerState.routeListeners.clear();
  routerState.unregisterRoutingAdapter?.();
  routerState.unregisterRoutingAdapter = undefined;
  latencyTracker.records.clear();
  healthChecker.status.clear();
  circuitBreaker.circuits.clear();
  healthProber.lastProbe.clear();
  decisionLogger.decisions.length = 0;
  fileHashCache.clear();
  providerIdsCache = null;
  modelsCache = null;
  modelsCacheTimestamp = 0;
  modelsCacheModelsMtime = null;
  modelsCacheAuthMtime = null;
  cachedModelMap = null;
  cachedModelMapTimestamp = 0;
  cachedModelMapRegistryRef = null;
  cachedModelMapModelsMtime = null;
  cachedModelMapAuthMtime = null;
  configFileMtimeMs = null;
  currentRouterConfig = null;
  autoSyncChecked = false;
  autoSyncConfig = null;
  piConfigDirOverride = null;
  if (stickyPersistTimer) {
    clearTimeout(stickyPersistTimer);
    stickyPersistTimer = null;
  }
}

function __testSetPiConfigDir(configDir: string | null): void {
  piConfigDirOverride = configDir;
  providerIdsCache = null;
  modelsCache = null;
  modelsCacheTimestamp = 0;
  modelsCacheModelsMtime = null;
  modelsCacheAuthMtime = null;
  cachedModelMap = null;
  cachedModelMapTimestamp = 0;
  cachedModelMapRegistryRef = null;
  cachedModelMapModelsMtime = null;
  cachedModelMapAuthMtime = null;
  fileHashCache.clear();
  configFileMtimeMs = null;
  currentRouterConfig = null;
  routerState.activeRouteSnapshots.clear();
  routerState.routeListeners.clear();
  routerState.unregisterRoutingAdapter?.();
  routerState.unregisterRoutingAdapter = undefined;
  autoSyncChecked = false;
  autoSyncConfig = null;
}

function __testLoadModelsJson(): PiModel[] {
  return loadModelsJson();
}

function __testLoadConfig(): RouterConfig {
  const config = loadConfig();
  configFileMtimeMs = getFileMtimeMs(getRouterConfigPath());
  return setCurrentRouterConfig(config);
}

function __testSaveConfig(config: RouterConfig): void {
  saveConfig(config);
}

function __testRefreshConfigFromDisk(): RouterConfig {
  return refreshConfigFromDisk();
}

function __testGetCachedModelMap(modelRegistry?: any): Map<string, PiModel> {
  return getCachedModelMap(modelRegistry);
}

function __testGetConfigurableModels(modelRegistry?: any, forceRefresh = false): PiModel[] {
  return getConfigurableModels(modelRegistry, forceRefresh);
}

function __testGetSyncModels(): PiModel[] {
  return getSyncModels();
}

function __testRegisterRoutingAdapter(): void {
  registerRoutingAdapter();
}

function __testCalculateFileHash(filePath: string): string {
  return calculateFileHash(filePath);
}

function __testGetInternalState() {
  return {
    activeChannels: routerState.activeChannels,
    cooldowns: routerState.cooldowns,
    failures: routerState.lastFailures,
    latencies: latencyTracker.records,
    health: healthChecker.status,
    circuits: circuitBreaker.circuits,
    lastStatusUpdate: routerState.lastStatusUpdate,
    decisions: decisionLogger.decisions,
  };
}

export {
  getChannelPricing,
  estimateRequestCost,
  groupModelsByChannels,
  detectModelChanges,
  estimateContextTokens,
  shouldSummarizeForTarget,
  generateSimpleTextSummary,
  sanitizeContextForSwitch,
  recordFailure,
  resolveSummaryModel,
  recordLatency,
  getAverageLatency,
  sortChannelsByLatency,
  sortChannelsByCost,
  updateHealthStatus,
  canAttemptChannel,
  recordCircuitOutcome,
  updateFooterStatus,
  formatFooterStatus,
  formatRightAlignedStatusLine,
  applyRouterRequestOptions,
  getStreamEventFailure,
  isAbortError,
  createMirrorModels,
  createFailoverStream,
  determineChannelOrder,
  expandProviderModels,
  modelsFromRegistry,
  filterConfigurableModels,
  buildModelMap,
  __testResetInternalState,
  __testGetInternalState,
  __testSetPiConfigDir,
  __testLoadModelsJson,
  __testLoadConfig,
  __testSaveConfig,
  __testRefreshConfigFromDisk,
  __testGetCachedModelMap,
  __testGetConfigurableModels,
  __testGetSyncModels,
  __testRegisterRoutingAdapter,
  __testCalculateFileHash,
};
