/**
 * Configuration Wizard Main Flow
 */

import { type SelectItem } from "@earendil-works/pi-tui";
import { createStepComponent, ChannelOrderEditor } from "./config-wizard-ui.js";
import { TwoTierOrderEditor } from "./config-wizard-two-tier.js";
import { FlatOrderEditor } from "./config-wizard-flat.js";
import {
  getModelRouteEntries,
  makeRouteKey,
  serializeRouteEntriesForConfig,
  type RouterCustomRouteConfig,
  type RouterRouteConfig,
} from "./router-routes.js";
import {
  scanAndClassifyChannels,
  smartSortChannels,
  type WizardConfig,
  type ChannelScore
} from "./config-wizard.js";

// Import types and functions from main index
type RouterConfig = {
  strategy?: "channelFirst" | "custom";
  sortBy?: "manual" | "capabilityFirst" | "costFirst" | "latency" | "cost";
  autoSync?: boolean;
  healthProbe?: {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    probeMessage?: string;
  };
  sticky?: boolean;
  models?: Array<{
    id: string;
    channels: string[];
    aliases?: string[];
    modelByChannel?: Record<string, string>;
    routes?: RouterRouteConfig[];
    [key: string]: unknown;
  }>;
  customOrder?: string[];  // For custom strategy
  customRoutes?: RouterCustomRouteConfig[];
  failover?: {
    on?: string[];
    cooldownMs?: number;
  };
  contextTransfer?: "none" | "summary" | "full";
  lastSyncHash?: string;
};

type EditableWizardModel = {
  id: string;
  channels: ChannelScore[];
};

function toEditableChannelScore(
  channel: string,
  classifications: Map<string, { category: "oauth" | "free" | "aggregator"; reason: string }>,
  upstreamModel?: string,
  canonicalModelId?: string,
  routeKey?: string
): ChannelScore {
  const classification = classifications.get(channel);
  const label = upstreamModel && canonicalModelId && upstreamModel !== canonicalModelId
    ? `${channel} (${upstreamModel})`
    : channel;
  return {
    channel,
    score: 50,
    reason: classification?.reason || "Configured channel (currently unavailable)",
    category: classification?.category || "aggregator",
    upstreamModel,
    routeKey,
    label,
  };
}

function editableModelToConfigModel(model: EditableWizardModel): RouterConfig["models"] extends Array<infer T> ? T : never {
  const serialized = serializeRouteEntriesForConfig(
    model.id,
    model.channels.map(channel => ({
      channel: channel.channel,
      upstreamModelId: channel.upstreamModel || model.id,
    }))
  );

  return {
    id: model.id,
    channels: serialized.channels,
    ...(serialized.modelByChannel ? { modelByChannel: serialized.modelByChannel } : {}),
    ...(serialized.routes ? { routes: serialized.routes } : {}),
  } as RouterConfig["models"] extends Array<infer T> ? T : never;
}

function orderStringsToCustomRoutes(order: string[], models: EditableWizardModel[]): RouterCustomRouteConfig[] {
  const byModel = new Map(models.map(model => [model.id, model]));
  return order.flatMap((item) => {
    const [modelId, routeKey] = item.split("@");
    if (!modelId || !routeKey) return [];
    const model = byModel.get(modelId);
    const channel = model?.channels.find(ch => (ch.routeKey || ch.channel) === routeKey || ch.channel === routeKey);
    return [{
      model: modelId,
      channel: channel?.channel || routeKey,
      ...(channel?.upstreamModel && channel.upstreamModel !== modelId ? { upstreamModel: channel.upstreamModel } : {}),
    }];
  });
}

function customRoutesToInitialOrder(routes: RouterCustomRouteConfig[] | undefined, fallbackOrder: string[] | undefined, models: EditableWizardModel[]): string[] | undefined {
  if (!routes || routes.length === 0) return fallbackOrder;
  const byModel = new Map(models.map(model => [model.id, model]));
  return routes.map(route => {
    const model = byModel.get(route.model);
    const channel = model?.channels.find(ch => ch.channel === route.channel && (ch.upstreamModel || route.model) === (route.upstreamModel || route.model));
    return `${route.model}@${channel?.routeKey || route.channel}`;
  });
}

export function hasExistingRouterModelConfig(config: RouterConfig): boolean {
  return Array.isArray(config.models) && config.models.length > 0;
}

export function buildEditableModelsFromConfig(
  config: RouterConfig,
  currentModels: Array<{ id: string; provider: string; baseUrl?: string }>
): EditableWizardModel[] {
  const classifications = scanAndClassifyChannels(currentModels);
  const aliasLookup = new Map<string, string>();
  for (const configModel of config.models || []) {
    aliasLookup.set(configModel.id.toLowerCase(), configModel.id);
    for (const alias of configModel.aliases || []) aliasLookup.set(alias.toLowerCase(), configModel.id);
    for (const alias of Object.values(configModel.modelByChannel || {})) aliasLookup.set(alias.toLowerCase(), configModel.id);
    for (const route of configModel.routes || []) {
      if (route.model) aliasLookup.set(route.model.toLowerCase(), configModel.id);
    }
  }

  const discoveredRoutesByModel = new Map<string, Array<{ channel: string; upstreamModel: string }>>();
  for (const model of currentModels) {
    const canonicalId = aliasLookup.get(model.id.toLowerCase()) || model.id;
    const routes = discoveredRoutesByModel.get(canonicalId) || [];
    const signature = `${model.provider}\u0000${model.id}`;
    if (!routes.some(route => `${route.channel}\u0000${route.upstreamModel}` === signature)) {
      routes.push({ channel: model.provider, upstreamModel: model.id });
      discoveredRoutesByModel.set(canonicalId, routes);
    }
  }

  return (config.models || [])
    .map((configModel) => {
      const discoveredRoutes = discoveredRoutesByModel.get(configModel.id) || [];

      // Preserve the user's configured order even when a provider is temporarily
      // unavailable from the current registry scan. Newly discovered routes are
      // appended after the saved order. A route is channel + upstream model so the
      // same provider can appear twice for canonical and variant model names.
      const configuredRoutes = getModelRouteEntries(configModel)
        .filter((route) => route.channel !== "router" && route.channel !== "pi-router");
      const configuredSet = new Set(configuredRoutes.map(route => `${route.channel}\u0000${route.upstreamModelId}`));
      const newlyDiscoveredRoutes = discoveredRoutes
        .filter((route) => !configuredSet.has(`${route.channel}\u0000${route.upstreamModel}`))
        .map((route) => ({
          modelId: configModel.id,
          channel: route.channel,
          upstreamModelId: route.upstreamModel,
          routeKey: makeRouteKey(route.channel, route.upstreamModel, configModel.id),
          label: route.upstreamModel !== configModel.id ? `${route.channel} (${route.upstreamModel})` : route.channel,
          explicitModel: route.upstreamModel !== configModel.id,
        }));

      const mergedRoutes = [...configuredRoutes, ...newlyDiscoveredRoutes];
      const editableChannels = mergedRoutes.map((route) => toEditableChannelScore(
        route.channel,
        classifications,
        route.upstreamModelId !== configModel.id ? route.upstreamModelId : undefined,
        configModel.id,
        route.routeKey,
      ));

      return {
        id: configModel.id,
        channels: editableChannels,
      };
    })
    // FIX #5: Don't filter out models with no channels - preserve configuration
    // Only filter out models that were never configured
    .filter((model) => {
      // Keep if model has channels OR if it was explicitly configured
      const wasConfigured = config.models?.some(cm => cm.id === model.id) || false;
      if (wasConfigured && model.channels.length === 0) {
        console.warn(`[pi-router] Configured model '${model.id}' has no currently available channels, but preserving in configuration.`);
      }
      return model.channels.length > 0 || wasConfigured;
    });
}

/**
 * Run the configuration wizard
 */
export async function runConfigWizard(
  ctx: any,
  loadModelsJson: () => any,
  groupModelsByChannels: (models: any[]) => Map<string, string[]>,
  saveConfig: (config: RouterConfig) => void,
  calculateFileHash: (path: string) => string,
  getModelsJsonPath: () => string
): Promise<void> {
  const wizardConfig: Partial<WizardConfig> = {};
  
  try {
    // Step 1: Strategy
    wizardConfig.strategy = await runStep1Strategy(ctx);
    if (!wizardConfig.strategy) return; // User cancelled
    
    // Step 2: Sort By
    wizardConfig.sortBy = await runStep2SortBy(ctx);
    if (!wizardConfig.sortBy) return;
    
    // Step 3: Auto Sync
    wizardConfig.autoSync = await runStep3AutoSync(ctx);
    if (wizardConfig.autoSync === undefined) return;
    
    // Step 4: Health Probe
    const healthProbeResult = await runStep4HealthProbe(ctx);
    if (!healthProbeResult) return;
    wizardConfig.healthProbe = healthProbeResult;
    
    // Step 5: Sticky Mode
    wizardConfig.sticky = await runStep5Sticky(ctx);
    if (wizardConfig.sticky === undefined) return;
    
    // Step 6: Auto-discover and sort models
    const currentModels = loadModelsJson();
    const classifications = scanAndClassifyChannels(currentModels);
    const grouped = groupModelsByChannels(currentModels);
    
    // Filter multi-channel models
    const multiChannelModels: Array<{ id: string; channels: ChannelScore[] }> = [];
    for (const [modelId, channels] of grouped.entries()) {
      if (channels.length > 1) {
        const sortedChannels = smartSortChannels(
          channels,
          classifications,
          wizardConfig.sortBy!
        );
        multiChannelModels.push({
          id: modelId,
          channels: sortedChannels
        });
      }
    }
    
    if (multiChannelModels.length === 0) {
      ctx.ui.notify(
        "No multi-channel models found\n\n" +
        "No models with multiple channels available in models.json.\n" +
        "pi-router requires at least one model with multiple channels.",
        "warning"
      );
      return;
    }
    
    // Step 6b: Let user adjust order (different editors based on strategy)
    const orderResult = await runStep6AdjustOrder(
      ctx,
      multiChannelModels,
      wizardConfig.sortBy!,
      wizardConfig.strategy!
    );
    if (!orderResult) return;

    // Build final config based on strategy
    const finalConfig: RouterConfig = {
      strategy: wizardConfig.strategy,
      sortBy: wizardConfig.sortBy,
      autoSync: wizardConfig.autoSync,
      sticky: wizardConfig.sticky,
      healthProbe: wizardConfig.healthProbe,
      failover: {
        on: ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"],
        cooldownMs: 60000
      },
      contextTransfer: "summary",
      lastSyncHash: wizardConfig.autoSync ? calculateFileHash(getModelsJsonPath()) : undefined
    };

    if (wizardConfig.strategy === "custom") {
      const orderStrings = orderResult as string[];
      finalConfig.models = multiChannelModels.map(editableModelToConfigModel);
      finalConfig.customOrder = orderStrings;
      finalConfig.customRoutes = orderStringsToCustomRoutes(orderStrings, multiChannelModels);
    } else {
      // channelFirst strategy: use models array
      finalConfig.models = orderResult as RouterConfig["models"];
    }
    
    // Save config
    saveConfig(finalConfig);
    
    // Show completion message
    showCompletionMessage(ctx, finalConfig);
    
  } catch (err) {
    console.error("[pi-router] Wizard error:", err);
    ctx.ui.notify(`Configuration wizard error: ${err}`, "error");
  }
}

export async function runConfigOrderWizard(
  ctx: any,
  config: RouterConfig,
  loadModelsJson: () => Array<{ id: string; provider: string; baseUrl?: string }>,
  saveConfig: (config: RouterConfig) => void,
): Promise<void> {
  if (!hasExistingRouterModelConfig(config)) {
    ctx.ui.notify(
      "未发现现有 router 模型顺序配置\n\n" +
      "请先运行 /router config wizard 完成初始配置，之后再使用 /router config order 调整模型/渠道顺序。",
      "warning"
    );
    return;
  }

  const currentModels = loadModelsJson();
  const editableModels = buildEditableModelsFromConfig(config, currentModels);
  if (editableModels.length === 0) {
    ctx.ui.notify(
      "没有可调整的模型顺序\n\n" +
      "当前配置里的模型没有在 models.json 中找到可用渠道。\n" +
      "请先检查 models.json，或重新运行 /router config wizard。",
      "warning"
    );
    return;
  }

  const strategy = config.strategy || "channelFirst";
  const sortBy = config.sortBy || "manual";
  const orderResult = await runStep6AdjustOrder(
    ctx,
    editableModels,
    sortBy,
    strategy,
    customRoutesToInitialOrder(config.customRoutes, config.customOrder, editableModels),
  );
  if (!orderResult) return;

  const nextConfig: RouterConfig = {
    ...config,
    models: editableModels.map((model) => {
      const existing = config.models?.find(configModel => configModel.id === model.id) || { id: model.id, channels: [] };
      return { ...existing, ...editableModelToConfigModel(model) };
    }),
  };

  if (strategy === "custom") {
    const orderStrings = orderResult as string[];
    nextConfig.customOrder = orderStrings;
    nextConfig.customRoutes = orderStringsToCustomRoutes(orderStrings, editableModels);
  } else {
    const orderedModels = orderResult as NonNullable<RouterConfig["models"]>;
    nextConfig.models = orderedModels.map((orderedModel) => {
      const existing = config.models?.find(configModel => configModel.id === orderedModel.id) || { id: orderedModel.id, channels: [] };
      return { ...existing, ...orderedModel };
    });
  }

  saveConfig(nextConfig);
  showOrderAdjustmentMessage(ctx, nextConfig);
}

/**
 * Step 1: Choose routing strategy
 */
async function runStep1Strategy(ctx: any): Promise<"channelFirst" | "custom" | null> {
  const items: SelectItem[] = [
    {
      value: "channelFirst",
      label: "channelFirst (Recommended)",
      description: "Try all channels of the same model first"
    },
    {
      value: "custom",
      label: "custom",
      description: "Custom order, flexible configuration of all model@channel combinations"
    }
  ];

  return await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      1, 6,
      "Choose Routing Strategy",
      items,
      theme,
      (value) => done(value),
      () => done(null)
    );
    
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  }) as "channelFirst" | "custom" | null;
}

/**
 * Step 2: Choose sort strategy
 */
async function runStep2SortBy(ctx: any): Promise<"capabilityFirst" | "cost" | "latency" | "manual" | null> {
  const items: SelectItem[] = [
    {
      value: "latency",
      label: "latency (Recommended)",
      description: "Latency priority: Aggregator > Official > Local"
    },
    {
      value: "capabilityFirst",
      label: "capabilityFirst",
      description: "Capability priority: Official > Aggregator > Self-hosted"
    },
    {
      value: "cost",
      label: "cost",
      description: "Cost priority: Self-hosted > Aggregator > Official"
    },
    {
      value: "manual",
      label: "manual",
      description: "Keep manually configured order"
    }
  ];

  return await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      2, 6,
      "Choose Sorting Strategy",
      items,
      theme,
      (value) => done(value),
      () => done(null)
    );
    
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  }) as "capabilityFirst" | "cost" | "latency" | "manual" | null;
}

/**
 * Step 3: Enable auto-sync
 */
async function runStep3AutoSync(ctx: any): Promise<boolean | undefined> {
  const items: SelectItem[] = [
    {
      value: "true",
      label: "Enable (Recommended)",
      description: "Auto-discover new models and channels"
    },
    {
      value: "false",
      label: "Disable",
      description: "Manually manage configuration, faster startup"
    }
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      3, 6,
      "Enable Auto-sync?",
      items,
      theme,
      (value) => done(value),
      () => done(null)
    );
    
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  });
  
  if (result === null) return undefined;
  return result === "true";
}

/**
 * Step 4: Health probe settings
 */
async function runStep4HealthProbe(ctx: any): Promise<{
  enabled: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  probeMessage?: string;
} | null> {
  const items: SelectItem[] = [
    {
      value: "10min",
      label: "Enable (10 min interval, Recommended)",
      description: "Periodically check channel availability"
    },
    {
      value: "disabled",
      label: "Disable",
      description: "Faster startup, passive failure detection"
    }
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      4, 6,
      "Enable Health Probe?",
      items,
      theme,
      (value) => done(value),
      () => done(null)
    );
    
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  });
  
  if (result === null) return null;
  
  if (result === "disabled") {
    return { enabled: false };
  } else {
    return {
      enabled: true,
      intervalMs: 600000, // 10 minutes
      timeoutMs: 10000,
      probeMessage: "ping"
    };
  }
}

/**
 * Step 5: Sticky mode
 */
async function runStep5Sticky(ctx: any): Promise<boolean | undefined> {
  const items: SelectItem[] = [
    {
      value: "true",
      label: "Enable (Recommended)",
      description: "Prefer last successful channel, improve cache hit rate"
    },
    {
      value: "false",
      label: "Disable",
      description: "Always follow sorting strategy, better load balancing"
    }
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      5, 6,
      "Enable Sticky Mode?",
      items,
      theme,
      (value) => done(value),
      () => done(null)
    );
    
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { selectList.handleInput?.(data); tui.requestRender(); }
    };
  });
  
  if (result === null) return undefined;
  return result === "true";
}

/**
 * Step 6b: Adjust order (different editors based on strategy)
 */
async function runStep6AdjustOrder(
  ctx: any,
  models: Array<{ id: string; channels: ChannelScore[] }>,
  sortBy: string,
  strategy: "channelFirst" | "custom",
  initialCustomOrder?: string[]
): Promise<Array<{ id: string; channels: string[] }> | string[] | null> {

  if (strategy === "channelFirst") {
    // channelFirst: Two-tier editor (model order + channel order per model)
    return await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: any) => {
        const editor = new TwoTierOrderEditor(models, theme);

        editor.onSkip = () => {
          // Skip adjustment, use smart sorted order
          const result = models.map(m => editableModelToConfigModel(m));
          done(result);
        };

        editor.onComplete = () => {
          done(editor.getResult());
        };

        return {
          render: (w: number) => editor.render(w),
          invalidate: () => editor.invalidate(),
          handleInput: (data: string) => { editor.handleInput(data); tui.requestRender(); }
        };
      }
    );
  } else {
    // custom: Flat editor (all model@channel pairs in one list)
    return await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: any) => {
        const editor = new FlatOrderEditor(models, theme, initialCustomOrder);

        editor.onSkip = () => {
          // Skip adjustment, use initial order (modelFirst logic)
          done(editor.getResult());
        };

        editor.onComplete = () => {
          done(editor.getResult());
        };

        return {
          render: (w: number) => editor.render(w),
          invalidate: () => editor.invalidate(),
          handleInput: (data: string) => { editor.handleInput(data); tui.requestRender(); }
        };
      }
    );
  }
}

/**
 * Show completion message
 */
function showCompletionMessage(ctx: any, config: RouterConfig): void {
  const message =
    "╔═══════════════════════════════════════════════════════════╗\n" +
    "║           Configuration Complete!                         ║\n" +
    "╚═══════════════════════════════════════════════════════════╝\n\n" +
    "Your configuration:\n" +
    `  • Routing strategy: ${config.strategy}\n` +
    `  • Sorting strategy: ${config.sortBy}\n` +
    `  • Auto-sync: ${config.autoSync ? "Enabled" : "Disabled"}\n` +
    `  • Health probe: ${config.healthProbe?.enabled ? "Enabled" : "Disabled"}\n` +
    `  • Sticky mode: ${config.sticky ? "Enabled" : "Disabled"}\n\n` +
    `Found ${config.models?.length || 0} multi-channel models\n` +
    "Configuration saved\n\n" +
    "Expected startup time: ~15-30ms\n\n" +
    "Run /router config order to adjust model/channel order later\n" +
    "Run /router config show to view details\n" +
    "Run /reload to apply configuration";

  ctx.ui.notify(message, "info");
}

function showOrderAdjustmentMessage(ctx: any, config: RouterConfig): void {
  const message =
    "╔═══════════════════════════════════════════════════════════╗\n" +
    "║           Order Updated                                   ║\n" +
    "╚═══════════════════════════════════════════════════════════╝\n\n" +
    `策略保持不变: ${config.strategy}\n` +
    `排序策略保持不变: ${config.sortBy}\n` +
    `已更新模型数: ${config.models?.length || 0}\n\n` +
    "本次仅调整模型/渠道顺序，不会重跑完整配置向导。\n\n" +
    "运行 /router config show 查看最新顺序\n" +
    "运行 /reload 应用配置更改";

  ctx.ui.notify(message, "info");
}
