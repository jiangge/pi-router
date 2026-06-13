/**
 * Configuration Wizard Main Flow
 */

import { type SelectItem } from "@earendil-works/pi-tui";
import { createStepComponent, ChannelOrderEditor } from "./config-wizard-ui.js";
import { TwoTierOrderEditor } from "./config-wizard-two-tier.js";
import { FlatOrderEditor } from "./config-wizard-flat.js";
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
  }>;
  customOrder?: string[];  // For custom strategy
  failover?: {
    on?: string[];
    cooldownMs?: number;
  };
  contextTransfer?: "none" | "summary" | "full";
  lastSyncHash?: string;
};

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
      // Custom strategy: use customOrder array
      finalConfig.models = multiChannelModels.map(m => ({
        id: m.id,
        channels: m.channels.map(ch => ch.channel)
      }));
      finalConfig.customOrder = orderResult as string[];
    } else {
      // channelFirst strategy: use models array
      finalConfig.models = orderResult as Array<{ id: string; channels: string[] }>;
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
  strategy: "channelFirst" | "custom"
): Promise<Array<{ id: string; channels: string[] }> | string[] | null> {

  if (strategy === "channelFirst") {
    // channelFirst: Two-tier editor (model order + channel order per model)
    return await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: any) => {
        const editor = new TwoTierOrderEditor(models, theme);

        editor.onSkip = () => {
          // Skip adjustment, use smart sorted order
          const result = models.map(m => ({
            id: m.id,
            channels: m.channels.map(ch => ch.channel)
          }));
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
        const editor = new FlatOrderEditor(models, theme);

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
    "Run /router config show to view details\n" +
    "Run /reload to apply configuration";

  ctx.ui.notify(message, "info");
}
