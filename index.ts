/**
 * pi-router v0.1.0-alpha
 * Transparent two-tier router for pi coding agent
 * 
 * Routes channels (same model, different providers) with opt-in model fallback chain.
 * Real model identity end-to-end — zero protocol coupling with pi-cache-optimizer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model, Api, Context, SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

type PiModel = {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl?: string;
  compat?: Record<string, unknown>;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  input?: string[];
};

type RouterConfig = {
  strategy?: "channelFirst" | "modelFirst";
  auto?: boolean;
  sortBy?: "manual" | "capabilityFirst" | "costFirst" | "latency" | "cost";
  models?: RouterModelConfig[];
  failover?: {
    on?: string[];
    cooldownMs?: number;
  };
  sticky?: boolean;
  intent?: "suggest" | "auto" | "off";
  logDir?: string | null;
  autoSync?: boolean;  // Auto-detect models.json changes and prompt user
  lastSyncHash?: string;  // Hash of models.json at last sync
  contextTransfer?: "none" | "summary" | "full";  // Context transfer strategy on model switch
  summaryModel?: string;  // Model to generate summary (default: fallback model)
  summaryPrompt?: string;  // Custom summary prompt template
};

type RouterModelConfig = {
  id: string;
  channels: string[];
  sortBy?: "config" | "latency" | "cost";
  failover?: {
    on?: string[];
    cooldownMs?: number;
  };
  fallbackModels?: Array<{
    id: string;
    channels: string[];
  }>;
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
const DEFAULT_SUMMARY_PROMPT = `You are switching from one AI model to another mid-conversation. Please provide a concise summary of the conversation so far, focusing on:

1. User's main goal/task
2. Key decisions made
3. Current progress/status
4. Important context the next model needs

Keep it under 500 tokens. Format as a natural continuation prompt.`;

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
 * Used for capabilityFirst sorting in modelFirst strategy
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
 * Diff types for models.json changes
 */
type ModelDiff = {
  added: Array<{ id: string; channels: string[] }>;
  removed: Array<{ id: string; channels: string[] }>;
  modified: Array<{
    id: string;
    channelsAdded: string[];
    channelsRemoved: string[];
    propsChanged: string[];  // e.g., ["cost", "contextWindow"]
  }>;
};

/**
 * Get pi config directory
 */
function getPiConfigDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Get models.json path
 */
function getModelsJsonPath(): string {
  return path.join(getPiConfigDir(), "models.json");
}

/**
 * Get pi-router config path
 */
function getRouterConfigPath(): string {
  return path.join(getPiConfigDir(), "pi-router.json");
}

/**
 * Calculate SHA256 hash of file content
 */
function calculateFileHash(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Load models from models.json
 */
function loadModelsJson(): PiModel[] {
  const modelsPath = getModelsJsonPath();
  if (!fs.existsSync(modelsPath)) {
    console.warn("[pi-router] models.json not found:", modelsPath);
    return [];
  }
  
  try {
    const content = fs.readFileSync(modelsPath, "utf-8");
    const data = JSON.parse(content);
    
    // models.json structure: { providers: { providerName: { models: [...] } } }
    if (!data.providers || typeof data.providers !== "object") {
      console.warn("[pi-router] Invalid models.json structure (no providers)");
      return [];
    }
    
    const allModels: PiModel[] = [];
    
    for (const [providerName, providerData] of Object.entries(data.providers)) {
      const provider = providerData as any;
      
      // Skip providers without models array
      if (!provider.models || !Array.isArray(provider.models)) {
        continue;
      }
      
      for (const model of provider.models) {
        allModels.push({
          ...model,
          provider: providerName,
          api: provider.api || model.api || "unknown",
          baseUrl: provider.baseUrl || model.baseUrl,
        });
      }
    }
    
    return allModels;
  } catch (err) {
    console.error("[pi-router] Failed to load models.json:", err);
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

/**
 * Detect changes between current models.json and config
 */
function detectModelChanges(config: RouterConfig, currentModels: PiModel[]): ModelDiff {
  const currentGroups = groupModelsByChannels(currentModels);
  const configModels = config.models || [];
  
  const diff: ModelDiff = {
    added: [],
    removed: [],
    modified: [],
  };
  
  // Check for added models
  for (const [modelId, channels] of currentGroups.entries()) {
    const configModel = configModels.find(m => m.id === modelId);
    if (!configModel) {
      diff.added.push({ id: modelId, channels });
    }
  }
  
  // Check for removed/modified models
  for (const configModel of configModels) {
    const currentChannels = currentGroups.get(configModel.id);
    
    if (!currentChannels) {
      diff.removed.push({ id: configModel.id, channels: configModel.channels });
    } else {
      const channelsAdded = currentChannels.filter(c => !configModel.channels.includes(c));
      const channelsRemoved = configModel.channels.filter(c => !currentChannels.includes(c));
      
      if (channelsAdded.length > 0 || channelsRemoved.length > 0) {
        diff.modified.push({
          id: configModel.id,
          channelsAdded,
          channelsRemoved,
          propsChanged: [],
        });
      }
    }
  }
  
  return diff;
}

/**
 * Load config from ~/.pi/agent/pi-router.json
 */
function loadConfig(): RouterConfig {
  const configPath = getRouterConfigPath();
  
  if (!fs.existsSync(configPath)) {
    console.log("[pi-router] No config found, using defaults");
    return {
      strategy: "channelFirst",
      auto: true,
      autoSync: true,
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
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.log("[pi-router] Config saved:", configPath);
  } catch (err) {
    console.error("[pi-router] Failed to save config:", err);
  }
}

/**
 * Main extension export
 */
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const currentModels = loadModelsJson();
  const modelsJsonHash = calculateFileHash(getModelsJsonPath());
  
  // Auto-sync check on load
  if (config.autoSync !== false && config.lastSyncHash && config.lastSyncHash !== modelsJsonHash) {
    const diff = detectModelChanges(config, currentModels);
    const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0;
    
    if (hasChanges) {
      console.log("[pi-router] Detected models.json changes:");
      console.log(`  Added: ${diff.added.length}, Removed: ${diff.removed.length}, Modified: ${diff.modified.length}`);
      console.log("[pi-router] Run '/router sync' to review and update config");
    }
  }
  
  // Auto-discover models if enabled
  if (config.auto && config.models?.length === 0) {
    const groups = groupModelsByChannels(currentModels);
    const autoModels: RouterModelConfig[] = [];
    
    for (const [modelId, channels] of groups.entries()) {
      if (channels.length > 1) {
        autoModels.push({
          id: modelId,
          channels,
        });
      }
    }
    
    if (autoModels.length > 0) {
      console.log(`[pi-router] Auto-discovered ${autoModels.length} multi-channel models`);
      config.models = autoModels;
      config.lastSyncHash = modelsJsonHash;
      saveConfig(config);
    }
  }
  
  // Register router provider with mirror entries
  registerRouterProvider(pi, config, currentModels);
  
  console.log("[pi-router] Extension loaded (v0.1.0-alpha)");
  console.log("[pi-router] Strategy:", config.strategy ?? "channelFirst");
  console.log("[pi-router] Configured models:", config.models?.length ?? 0);
  
  // Register /router command
  pi.registerCommand("router", {
    description: "pi-router operations (status, list, explain, switch, sync, diff)",
    handler: async (args: string, ctx: any) => {
      const subcommand = args.trim().toLowerCase().split(/\s+/)[0] || "help";
      
      if (subcommand === "status") {
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
          const lines = models.map(m => `  ${m.id}: ${m.channels.join(", ")}`);
          ctx.ui.notify(
            `Configured models (${models.length}):\n\n` + lines.join("\n"),
            "info"
          );
        }
      } else if (subcommand === "explain") {
        ctx.ui.notify("pi-router last decision explanation (MVP placeholder)", "info");
      } else if (subcommand === "sync") {
        const parts = args.trim().split(/\s+/);
        const action = parts[1]?.toLowerCase();
        
        if (action === "accept") {
          // Apply changes
          const currentModels = loadModelsJson();
          const diff = detectModelChanges(config, currentModels);
          
          // Remove deleted models
          if (config.models) {
            config.models = config.models.filter(m => 
              !diff.removed.some(r => r.id === m.id)
            );
          } else {
            config.models = [];
          }
          
          // Add new models
          for (const added of diff.added) {
            config.models.push({
              id: added.id,
              channels: added.channels,
            });
          }
          
          // Update modified models
          for (const modified of diff.modified) {
            const model = config.models.find(m => m.id === modified.id);
            if (model) {
              // Merge channels
              const allChannels = new Set([...model.channels, ...modified.channelsAdded]);
              modified.channelsRemoved.forEach(c => allChannels.delete(c));
              model.channels = Array.from(allChannels);
            }
          }
          
          // Update sync hash
          const modelsJsonHash = calculateFileHash(getModelsJsonPath());
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
          const currentModels = loadModelsJson();
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
              });
            }
            
            lines.push("");
            lines.push("Run '/router sync accept' to apply changes");
            
            ctx.ui.notify(lines.join("\n"), "info");
          }
        }
      } else if (subcommand === "diff") {
        const currentModels = loadModelsJson();
        const currentGroups = groupModelsByChannels(currentModels);
        const configModels = config.models || [];
        
        const lines: string[] = ["Config vs models.json:", ""];
        
        lines.push(`Config: ${configModels.length} models`);
        lines.push(`models.json: ${currentGroups.size} unique model IDs`);
        lines.push("");
        lines.push("Run '/router sync' to see detailed changes");
        
        ctx.ui.notify(lines.join("\n"), "info");
      } else if (subcommand === "explain") {
        // Show failure history and router state
        const lines: string[] = ["Router State:", ""];
        
        // Active channels
        lines.push("Active Channels:");
        if (routerState.activeChannels.size === 0) {
          lines.push("  (none)");
        } else {
          for (const [modelId, channel] of routerState.activeChannels.entries()) {
            lines.push(`  ${modelId} → ${channel}`);
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
          const statusStr = status.healthy ? "✓ healthy" : "✗ unhealthy";
          const failStr = status.consecutiveFailures > 0 ? ` (${status.consecutiveFailures} failures)` : "";
          const ago = Math.floor((now - status.lastCheck) / 1000);
          lines.push(`  ${key}: ${statusStr}${failStr} (checked ${ago}s ago)`);
          healthCount++;
        }
        if (healthCount === 0) {
          lines.push("  (no data yet)");
        }
        
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        ctx.ui.notify(
          "pi-router v0.1.0-alpha\n\n" +
          "Commands:\n" +
          "  /router status\n" +
          "  /router list\n" +
          "  /router explain\n" +
          "  /router sync    - check models.json changes\n" +
          "  /router diff    - preview config differences\n" +
          "\nMVP in progress — full features coming in v0.2+",
          "info"
        );
      }
    },
  });
  
  console.log("[pi-router] /router command registered");
}

/**
 * Generate context summary for model switching
 * 
 * @param messages - Conversation history
 * @param fromModel - Source model that failed
 * @param toModel - Target fallback model
 * @param summaryModel - Model to use for generating summary (default: toModel)
 * @param promptTemplate - Custom summary prompt
 * @param pi - ExtensionAPI instance
 */
async function generateContextSummary(
  messages: any[],
  fromModel: PiModel,
  toModel: PiModel,
  summaryModel: PiModel,
  promptTemplate: string,
  pi: any
): Promise<SummaryResult> {
  try {
    // Build conversation context
    const conversationText = messages
      .map((m, idx) => {
        const role = m.role || "unknown";
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${idx + 1}] ${role}: ${content}`;
      })
      .join("\n\n");
    
    const summaryPrompt = `${promptTemplate}

---

Conversation to summarize:

${conversationText}

---

Provide the summary now:`;
    
    // Call summary model (via pi's streamSimple or similar)
    // TODO: Implement actual API call when we have access to pi's internal methods
    // For now, return a structured placeholder
    
    console.log("[pi-router] Generating context summary...");
    console.log(`[pi-router] From: ${fromModel.id}@${fromModel.provider}`);
    console.log(`[pi-router] To: ${toModel.id}@${toModel.provider}`);
    console.log(`[pi-router] Using summary model: ${summaryModel.id}@${summaryModel.provider}`);
    
    // Placeholder implementation
    const summary = `[Context Transfer Summary]
Previous model: ${fromModel.id}
Conversation length: ${messages.length} messages

The user was working on a task that requires continuation with the new model ${toModel.id}.`;
    
    return {
      success: true,
      summary,
      tokensUsed: 0, // Will be populated by actual API call
    };
  } catch (err) {
    console.error("[pi-router] Failed to generate summary:", err);
    return {
      success: false,
      error: String(err),
    };
  }
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
        console.log(`[pi-router] Truncated context: ${sanitized.messages.length} messages kept`);
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
type RouterState = {
  activeChannels: Map<string, string>;  // modelId -> current active channel
  cooldowns: Map<string, number>;  // "modelId@channel" -> cooldown end timestamp
  lastFailures: Map<string, { channel: string; error: string; timestamp: number }[]>;  // modelId -> failure history
};

const routerState: RouterState = {
  activeChannels: new Map(),
  cooldowns: new Map(),
  lastFailures: new Map(),
};

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
    console.log("[pi-router] No models configured, skipping provider registration");
    return;
  }
  
  // Build a map of all available models by id@provider
  const modelMap = new Map<string, PiModel>();
  for (const model of allModels) {
    const key = `${model.id}@${model.provider}`;
    modelMap.set(key, model);
  }
  
  // Register router provider with all configured models
  const mirrorModels: any[] = [];
  
  for (const configModel of configuredModels) {
    const primaryChannel = configModel.channels[0];
    const primaryKey = `${configModel.id}@${primaryChannel}`;
    const primaryModel = modelMap.get(primaryKey);
    
    if (!primaryModel) {
      console.warn(`[pi-router] Primary model not found: ${primaryKey}`);
      continue;
    }
    
    // Create mirror model with router provider
    mirrorModels.push({
      id: configModel.id,
      name: `${primaryModel.name} (router)`,
      api: primaryModel.api,
      reasoning: primaryModel.reasoning,
      input: primaryModel.input,
      contextWindow: primaryModel.contextWindow,
      maxTokens: primaryModel.maxTokens,
      cost: primaryModel.cost,
      compat: primaryModel.compat,
      thinkingLevelMap: primaryModel.thinkingLevelMap,
    });
    
    console.log(`[pi-router] Configured router/${configModel.id} with ${configModel.channels.length} channels`);
  }
  
  if (mirrorModels.length === 0) {
    console.warn("[pi-router] No valid mirror models created");
    return;
  }
  
  // Register with custom streamSimple handler
  pi.registerProvider("router", {
    models: mirrorModels,
    streamSimple: (model: any, context: any, options?: any) => {
      return routeRequest(model, context, options, config, modelMap, pi);
    },
  });
  
  console.log(`[pi-router] Registered ${mirrorModels.length} router models`);
}

/**
 * Route request through configured channels with failover
 */
function routeRequest(
  routerModel: any,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>,
  pi: any
): AssistantMessageEventStream {
  const modelId = routerModel.id;
  const modelConfig = config.models?.find(m => m.id === modelId);
  
  if (!modelConfig) {
    throw new Error(`[pi-router] No configuration found for ${modelId}`);
  }
  
  console.log(`[pi-router] Routing request for ${modelId}`);
  console.log(`[pi-router] Available channels: ${modelConfig.channels.join(", ")}`);
  
  // Determine channel order based on strategy
  const channelOrder = determineChannelOrder(modelId, modelConfig, config);
  
  console.log(`[pi-router] Channel order: ${channelOrder.join(" → ")}`);
  
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
function determineChannelOrder(
  modelId: string,
  modelConfig: RouterModelConfig,
  config: RouterConfig
): string[] {
  const channels = [...modelConfig.channels];
  
  // If sticky mode and we have an active channel, try it first
  if (modelConfig.sticky !== false && config.sticky !== false) {
    const activeChannel = routerState.activeChannels.get(modelId);
    if (activeChannel && channels.includes(activeChannel)) {
      // Move active channel to front
      const filtered = channels.filter(c => c !== activeChannel);
      return [activeChannel, ...filtered];
    }
  }
  
  // Determine sort strategy
  const sortBy = modelConfig.sortBy || config.sortBy || "config";
  
  if (sortBy === "config") {
    // Use config order as-is
    return channels;
  }
  
  if (sortBy === "latency") {
    // Sort by latency (lower is better)
    return sortChannelsByLatency(modelId, channels);
  }
  
  if (sortBy === "cost" || sortBy === "costFirst") {
    // Sort by cost (lower is better)
    return sortChannelsByCost(modelId, channels);
  }
  
  if (sortBy === "capabilityFirst") {
    // Sort by capability score (higher is better)
    return sortChannelsByCapability(modelId, channels);
  }
  
  return channels;
}

/**
 * Forward request to actual provider's streamSimple
 */
function forwardToProvider(
  model: PiModel,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  // Convert PiModel to Model<Api> format expected by pi-ai
  const realModel: Model<Api> = {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider,
    api: (model.api || "openai-completions") as Api,
    baseUrl: model.baseUrl || "",
    reasoning: model.reasoning || false,
    input: (model.input || ["text"]) as ("text" | "image")[],
    contextWindow: model.contextWindow || 200000,
    maxTokens: model.maxTokens || 16384,
    cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
  };
  
  console.log(`[pi-router] Forwarding to ${model.provider} streamSimple`);
  
  // Forward to pi-ai's streamSimple
  return streamSimple(realModel, context, options);
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
  let currentStream: AssistantMessageEventStream | null = null;
  let currentChannel: string | null = null;
  
  const tryNextChannel = (): AssistantMessageEventStream | null => {
    while (currentChannelIndex < channelOrder.length) {
      const channel = channelOrder[currentChannelIndex];
      currentChannelIndex++;
      
      const key = `${modelId}@${channel}`;
      
      // Check cooldown
      const cooldownEnd = routerState.cooldowns.get(key);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        const remainingMs = cooldownEnd - Date.now();
        console.log(`[pi-router] Channel ${channel} in cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`);
        continue;
      }
      
      const targetModel = modelMap.get(key);
      if (!targetModel) {
        console.warn(`[pi-router] Model not found: ${key}`);
        continue;
      }
      
      console.log(`[pi-router] Attempting ${channel}...`);
      
      try {
        currentChannel = channel;
        currentStream = forwardToProvider(targetModel, context, options);
        console.log(`[pi-router] Started stream on ${key}`);
        routerState.activeChannels.set(modelId, channel);
        return currentStream;
      } catch (err) {
        console.error(`[pi-router] Failed to start stream on ${channel}:`, err);
        recordFailure(modelId, channel, String(err), config, modelConfig);
      }
    }
    
    return null;
  };
  
  // Create event stream and handle failover asynchronously
  const eventStream = createAssistantMessageEventStream();
  
  // Track timing for latency measurement
  let streamStartTime = 0;
  
  // Start async process to try channels and forward events
  (async () => {
    let stream = tryNextChannel();
    
    if (!stream) {
      // All L1 channels failed, try L2 model fallback
      await tryL2ModelFallback(
        modelId,
        context,
        options,
        config,
        modelConfig,
        modelMap,
        null, // pi reference not needed for now
        eventStream
      );
      return;
    }
    
    streamStartTime = Date.now();
    
    try {
      let firstEvent = true;
      for await (const event of stream) {
        // Record latency on first event (time to first token)
        if (firstEvent && currentChannel) {
          const latency = Date.now() - streamStartTime;
          recordLatency(modelId, currentChannel, latency);
          updateHealthStatus(modelId, currentChannel, true);
          firstEvent = false;
        }
        eventStream.push(event);
      }
      eventStream.end();
    } catch (err) {
      console.error(`[pi-router] Stream error on ${currentChannel}:`, err);
      
      if (currentChannel) {
        recordFailure(modelId, currentChannel, String(err), config, modelConfig);
        updateHealthStatus(modelId, currentChannel, false);
      }
      
      // Try next channel
      stream = tryNextChannel();
      
      if (!stream) {
        // All L1 channels exhausted, try L2 model fallback
        await tryL2ModelFallback(
          modelId,
          context,
          options,
          config,
          modelConfig,
          modelMap,
          null,
          eventStream
        );
        return;
      }
      
      // Reset timing for new channel
      streamStartTime = Date.now();
      
      // Forward events from the new stream
      try {
        let firstEvent = true;
        for await (const event of stream) {
          if (firstEvent && currentChannel) {
            const latency = Date.now() - streamStartTime;
            recordLatency(modelId, currentChannel, latency);
            updateHealthStatus(modelId, currentChannel, true);
            firstEvent = false;
          }
          eventStream.push(event);
        }
        eventStream.end();
      } catch (err2) {
        console.error(`[pi-router] Secondary stream error:`, err2);
        if (currentChannel) {
          updateHealthStatus(modelId, currentChannel, false);
        }
        // Try L2 fallback as last resort
        await tryL2ModelFallback(
          modelId,
          context,
          options,
          config,
          modelConfig,
          modelMap,
          null,
          eventStream
        );
      }
    }
  })();
  
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
  
  // Apply cooldown
  const cooldownMs = modelConfig.failover?.cooldownMs || config.failover?.cooldownMs || 60000;
  routerState.cooldowns.set(key, Date.now() + cooldownMs);
  
  console.log(`[pi-router] Applied ${cooldownMs}ms cooldown to ${key}`);
}

/**
 * Try L2 model fallback when all L1 channels exhausted
 */
async function tryL2ModelFallback(
  modelId: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelConfig: RouterModelConfig,
  modelMap: Map<string, PiModel>,
  pi: any,
  eventStream: AssistantMessageEventStream
): Promise<void> {
  const fallbackModels = modelConfig.fallbackModels || [];
  
  if (fallbackModels.length === 0) {
    console.log(`[pi-router] No fallback models configured for ${modelId}`);
    eventStream.end();
    return;
  }
  
  console.log(`[pi-router] L1 channels exhausted, trying L2 model fallback...`);
  
  for (const fallbackSpec of fallbackModels) {
    console.log(`[pi-router] Attempting fallback to ${fallbackSpec.id}...`);
    
    // Find the fallback model
    const fallbackChannels = fallbackSpec.channels;
    let fallbackStream: AssistantMessageEventStream | null = null;
    
    for (const channel of fallbackChannels) {
      const key = `${fallbackSpec.id}@${channel}`;
      const targetModel = modelMap.get(key);
      
      if (!targetModel) {
        console.warn(`[pi-router] Fallback model not found: ${key}`);
        continue;
      }
      
      // Get primary model for context transfer
      const primaryKey = `${modelId}@${modelConfig.channels[0]}`;
      const primaryModel = modelMap.get(primaryKey);
      
      if (!primaryModel) {
        console.warn(`[pi-router] Primary model not found for context transfer: ${primaryKey}`);
        continue;
      }
      
      // Determine context transfer strategy
      const transferStrategy = modelConfig.contextTransfer || config.contextTransfer || "summary";
      
      // Sanitize context for model switch
      let modifiedContext = context;
      
      if (transferStrategy === "summary") {
        // Generate summary
        console.log(`[pi-router] Generating context summary for model switch...`);
        const summaryModel = targetModel; // Use fallback model to generate summary
        const summaryResult = await generateContextSummary(
          context.messages || [],
          primaryModel,
          targetModel,
          summaryModel,
          config.summaryPrompt || DEFAULT_SUMMARY_PROMPT,
          pi
        );
        
        if (summaryResult.success && summaryResult.summary) {
          modifiedContext = sanitizeContextForSwitch(
            context,
            primaryModel,
            targetModel,
            transferStrategy,
            summaryResult.summary
          );
          console.log(`[pi-router] Context summary generated (${summaryResult.tokensUsed || 0} tokens)`);
        } else {
          console.warn(`[pi-router] Summary generation failed, using full context`);
          modifiedContext = sanitizeContextForSwitch(
            context,
            primaryModel,
            targetModel,
            "full"
          );
        }
      } else if (transferStrategy === "none" || transferStrategy === "full") {
        modifiedContext = sanitizeContextForSwitch(
          context,
          primaryModel,
          targetModel,
          transferStrategy
        );
      }
      
      // Try to forward to fallback model
      try {
        console.log(`[pi-router] Forwarding to fallback ${key}...`);
        fallbackStream = forwardToProvider(targetModel, modifiedContext, options);
        
        // Forward events
        for await (const event of fallbackStream) {
          eventStream.push(event);
        }
        
        eventStream.end();
        console.log(`[pi-router] Successfully failed over to ${key}`);
        return;
      } catch (err) {
        console.error(`[pi-router] Fallback failed on ${key}:`, err);
        // Continue to next channel/model
      }
    }
  }
  
  // All fallback attempts exhausted
  console.error(`[pi-router] All L1 and L2 fallback attempts exhausted for ${modelId}`);
  eventStream.end();
}

/**
 * Sort channels by cost (lower cost first)
 */
function sortChannelsByCost(modelId: string, channels: string[]): string[] {
  const pricing = REFERENCE_PRICING[modelId];
  
  if (!pricing) {
    console.log(`[pi-router] No pricing data for ${modelId}, using config order`);
    return channels;
  }
  
  // Calculate weighted cost for each channel
  // In reality, different channels may have different pricing, but for now we assume same pricing per model
  // TODO: Add per-channel pricing data
  
  // For now, just return config order since we don't have per-channel pricing
  console.log(`[pi-router] Per-channel pricing not available, using config order`);
  return channels;
}

/**
 * Sort channels by capability score (higher capability first)
 */
function sortChannelsByCapability(modelId: string, channels: string[]): string[] {
  const capability = CAPABILITY_SCORES[modelId];
  
  if (!capability) {
    console.log(`[pi-router] No capability data for ${modelId}, using config order`);
    return channels;
  }
  
  console.log(`[pi-router] Model ${modelId} has capability score: ${capability}`);
  
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
  
  console.log(`[pi-router] Recorded latency for ${key}: ${latencyMs}ms`);
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
  console.log(
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
  
  console.log(`[pi-router] Health status updated: ${key} = ${healthy ? 'healthy' : 'unhealthy'}`);
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
