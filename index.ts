/**
 * pi-router v0.3.0-alpha
 * Transparent two-tier router for pi coding agent
 * 
 * Routes channels (same model, different providers) with opt-in model fallback chain.
 * Real model identity end-to-end — zero protocol coupling with pi-cache-optimizer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { streamSimple, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model, Api, Context, SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { runConfigWizard } from "./config-wizard-flow.js";

const PI_ROUTER_DEBUG = process.env.PI_ROUTER_DEBUG === "1";

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
  compat?: Record<string, unknown>;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  input?: string[];
};

type RouterConfig = {
  strategy?: "channelFirst" | "custom";
  auto?: boolean;
  sortBy?: "manual" | "capabilityFirst" | "costFirst" | "latency" | "cost";
  models?: RouterModelConfig[];
  customOrder?: string[];  // For custom strategy: array of "modelId@channel" strings
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
};

type StickyRecord = {
  modelId: string;  // Actual routed model ID
  channel: string;  // Actual routed channel
  successCount: number;  // Consecutive success count
  lastSuccess: number;  // Timestamp of last success
  lastUpdate: number;  // Timestamp of last update
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

    const models = loadModelsJson();
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

function calculateFileHash(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  
  try {
    const stats = fs.statSync(filePath);
    const mtime = stats.mtimeMs;
    
    // Check cache - if file hasn't changed, return cached hash
    const cached = fileHashCache.get(filePath);
    if (cached && cached.mtime === mtime) {
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
const CACHE_TTL = 60000; // 1 minute cache

/**
 * Load models from models.json (with caching)
 */
function loadModelsJson(): PiModel[] {
  // Return cached models if still valid
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTimestamp < CACHE_TTL)) {
    return modelsCache;
  }
  
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
    
    // Update cache
    modelsCache = allModels;
    modelsCacheTimestamp = now;
    
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
    _comment_sortBy: "排序策略: latency(延迟) / capabilityFirst(能力) / cost(成本) / manual(手动)",
    sortBy: config.sortBy ?? "latency",
    _comment_autoSync: "自动同步: true=从 models.json 自动发现多通道模型；false=手动维护 models",
    autoSync: config.autoSync ?? true,
    lastSyncHash: config.lastSyncHash,
    _comment_healthProbe: "健康探测: enabled=true 时每 intervalMs 毫秒探测一次",
    healthProbe: config.healthProbe ?? { enabled: false },
    _comment_sticky: "粘性模式: true=优先复用上次成功通道，提高缓存命中率",
    sticky: config.sticky ?? true,
    _comment_models: "模型配置: channels 从左到右依次尝试；fallbackModels 为模型级降级链",
    models: config.models ?? [],
    _comment_customOrder: "自定义顺序(仅 custom 策略): model@channel 二元组数组，按此顺序尝试",
    ...(config.customOrder ? { customOrder: config.customOrder } : {}),
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

- \`/router config w\`：运行向导
- \`/router config s\`：显示当前配置
- \`/router config r\`：重置配置

## 手动编辑

你也可以直接编辑 \`pi-router.json\`。修改后运行 \`/reload\` 或重启 pi 生效。

### 关键字段

- \`strategy\`: \`channelFirst\` 或 \`custom\`
- \`sortBy\`: \`latency\` / \`capabilityFirst\` / \`cost\` / \`manual\`
- \`autoSync\`: 是否从 models.json 自动同步多通道模型
- \`healthProbe.enabled\`: 是否启用健康探测
- \`sticky\`: 是否优先复用上次成功通道
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
  const commands = ["wizard", "show", "reset"];
  const aliases: Record<string, string> = {
    "w": "wizard",
    "wiz": "wizard",
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
      lines.push(`    通道: ${m.channels.join(" → ")}`);
      if (m.fallbackModels && m.fallbackModels.length > 0) {
        lines.push(`    降级: ${m.fallbackModels.map(f => f.id).join(" → ")}`);
      }
    });
  } else {
    lines.push("  未配置模型");
  }
  
  lines.push("");
  lines.push(`配置文件: ~/.pi/agent/pi-router.json`);
  lines.push("");
  lines.push("运行 /router config wizard 重新配置");
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
function resetConfig(): void {
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
    container.addChild(new Text(theme.fg("accent", theme.bold("\u2554 Pi-Router (v0.3.0-alpha)")), 1, 1));
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
    { value: "wizard", label: "wizard", description: "Interactive configuration wizard (recommended)" },
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
        loadModelsJson,
        groupModelsByChannels,
        saveConfig,
        calculateFileHash,
        getModelsJsonPath
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
 * Update footer status to show the active channel (real provider)
 */
function updateFooterStatus(modelId: string, channel: string, actualModelId?: string): void {
  routerState.lastStatusUpdate = {
    modelId,
    channel,
    actualModelId,
    timestamp: Date.now()
  };
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
  const config = loadConfig();

  // Store config for auto-sync check
  autoSyncConfig = config;

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
  
  debugLog("[pi-router] Extension loaded (v0.3.0-alpha)");
  debugLog("[pi-router] Strategy:", config.strategy ?? "channelFirst");
  debugLog("[pi-router] Configured models:", config.models?.length ?? 0);
  
  // Listen to turn_start to update footer with active channel
  pi.on("turn_start", async (_event, ctx) => {
    const status = routerState.lastStatusUpdate;
    if (status && ctx.model?.provider === "router") {
      let statusText: string;

      if (status.actualModelId) {
        // Auto router mode: show auto → actual-model @ channel
        statusText = ctx.ui.theme.fg("dim", `auto ${ctx.ui.theme.fg("accent", "→")} ${status.actualModelId} ${ctx.ui.theme.fg("accent", "@")} `) +
                     ctx.ui.theme.fg("success", status.channel);
      } else {
        // Regular router model: show (router) model → channel
        statusText = ctx.ui.theme.fg("dim", `(router) ${status.modelId} ${ctx.ui.theme.fg("accent", "→")} `) +
                     ctx.ui.theme.fg("success", status.channel);
      }

      ctx.ui.setStatus("pi-router", statusText);
    }
  });
  
  // Clear status when switching away from router models
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider !== "router") {
      ctx.ui.setStatus("pi-router", undefined);
    }
  });
  
  // Register /router command
  pi.registerCommand("router", {
    description: "pi-router operations (config, status, list, explain, decisions, probes, pricing, sync, diff)",
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
          { value: "wizard", label: "wizard (w)", description: "Interactive configuration wizard" },
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
      await routerHandler(args, ctx, config);
    },
  });
  
  // Store handler reference for menu re-dispatch
  routerHandlerRef = async (args: string, ctx: any) => {
    await routerHandler(args, ctx, config);
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
async function routerHandler(args: string, ctx: any, config: RouterConfig): Promise<void> {
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
        loadModelsJson,
        groupModelsByChannels,
        saveConfig,
        calculateFileHash,
        getModelsJsonPath
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
      const lines = models.map(m => `  ${m.id}: ${m.channels.join(", ")}`);
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
  } else {
    ctx.ui.notify(
      "pi-router v0.3.0-alpha\n\n" +
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
 * @param pi - ExtensionAPI instance
 */
async function generateContextSummary(
  messages: any[],
  fromModel: PiModel,
  toModel: PiModel,
  summaryModel: PiModel,
  promptTemplate: string,
  summaryMaxTokens: number,
  _pi: any
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
    
    // Convert PiModel to pi-ai Model format
    const realSummaryModel: Model<Api> = {
      id: summaryModel.id,
      provider: summaryModel.provider,
      api: summaryModel.api as Api,
      name: summaryModel.id,
      baseUrl: "",
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 128000,
      maxTokens: 8192,
      compat: summaryModel.compat,
      reasoning: summaryModel.reasoning,
    };
    
    // Create context for summary request
    const summaryContext: Context = {
      messages: [
        {
          role: "user",
          content: summaryPrompt,
          timestamp: Date.now(),
        },
      ],
    };
    
    // Call streamSimple to generate summary
    const stream = streamSimple(realSummaryModel, summaryContext, undefined);
    
    // Collect the response
    let summary = "";
    let tokensUsed = 0;
    
    for await (const event of stream) {
      if (event.type === "text_delta") {
        summary += event.delta;
      } else if (event.type === "done") {
        // Usage info may be available in done event or elsewhere
        // For now, estimate based on response length
        tokensUsed = Math.ceil(summary.length / 4);
      }
    }
    
    if (!summary || summary.trim().length === 0) {
      throw new Error("Summary generation returned empty response");
    }
    
    debugLog(`[pi-router] Summary generated: ${summary.length} chars, ${tokensUsed} tokens`);
    
    return {
      success: true,
      summary: summary.trim(),
      tokensUsed,
    };
  } catch (err) {
    console.error("[pi-router] Failed to generate summary with summaryModel:", err);

    const isSameAsTarget = summaryModel.id === toModel.id && summaryModel.provider === toModel.provider;
    if (!isSameAsTarget) {
      debugLog("[pi-router] Trying fallback: use target model for summary...");
      
      // Fallback strategy 1: Try using the target model (toModel) itself
      try {
        const targetModelResult = await generateSummaryWithModel(toModel, summaryPrompt);
        debugLog(`[pi-router] Summary generated with target model: ${targetModelResult.summary.length} chars`);
        return targetModelResult;
      } catch (fallbackErr) {
        console.error("[pi-router] Target model also failed:", fallbackErr);
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

/**
 * Helper function to generate summary using a specific model
 */
async function generateSummaryWithModel(
  model: PiModel,
  summaryPrompt: string
): Promise<SummaryResult> {
  // Convert PiModel to pi-ai Model format
  const realModel: Model<Api> = {
    id: model.id,
    provider: model.provider,
    api: model.api as Api,
    name: model.id,
    baseUrl: "",
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: model.compat,
    reasoning: model.reasoning,
  };
  
  // Create context for summary request
  const summaryContext: Context = {
    messages: [
      {
        role: "user",
        content: summaryPrompt,
        timestamp: Date.now(),
      },
    ],
  };
  
  // Call streamSimple to generate summary
  const stream = streamSimple(realModel, summaryContext, undefined);
  
  // Collect the response
  let summary = "";
  let tokensUsed = 0;
  
  for await (const event of stream) {
    if (event.type === "text_delta") {
      summary += event.delta;
    } else if (event.type === "done") {
      tokensUsed = Math.ceil(summary.length / 4);
    }
  }
  
  if (!summary || summary.trim().length === 0) {
    throw new Error("Summary generation returned empty response");
  }
  
  return {
    success: true,
    summary: summary.trim(),
    tokensUsed,
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
type RouterState = {
  activeChannels: Map<string, string>;  // modelId -> current active channel
  cooldowns: Map<string, number>;  // "modelId@channel" -> cooldown end timestamp
  lastFailures: Map<string, { channel: string; error: string; timestamp: number }[]>;  // modelId -> failure history
  lastStatusUpdate?: {
    modelId: string;           // router model ID (e.g., "claude-fable-5" or "auto")
    channel: string;           // actual channel used (e.g., "lan")
    actualModelId?: string;    // actual model ID (only for auto mode)
    timestamp: number;
  };  // last active routing info
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
    debugLog("[pi-router] No models configured, skipping provider registration");
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
  
  // Add the special "router" meta-model (auto mode)
  // Uses the first configured model's properties as defaults
  const firstConfigModel = configuredModels[0];
  const firstPrimaryKey = `${firstConfigModel.id}@${firstConfigModel.channels[0]}`;
  const firstPrimaryModel = modelMap.get(firstPrimaryKey);
  
  if (firstPrimaryModel) {
    mirrorModels.push({
      id: "auto",
      name: "Auto Router",
      api: firstPrimaryModel.api,
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
    
    debugLog(`[pi-router] Configured router/${configModel.id} with ${configModel.channels.length} channels`);
  }
  
  if (mirrorModels.length === 0) {
    console.warn("[pi-router] No valid mirror models created");
    return;
  }
  
  // Register with custom streamSimple handler
  pi.registerProvider("router", {
    api: "custom" as Api,  // Add required api field
    baseUrl: "https://router.internal",  // Dummy URL for custom provider
    apiKey: "router",  // Dummy API key for custom provider
    models: mirrorModels,
    streamSimple: (model: any, context: any, options?: any) => {
      // Check auto-sync on first use (if not already checked)
      checkAutoSyncOnce();

      return routeRequest(model, context, options, config, modelMap, pi);
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
function canTryAutoChannel(modelId: string, channel: string): boolean {
  const key = `${modelId}@${channel}`;
  
  // Check cooldown
  const cooldownEnd = routerState.cooldowns.get(key);
  if (cooldownEnd && Date.now() < cooldownEnd) {
    return false;
  }
  
  // Check circuit breaker
  return canAttemptChannel(modelId, channel);
}

/**
 * Update sticky record on successful route
 */
function updateStickyRecord(routerModelId: string, modelId: string, channel: string, config: RouterConfig): void {
  if (config.sticky === false) return;
  
  if (!config.stickyRecords) {
    config.stickyRecords = {};
  }
  
  const existing = config.stickyRecords[routerModelId];
  const now = Date.now();
  
  if (existing && existing.modelId === modelId && existing.channel === channel) {
    // Same route, increment success count
    existing.successCount++;
    existing.lastSuccess = now;
    existing.lastUpdate = now;
  } else {
    // New route
    config.stickyRecords[routerModelId] = {
      modelId,
      channel,
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
  
  (async () => {
    try {
      // Try sticky route first if available
      if (stickyRecord) {
        const stickyKey = `${stickyRecord.modelId}@${stickyRecord.channel}`;
        const stickyModel = modelMap.get(stickyKey);
        
        if (stickyModel && canTryAutoChannel(stickyRecord.modelId, stickyRecord.channel)) {
          debugLog(`[pi-router] Auto mode: trying sticky ${stickyKey}`);
          
          try {
            const stream = forwardToProvider(stickyModel, context, options);
            
            routerState.activeChannels.set("auto", stickyRecord.channel);
            updateFooterStatus("auto", stickyRecord.channel, stickyRecord.modelId);
            
            let firstEvent = true;
            const streamStartTime = Date.now();
            
            for await (const event of stream) {
              if (firstEvent) {
                const latency = Date.now() - streamStartTime;
                recordLatency(stickyRecord.modelId, stickyRecord.channel, latency);
                updateHealthStatus(stickyRecord.modelId, stickyRecord.channel, true);
                recordCircuitOutcome(stickyRecord.modelId, stickyRecord.channel, true);
                updateStickyRecord("auto", stickyRecord.modelId, stickyRecord.channel, config);
                firstEvent = false;
              }
              eventStream.push(event);
            }
            
            eventStream.end();
            return;
          } catch (err) {
            debugLog(`[pi-router] Auto mode: sticky ${stickyKey} failed, falling back`);
            recordFailure(stickyRecord.modelId, stickyRecord.channel, String(err), config, configuredModels.find(m => m.id === stickyRecord.modelId)!);
            recordCircuitOutcome(stickyRecord.modelId, stickyRecord.channel, false);
            clearStickyRecord("router", config);
          }
        } else {
          debugLog(`[pi-router] Auto mode: sticky model unavailable, clearing`);
          clearStickyRecord("router", config);
        }
      }
      
      // Normal channel-first routing
      for (const modelConfig of configuredModels) {
        debugLog(`[pi-router] Auto mode trying model: ${modelConfig.id}`);
        
        const channelOrder = determineChannelOrder(modelConfig.id, modelConfig, config);
        
        for (const channel of channelOrder) {
          const key = `${modelConfig.id}@${channel}`;
          const targetModel = modelMap.get(key);

          if (!targetModel) {
            debugLog(`[pi-router] Auto mode: ${key} not found in modelMap`);
            continue;
          }

          if (!canTryAutoChannel(modelConfig.id, channel)) {
            debugLog(`[pi-router] Auto mode: ${key} skipped (cooldown or circuit breaker)`);
            continue;
          }

          debugLog(`[pi-router] Auto mode attempting ${key}...`);
          
          try {
            const stream = forwardToProvider(targetModel, context, options);
            
            routerState.activeChannels.set("auto", channel);
            updateFooterStatus("auto", channel, modelConfig.id);
            
            logDecision({
              timestamp: Date.now(),
              modelId: "auto (router)",
              selectedChannel: `${modelConfig.id}@${channel}`,
              attemptedChannels: [channel],
              sortStrategy: config.sortBy || "manual",
              fallbackUsed: false,
              reason: "auto mode (channelFirst)",
            });
            
            let firstEvent = true;
            const streamStartTime = Date.now();
            
            for await (const event of stream) {
              if (firstEvent) {
                const latency = Date.now() - streamStartTime;
                recordLatency(modelConfig.id, channel, latency);
                updateHealthStatus(modelConfig.id, channel, true);
                recordCircuitOutcome(modelConfig.id, channel, true);
                updateStickyRecord("auto", modelConfig.id, channel, config);
                firstEvent = false;
              }
              eventStream.push(event);
            }
            
            eventStream.end();
            return;
          } catch (err) {
            console.error(`[pi-router] Auto mode failed on ${key}:`, err);
            recordFailure(modelConfig.id, channel, String(err), config, modelConfig);
            recordCircuitOutcome(modelConfig.id, channel, false);
          }
        }
      }

      // All exhausted - show diagnostic info (channelFirst)
      const totalChannels = configuredModels.reduce((sum, m) => sum + m.channels.length, 0);
      const skippedChannels = configuredModels.reduce((sum, m) => {
        return sum + m.channels.filter(ch => !canTryAutoChannel(m.id, ch)).length;
      }, 0);

      console.error(`[pi-router] Auto mode (channelFirst): all models and channels exhausted`);
      console.error(`[pi-router] Total channels: ${totalChannels}, Skipped (cooldown/circuit): ${skippedChannels}`);
      console.error(`[pi-router] Hint: Check /router explain for detailed failure info`);
      eventStream.end();
    } catch (err) {
      console.error("[pi-router] Auto mode error:", err);
      eventStream.end();
    }
  })();
  
  return eventStream;
}

/**
 * Auto mode with custom strategy - uses customOrder array
 */
function routeAutoCustom(
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>,
  stickyRecord: StickyRecord | undefined
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();

  (async () => {
    try {
      // Validate customOrder exists
      if (!config.customOrder || config.customOrder.length === 0) {
        console.error("[pi-router] Custom strategy requires customOrder array");
        eventStream.end();
        return;
      }

      // Try sticky route first if available
      if (stickyRecord) {
        const stickyKey = `${stickyRecord.modelId}@${stickyRecord.channel}`;
        const stickyModel = modelMap.get(stickyKey);

        if (stickyModel && canTryAutoChannel(stickyRecord.modelId, stickyRecord.channel)) {
          debugLog(`[pi-router] Auto mode: trying sticky ${stickyKey}`);

          try {
            const stream = forwardToProvider(stickyModel, context, options);

            routerState.activeChannels.set("auto", stickyRecord.channel);
            updateFooterStatus("auto", stickyRecord.channel, stickyRecord.modelId);

            let firstEvent = true;
            const streamStartTime = Date.now();

            for await (const event of stream) {
              if (firstEvent) {
                const latency = Date.now() - streamStartTime;
                recordLatency(stickyRecord.modelId, stickyRecord.channel, latency);
                updateHealthStatus(stickyRecord.modelId, stickyRecord.channel, true);
                recordCircuitOutcome(stickyRecord.modelId, stickyRecord.channel, true);
                updateStickyRecord("auto", stickyRecord.modelId, stickyRecord.channel, config);
                firstEvent = false;
              }
              eventStream.push(event);
            }

            eventStream.end();
            return;
          } catch (err) {
            debugLog(`[pi-router] Auto mode: sticky ${stickyKey} failed, falling back`);
            const [modelId] = stickyKey.split("@");
            const modelConfig = config.models?.find(m => m.id === modelId);
            if (modelConfig) {
              recordFailure(stickyRecord.modelId, stickyRecord.channel, String(err), config, modelConfig);
            }
            recordCircuitOutcome(stickyRecord.modelId, stickyRecord.channel, false);
            clearStickyRecord("router", config);
          }
        } else {
          debugLog(`[pi-router] Auto mode: sticky model unavailable, clearing`);
          clearStickyRecord("router", config);
        }
      }

      // Try channels in customOrder
      for (const item of config.customOrder) {
        const [modelId, channel] = item.split("@");

        if (!modelId || !channel) {
          console.warn(`[pi-router] Invalid customOrder item: ${item}`);
          continue;
        }

        const key = `${modelId}@${channel}`;
        const targetModel = modelMap.get(key);

        if (!targetModel) {
          debugLog(`[pi-router] Auto mode: ${key} not found in modelMap`);
          continue;
        }

        if (!canTryAutoChannel(modelId, channel)) {
          debugLog(`[pi-router] Auto mode: ${key} skipped (cooldown or circuit breaker)`);
          continue;
        }

        debugLog(`[pi-router] Auto mode attempting ${key}...`);

        try {
          const stream = forwardToProvider(targetModel, context, options);

          routerState.activeChannels.set("auto", channel);
          updateFooterStatus(modelId, channel);

          logDecision({
            timestamp: Date.now(),
            modelId: "auto (router)",
            selectedChannel: key,
            attemptedChannels: [channel],
            sortStrategy: "custom",
            fallbackUsed: false,
            reason: "auto mode (custom order)",
          });

          let firstEvent = true;
          const streamStartTime = Date.now();

          for await (const event of stream) {
            if (firstEvent) {
              const latency = Date.now() - streamStartTime;
              recordLatency(modelId, channel, latency);
              updateHealthStatus(modelId, channel, true);
              recordCircuitOutcome(modelId, channel, true);
              updateStickyRecord("auto", modelId, channel, config);
              firstEvent = false;
            }
            eventStream.push(event);
          }

          eventStream.end();
          return;
        } catch (err) {
          console.error(`[pi-router] Auto mode failed on ${key}:`, err);
          const modelConfig = config.models?.find(m => m.id === modelId);
          if (modelConfig) {
            recordFailure(modelId, channel, String(err), config, modelConfig);
          }
          recordCircuitOutcome(modelId, channel, false);
        }
      }

      // All exhausted - show diagnostic info (custom)
      const totalChannels = config.customOrder.length;
      const skippedChannels = config.customOrder.filter(item => {
        const [modelId, channel] = item.split("@");
        return !canTryAutoChannel(modelId, channel);
      }).length;

      console.error(`[pi-router] Auto mode (custom): all channels exhausted`);
      console.error(`[pi-router] Total channels: ${totalChannels}, Skipped (cooldown/circuit): ${skippedChannels}`);
      console.error(`[pi-router] Hint: Check /router explain for detailed failure info`);
      eventStream.end();
    } catch (err) {
      console.error("[pi-router] Auto mode error:", err);
      eventStream.end();
    }
  })();

  return eventStream;
}

/**
 * Auto mode with custom strategy (deprecated name, kept for compatibility)
 * @deprecated Use routeAutoCustom instead
 */
function routeAutoModelFirst(
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>,
  configuredModels: RouterModelConfig[],
  stickyRecord: StickyRecord | undefined
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();
  
  (async () => {
    try {
      // Try sticky route first if available
      if (stickyRecord) {
        const stickyKey = `${stickyRecord.modelId}@${stickyRecord.channel}`;
        const stickyModel = modelMap.get(stickyKey);
        
        if (stickyModel && canTryAutoChannel(stickyRecord.modelId, stickyRecord.channel)) {
          debugLog(`[pi-router] Auto mode: trying sticky ${stickyKey}`);
          
          try {
            const stream = forwardToProvider(stickyModel, context, options);
            
            routerState.activeChannels.set("auto", stickyRecord.channel);
            updateFooterStatus("auto", stickyRecord.channel, stickyRecord.modelId);
            
            let firstEvent = true;
            const streamStartTime = Date.now();
            
            for await (const event of stream) {
              if (firstEvent) {
                const latency = Date.now() - streamStartTime;
                recordLatency(stickyRecord.modelId, stickyRecord.channel, latency);
                updateHealthStatus(stickyRecord.modelId, stickyRecord.channel, true);
                recordCircuitOutcome(stickyRecord.modelId, stickyRecord.channel, true);
                updateStickyRecord("auto", stickyRecord.modelId, stickyRecord.channel, config);
                firstEvent = false;
              }
              eventStream.push(event);
            }
            
            eventStream.end();
            return;
          } catch (err) {
            debugLog(`[pi-router] Auto mode: sticky ${stickyKey} failed, falling back`);
            recordFailure(stickyRecord.modelId, stickyRecord.channel, String(err), config, configuredModels.find(m => m.id === stickyRecord.modelId)!);
            recordCircuitOutcome(stickyRecord.modelId, stickyRecord.channel, false);
            clearStickyRecord("router", config);
          }
        } else {
          debugLog(`[pi-router] Auto mode: sticky model unavailable, clearing`);
          clearStickyRecord("router", config);
        }
      }
      
      // Normal model-first routing
      const maxChannels = Math.max(...configuredModels.map(m => m.channels.length));
      
      for (let channelIdx = 0; channelIdx < maxChannels; channelIdx++) {
        for (const modelConfig of configuredModels) {
          const channelOrder = determineChannelOrder(modelConfig.id, modelConfig, config);
          
          if (channelIdx >= channelOrder.length) continue;
          
          const channel = channelOrder[channelIdx];
          const key = `${modelConfig.id}@${channel}`;
          const targetModel = modelMap.get(key);
          
          if (!targetModel) continue;
          if (!canTryAutoChannel(modelConfig.id, channel)) continue;
          
          debugLog(`[pi-router] Auto mode attempting ${key}...`);
          
          try {
            const stream = forwardToProvider(targetModel, context, options);
            
            routerState.activeChannels.set("auto", channel);
            updateFooterStatus("auto", channel, modelConfig.id);
            
            logDecision({
              timestamp: Date.now(),
              modelId: "auto (router)",
              selectedChannel: `${modelConfig.id}@${channel}`,
              attemptedChannels: [channel],
              sortStrategy: config.sortBy || "manual",
              fallbackUsed: false,
              reason: "auto mode (custom)",
            });
            
            let firstEvent = true;
            const streamStartTime = Date.now();
            
            for await (const event of stream) {
              if (firstEvent) {
                const latency = Date.now() - streamStartTime;
                recordLatency(modelConfig.id, channel, latency);
                updateHealthStatus(modelConfig.id, channel, true);
                recordCircuitOutcome(modelConfig.id, channel, true);
                updateStickyRecord("auto", modelConfig.id, channel, config);
                firstEvent = false;
              }
              eventStream.push(event);
            }

            eventStream.end();
            return;
          } catch (err) {
            console.error(`[pi-router] Auto mode failed on ${key}:`, err);
            recordFailure(modelConfig.id, channel, String(err), config, modelConfig);
            recordCircuitOutcome(modelConfig.id, channel, false);
          }
        }
      }

      // All exhausted - show diagnostic info (custom)
      const totalChannels = configuredModels.reduce((sum, m) => sum + m.channels.length, 0);
      const skippedChannels = configuredModels.reduce((sum, m) => {
        return sum + m.channels.filter(ch => !canTryAutoChannel(m.id, ch)).length;
      }, 0);

      console.error(`[pi-router] Auto mode (custom): all models and channels exhausted`);
      console.error(`[pi-router] Total channels: ${totalChannels}, Skipped (cooldown/circuit): ${skippedChannels}`);
      console.error(`[pi-router] Hint: Check /router explain for detailed failure info`);
      eventStream.end();
    } catch (err) {
      console.error("[pi-router] Auto mode error:", err);
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
  modelMap: Map<string, PiModel>,
  _pi: any
): AssistantMessageEventStream {
  const modelId = routerModel.id;
  
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
  
  debugLog(`[pi-router] Forwarding to ${model.provider} streamSimple`);
  
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
  let attemptedChannels: string[] = [];
  const sortStrategy = modelConfig.sortBy || config.sortBy || "config";
  
  const tryNextChannel = (): AssistantMessageEventStream | null => {
    while (currentChannelIndex < channelOrder.length) {
      const channel = channelOrder[currentChannelIndex];
      currentChannelIndex++;
      
      const key = `${modelId}@${channel}`;
      
      // Check cooldown
      const cooldownEnd = routerState.cooldowns.get(key);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        const remainingMs = cooldownEnd - Date.now();
        debugLog(`[pi-router] Channel ${channel} in cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`);
        continue;
      }
      
      // Check circuit breaker
      if (!canAttemptChannel(modelId, channel)) {
        debugLog(`[pi-router] Circuit breaker open for ${channel}, skipping`);
        continue;
      }
      
      const targetModel = modelMap.get(key);
      if (!targetModel) {
        console.warn(`[pi-router] Model not found: ${key}`);
        continue;
      }
      
      debugLog(`[pi-router] Attempting ${channel}...`);
      attemptedChannels.push(channel);

      // Update footer immediately to show which channel we're trying
      updateFooterStatus(modelId, channel);

      try {
        currentChannel = channel;
        currentStream = forwardToProvider(targetModel, context, options);
        debugLog(`[pi-router] Started stream on ${key}`);
        routerState.activeChannels.set(modelId, channel);

        // Log decision
        logDecision({
          timestamp: Date.now(),
          modelId,
          selectedChannel: channel,
          attemptedChannels: [...attemptedChannels],
          sortStrategy,
          fallbackUsed: false,
          reason: attemptedChannels.length === 1 ? "first choice" : `failover after ${attemptedChannels.length - 1} failures`,
        });

        return currentStream;
      } catch (err) {
        console.error(`[pi-router] Failed to start stream on ${channel}:`, err);
        recordFailure(modelId, channel, String(err), config, modelConfig);
        recordCircuitOutcome(modelId, channel, false);
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
      // All channels failed, try fallback model
      await tryModelFallback(
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
          recordCircuitOutcome(modelId, currentChannel, true);

          // Update footer on first successful event to confirm the channel worked
          updateFooterStatus(modelId, currentChannel);

          // Update the most recent decision with latency
          if (decisionLogger.decisions.length > 0) {
            const lastDecision = decisionLogger.decisions[decisionLogger.decisions.length - 1];
            if (lastDecision.modelId === modelId && lastDecision.selectedChannel === currentChannel) {
              lastDecision.latencyMs = latency;
            }
          }

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
        // All channels exhausted, try fallback model
        await tryModelFallback(
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
            recordCircuitOutcome(modelId, currentChannel, true);

            // Update footer on first successful event
            updateFooterStatus(modelId, currentChannel);

            // Update the most recent decision with latency
            if (decisionLogger.decisions.length > 0) {
              const lastDecision = decisionLogger.decisions[decisionLogger.decisions.length - 1];
              if (lastDecision.modelId === modelId && lastDecision.selectedChannel === currentChannel) {
                lastDecision.latencyMs = latency;
              }
            }

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
        // Try model fallback as last resort
        await tryModelFallback(
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

  // Determine cooldown based on error type
  let cooldownMs: number;

  // Fast-fail errors (connection issues) should have shorter cooldown
  const isFastFailError =
    error.includes("ECONNREFUSED") ||
    error.includes("ETIMEDOUT") ||
    error.includes("ENOTFOUND") ||
    error.includes("Connection error") ||
    error.includes("timeout") ||
    error.includes("connect");

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

  console.warn(`[pi-router] Configured summaryModel not found: ${configuredSummaryModel}; using target model`);
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
  _pi: any,
  eventStream: AssistantMessageEventStream
): Promise<void> {
  const fallbackModels = modelConfig.fallbackModels || [];

  if (fallbackModels.length === 0) {
    // No fallback configured - show detailed error to user
    const failures = routerState.lastFailures.get(modelId) || [];
    const recentFailures = failures.slice(-modelConfig.channels.length);

    const errorLines = [
      `[pi-router] All channels failed for ${modelId}:`,
      "",
    ];

    recentFailures.forEach(f => {
      errorLines.push(`  • ${f.channel}: ${f.error}`);
    });

    errorLines.push("");
    errorLines.push("Tried channels: " + modelConfig.channels.join(", "));
    errorLines.push("No fallback models configured.");
    errorLines.push("");
    errorLines.push("Suggestions:");
    errorLines.push("  1. Check channel connectivity with /router probes");
    errorLines.push("  2. View failures with /router explain");
    errorLines.push("  3. Configure fallback models in pi-router.json");

    const errorMsg = errorLines.join("\n");
    console.error(errorMsg);

    debugLog(`[pi-router] No fallback models configured for ${modelId}`);
    eventStream.end();
    return;
  }

  debugLog(`[pi-router] All channels exhausted, trying fallback model...`);
  
  for (const fallbackSpec of fallbackModels) {
    debugLog(`[pi-router] Attempting fallback to ${fallbackSpec.id}...`);
    
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
          // Generate summary only when needed
          debugLog(`[pi-router] Generating context summary for model switch...`);
          const summaryModel = resolveSummaryModel(config.summaryModel, modelMap, targetModel);
          const summaryResult = await generateContextSummary(
            context.messages || [],
            primaryModel,
            targetModel,
            summaryModel,
            config.summaryPrompt || DEFAULT_SUMMARY_PROMPT,
            config.summaryMaxTokens || 2000,
            _pi
          );
          
          if (summaryResult.success && summaryResult.summary) {
            modifiedContext = sanitizeContextForSwitch(
              context,
              primaryModel,
              targetModel,
              transferStrategy,
              summaryResult.summary
            );
            debugLog(`[pi-router] Context summary generated (${summaryResult.tokensUsed || 0} tokens)`);
          } else {
            console.warn(`[pi-router] Summary generation failed, using full context`);
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
      
      // Try to forward to fallback model
      try {
        debugLog(`[pi-router] Forwarding to fallback ${key}...`);
        fallbackStream = forwardToProvider(targetModel, modifiedContext, options);
        
        // Forward events
        for await (const event of fallbackStream) {
          eventStream.push(event);
        }
        
        eventStream.end();
        debugLog(`[pi-router] Successfully failed over to ${key}`);
        return;
      } catch (err) {
        console.error(`[pi-router] Fallback failed on ${key}:`, err);
        // Continue to next channel/model
      }
    }
  }

  // All fallback attempts exhausted - show detailed summary
  const failures = routerState.lastFailures.get(modelId) || [];
  const recentFailures = failures.slice(-10); // Last 10 failures

  console.error(`[pi-router] ═══════════════════════════════════════════════════`);
  console.error(`[pi-router] All channels exhausted for ${modelId}`);
  console.error(`[pi-router] ═══════════════════════════════════════════════════`);
  console.error(`[pi-router] Configured channels: ${modelConfig.channels.join(", ")}`);
  console.error(`[pi-router] Recent failures (${recentFailures.length}):`);
  recentFailures.forEach((f, i) => {
    const errPreview = f.error.substring(0, 80);
    console.error(`[pi-router]   ${i + 1}. ${f.channel}: ${errPreview}`);
  });

  if (!modelConfig.fallbackModels || modelConfig.fallbackModels.length === 0) {
    console.error(`[pi-router] No fallback models configured`);
    console.error(`[pi-router] Hint: Add fallbackModels in pi-router.json or run /router config wizard`);
  } else {
    console.error(`[pi-router] Fallback models also failed: ${modelConfig.fallbackModels.map(f => f.id).join(", ")}`);
  }

  console.error(`[pi-router] Run '/router explain' for detailed diagnostics`);
  console.error(`[pi-router] ═══════════════════════════════════════════════════`);
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
  
  // Probe all configured channels
  for (const modelConfig of config.models) {
    for (const channel of modelConfig.channels) {
      const key = `${modelConfig.id}@${channel}`;
      scheduleProbe(key, modelConfig, config);
    }
  }
}

/**
 * Schedule periodic probe for a channel
 */
function scheduleProbe(
  key: string,
  modelConfig: RouterModelConfig,
  config: RouterConfig
): void {
  // Clear existing timer if any
  const existingTimer = healthProber.timers.get(key);
  if (existingTimer) {
    clearInterval(existingTimer);
  }

  // Schedule periodic probe
  const timer = setInterval(() => {
    probeChannel(key, modelConfig, config);
  }, healthProber.intervalMs);

  healthProber.timers.set(key, timer);

  // Delay initial probe by 30 seconds to avoid startup noise
  // This gives pi time to fully initialize before probing
  setTimeout(() => {
    probeChannel(key, modelConfig, config);
  }, 30000);
}

/**
 * Probe a single channel
 */
async function probeChannel(
  key: string,
  modelConfig: RouterModelConfig,
  config: RouterConfig
): Promise<void> {
  const [modelId, channel] = key.split("@");
  
  // Skip if circuit breaker is open
  if (!canAttemptChannel(modelId, channel)) {
    debugLog(`[pi-router] Skipping probe for ${key} (circuit breaker open)`);
    return;
  }
  
  debugLog(`[pi-router] Probing ${key}...`);
  
  const startTime = Date.now();
  
  try {
    // Build model map from current models
    const currentModels = loadModelsJson();
    const modelMap = new Map<string, PiModel>();
    for (const model of currentModels) {
      const key = `${model.id}@${model.provider}`;
      modelMap.set(key, model);
    }
    
    const targetModel = modelMap.get(key);
    
    if (!targetModel) {
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
    });
    
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
      channel,
      success: true,
      latencyMs,
      timestamp: Date.now(),
    });
    
    // Update health status and circuit breaker
    updateHealthStatus(modelId, channel, true);
    recordCircuitOutcome(modelId, channel, true);
    
    debugLog(`[pi-router] Probe ${key} succeeded (${latencyMs}ms)`);
    
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    
    // Record failure
    healthProber.lastProbe.set(key, {
      channel,
      success: false,
      error: String(err),
      timestamp: Date.now(),
    });
    
    // Update health status and circuit breaker
    updateHealthStatus(modelId, channel, false);
    recordCircuitOutcome(modelId, channel, false);
    
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
  latencyTracker.records.clear();
  healthChecker.status.clear();
  circuitBreaker.circuits.clear();
  healthProber.lastProbe.clear();
}

function __testGetInternalState() {
  return {
    cooldowns: routerState.cooldowns,
    failures: routerState.lastFailures,
    latencies: latencyTracker.records,
    health: healthChecker.status,
    circuits: circuitBreaker.circuits,
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
  __testResetInternalState,
  __testGetInternalState,
};

