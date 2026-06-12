/**
 * pi-router v0.1.0-alpha
 * Transparent two-tier router for pi coding agent
 * 
 * Routes channels (same model, different providers) with opt-in model fallback chain.
 * Real model identity end-to-end — zero protocol coupling with pi-cache-optimizer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
    return Array.isArray(data) ? data : [];
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
  // TODO: implement provider registration
  
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
