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

import { validateGroups, groupMemberRef, groupMemberThinking, type RouterGroupConfig, type RouterGroupMember, type GroupThinkingLevel } from './core/group-config.js';

// Import types and functions from main index
type RouterConfig = {
  groups?: RouterGroupConfig[];
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
    const [channelName, upstreamFromRouteKey] = routeKey.split("#");
    const channel = model?.channels.find(ch =>
      (ch.routeKey || ch.channel) === routeKey ||
      (ch.channel === channelName && (!upstreamFromRouteKey || ch.upstreamModel === upstreamFromRouteKey)) ||
      ch.channel === routeKey
    );
    const upstreamModel = channel?.upstreamModel || upstreamFromRouteKey;
    return [{
      model: modelId,
      channel: channel?.channel || channelName || routeKey,
      ...(upstreamModel && upstreamModel !== modelId ? { upstreamModel } : {}),
    }];
  });
}

function customOrderToConfigModels(order: string[], models: EditableWizardModel[]): NonNullable<RouterConfig["models"]> {
  const customRoutes = orderStringsToCustomRoutes(order, models);
  const routesByModel = new Map<string, Array<{ channel: string; upstreamModelId: string }>>();
  for (const route of customRoutes) {
    const routes = routesByModel.get(route.model) || [];
    routes.push({
      channel: route.channel,
      upstreamModelId: route.upstreamModel || route.model,
    });
    routesByModel.set(route.model, routes);
  }

  return models.flatMap((model) => {
    const routes = routesByModel.get(model.id);
    if (!routes || routes.length === 0) return [];
    const serialized = serializeRouteEntriesForConfig(model.id, routes);
    return [{
      id: model.id,
      channels: serialized.channels,
      ...(serialized.modelByChannel ? { modelByChannel: serialized.modelByChannel } : {}),
      ...(serialized.routes ? { routes: serialized.routes } : {}),
    }];
  }) as NonNullable<RouterConfig["models"]>;
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
  getModelsJsonPath: () => string,
  existingConfig: RouterConfig = {},
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
      ...existingConfig,
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
      finalConfig.models = customOrderToConfigModels(orderStrings, multiChannelModels);
      finalConfig.customOrder = orderStrings;
      finalConfig.customRoutes = orderStringsToCustomRoutes(orderStrings, multiChannelModels);
    } else {
      // channelFirst strategy: use models array
      finalConfig.models = orderResult as RouterConfig["models"];
    }
    
    // Step 7: Model groups (optional). Candidates are the freshly built
    // models plus any existing entries referenced by existing groups, so
    // those groups stay editable even when rediscovery drops a model.
    const existingById = new Map((existingConfig.models ?? []).map(m => [m.id, m]));
    const referencedBefore = new Set((existingConfig.groups ?? []).flatMap(g => g.members.map(m => groupMemberRef(m).slice(7))));
    const candidateIds: string[] = [];
    const seenCandidate = new Set<string>();
    for (const m of [...(finalConfig.models ?? []), ...(existingConfig.models ?? []).filter(m => referencedBefore.has(m.id))]) {
      if (!seenCandidate.has(m.id)) { seenCandidate.add(m.id); candidateIds.push(m.id); }
    }
    const groups = await runStep7Groups(ctx, candidateIds, existingConfig.groups ?? []);
    if (groups === undefined) return;
    finalConfig.groups = groups.length ? groups : undefined;

    // Group references and their explicit routes survive rediscovery, even offline.
    const references = new Set(groups.flatMap(g => g.members.map(m => groupMemberRef(m).slice(7))));
    const reserved = new Set(groups.map(g => g.id));
    finalConfig.models = [
      ...(finalConfig.models ?? []).filter(m => !reserved.has(m.id) && !(references.has(m.id) && existingById.has(m.id))),
      ...(existingConfig.models ?? []).filter(m => references.has(m.id)),
    ];
    validateGroups(finalConfig);
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
 * Step 7: Model groups (optional)
 *
 * Groups bundle configured models into one virtual model id (router/<group>)
 * that tries its members in order. Everything here is select-driven like the
 * other steps; the only free-text input is the new group's id.
 */

/** One member chosen in the wizard, before it is serialized to config form. */
export type WizardGroupMemberPick = { modelId: string; thinking?: GroupThinkingLevel };

const WIZARD_GROUP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const WIZARD_THINKING_LEVELS: readonly GroupThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Validate a group id typed into the wizard. Mirrors the group rules in
 * core/group-config.ts so mistakes are caught at the prompt, not at save.
 * Returns an error message, or null when the id is usable.
 */
export function validateWizardGroupId(id: string, takenGroupIds: ReadonlySet<string>, modelIds: ReadonlySet<string>): string | null {
  if (!WIZARD_GROUP_ID_PATTERN.test(id)) return "Use a lowercase letter followed by up to 63 lowercase letters, digits, _ or -";
  if (id === "auto") return "\"auto\" is reserved";
  if (modelIds.has(id)) return `"${id}" is already a model id`;
  if (takenGroupIds.has(id)) return `Group "${id}" already exists`;
  return null;
}

/** Serialize one wizard pick: a plain string when no thinking override is set. */
export function wizardPickToMember(pick: WizardGroupMemberPick): RouterGroupMember {
  return pick.thinking ? { model: `router/${pick.modelId}`, thinking: pick.thinking } : `router/${pick.modelId}`;
}

/** Convert a configured group back into wizard picks for editing. */
export function groupToWizardPicks(group: RouterGroupConfig): WizardGroupMemberPick[] {
  return group.members.map(member => {
    const modelId = groupMemberRef(member).slice(7);
    const thinking = groupMemberThinking(member);
    return thinking ? { modelId, thinking } : { modelId };
  });
}

/** Build a RouterGroupConfig from a wizard id + ordered picks. */
export function buildWizardGroup(id: string, picks: WizardGroupMemberPick[]): RouterGroupConfig {
  return { id, members: picks.map(wizardPickToMember) };
}

async function wizardSelect(ctx: any, title: string, items: SelectItem[]): Promise<string | null> {
  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      7, 7,
      title,
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
  return typeof result === "string" ? result : null;
}

async function pickThinking(ctx: any, modelId: string, current?: GroupThinkingLevel): Promise<GroupThinkingLevel | undefined> {
  const items: SelectItem[] = [
    {
      value: "__inherit",
      label: "inherit (Recommended)",
      description: "Use the thinking level chosen in Pi for each request"
    },
    ...WIZARD_THINKING_LEVELS.map(level => ({
      value: level,
      label: level,
      description: level === current ? "Current setting for this member" : `Always use ${level} when this member is tried`
    }))
  ];

  const result = await wizardSelect(ctx, `Thinking effort for ${modelId}`, items);
  if (result === null || result === "__inherit") return undefined;
  return result as GroupThinkingLevel;
}

async function editGroupMembers(
  ctx: any,
  groupId: string,
  picks: WizardGroupMemberPick[],
  candidateModelIds: string[]
): Promise<WizardGroupMemberPick[]> {
  const working = picks.map(p => ({ ...p }));

  for (;;) {
    const summary = working.length
      ? working.map(p => (p.thinking ? `${p.modelId}:${p.thinking}` : p.modelId)).join(" -> ")
      : "(no members yet)";
    const items: SelectItem[] = [
      {
        value: "__add",
        label: "+ Add a member",
        description: "Members are tried in order; the first one that works answers"
      }
    ];
    if (working.length) {
      items.push({
        value: "__remove",
        label: "- Remove a member",
        description: "Remove one member, keeping the rest in order"
      });
      items.push({
        value: "__thinking",
        label: "Set a member's thinking effort",
        description: "Optional per-member override, e.g. opus:high next to sol:xhigh"
      });
    }
    items.push({
      value: "__done",
      label: "Done",
      description: working.length ? "Keep these members" : "Discard this group (it has no members)"
    });

    const choice = await wizardSelect(ctx, `Group ${groupId}: ${summary}`, items);
    if (choice === null || choice === "__done") return working;

    if (choice === "__add") {
      const remaining = candidateModelIds.filter(id => !working.some(p => p.modelId === id));
      if (!remaining.length) {
        ctx.ui.notify("Every available model is already a member of this group.", "warning");
        continue;
      }
      const picked = await wizardSelect(
        ctx,
        `Add member ${working.length + 1} to ${groupId}`,
        remaining.map(id => ({ value: id, label: id, description: `router/${id}` }))
      );
      if (picked === null) continue;
      const thinking = await pickThinking(ctx, picked);
      working.push(thinking ? { modelId: picked, thinking } : { modelId: picked });
    } else if (choice === "__remove") {
      const picked = await wizardSelect(
        ctx,
        `Remove a member from ${groupId}`,
        working.map(p => ({ value: p.modelId, label: p.modelId, description: "Remove this member" }))
      );
      if (picked === null) continue;
      const idx = working.findIndex(p => p.modelId === picked);
      if (idx >= 0) working.splice(idx, 1);
    } else if (choice === "__thinking") {
      const picked = await wizardSelect(
        ctx,
        `Thinking effort in ${groupId}`,
        working.map(p => ({
          value: p.modelId,
          label: p.modelId,
          description: p.thinking ? `Currently ${p.thinking}` : "Currently inherits the request level"
        }))
      );
      if (picked === null) continue;
      const entry = working.find(p => p.modelId === picked);
      if (!entry) continue;
      const thinking = await pickThinking(ctx, picked, entry.thinking);
      if (thinking) entry.thinking = thinking;
      else delete entry.thinking;
    }
  }
}

async function editGroups(
  ctx: any,
  existingGroups: RouterGroupConfig[],
  candidateModelIds: string[]
): Promise<RouterGroupConfig[]> {
  const working: Array<{ id: string; picks: WizardGroupMemberPick[] }> =
    existingGroups.map(g => ({ id: g.id, picks: groupToWizardPicks(g) }));

  for (;;) {
    const items: SelectItem[] = working.map(g => ({
      value: `group:${g.id}`,
      label: `router/${g.id}`,
      description: g.picks.length
        ? `${g.picks.length} member(s): ${g.picks.map(p => p.modelId).join(" -> ")}`
        : "No members yet"
    }));
    items.push({
      value: "__add",
      label: "+ Add a new group",
      description: "Bundle models into a failover pool with one virtual id"
    });
    items.push({
      value: "__done",
      label: "Done",
      description: "Finish editing groups"
    });

    const choice = await wizardSelect(ctx, "Model Groups", items);
    if (choice === null || choice === "__done") break;

    if (choice === "__add") {
      if (typeof ctx.ui.input !== "function") {
        ctx.ui.notify("This Pi version does not offer text input, so a new group cannot be named here. Edit pi-router.json manually instead.", "warning");
        continue;
      }
      const raw = await ctx.ui.input("New group id (lowercase, e.g. plan)", "plan");
      if (raw === undefined || raw === null) continue;
      const id = String(raw).trim();
      const error = validateWizardGroupId(id, new Set(working.map(g => g.id)), new Set(candidateModelIds));
      if (error) {
        ctx.ui.notify(`Invalid group id "${id}": ${error}`, "warning");
        continue;
      }
      const picks = await editGroupMembers(ctx, id, [], candidateModelIds);
      if (!picks.length) {
        ctx.ui.notify(`Group "${id}" was discarded because it has no members.`, "warning");
        continue;
      }
      working.push({ id, picks });
      continue;
    }

    const id = choice.slice("group:".length);
    const group = working.find(g => g.id === id);
    if (!group) continue;
    const action = await wizardSelect(ctx, `router/${id}`, [
      { value: "__members", label: "Edit members", description: `${group.picks.length} member(s)` },
      { value: "__delete", label: "Delete this group", description: "Remove the group; the models stay configured" },
      { value: "__back", label: "Back", description: "Return to the group list" }
    ]);
    if (action === "__members") {
      group.picks = await editGroupMembers(ctx, id, group.picks, candidateModelIds);
      if (!group.picks.length) {
        ctx.ui.notify(`Group "${id}" now has no members and will be removed.`, "warning");
        working.splice(working.indexOf(group), 1);
      }
    } else if (action === "__delete") {
      working.splice(working.indexOf(group), 1);
    }
  }

  return working.map(g => buildWizardGroup(g.id, g.picks));
}

async function runStep7Groups(
  ctx: any,
  candidateModelIds: string[],
  existingGroups: RouterGroupConfig[]
): Promise<RouterGroupConfig[] | undefined> {
  if (!candidateModelIds.length) return existingGroups;

  const items: SelectItem[] = [];
  if (existingGroups.length) {
    items.push({
      value: "__keep",
      label: `Keep existing groups (${existingGroups.length})`,
      description: existingGroups.map(g => `router/${g.id}`).join(", ")
    });
    items.push({
      value: "__edit",
      label: "Create or edit groups",
      description: "Add, change, or remove failover groups"
    });
    items.push({
      value: "__none",
      label: "Remove all groups",
      description: "Save the configuration without any groups"
    });
  } else {
    items.push({
      value: "__edit",
      label: "Create groups",
      description: "Bundle models into failover pools like router/plan (optional)"
    });
    items.push({
      value: "__none",
      label: "Skip - no groups",
      description: "Groups can be added later by editing pi-router.json"
    });
  }

  const choice = await wizardSelect(ctx, "Model Groups (optional)", items);
  if (choice === null) return undefined; // Cancelled: abort the wizard like other steps
  if (choice === "__keep") return existingGroups;
  if (choice === "__none") return [];
  return await editGroups(ctx, existingGroups, candidateModelIds);
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
    nextConfig.models = customOrderToConfigModels(orderStrings, editableModels).map((orderedModel) => {
      const existing = config.models?.find(configModel => configModel.id === orderedModel.id) || { id: orderedModel.id, channels: [] };
      return { ...existing, ...orderedModel };
    });
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
      1, 7,
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
      2, 7,
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
      description: "Check local models.json/auth.json changes; does not run health probes"
    },
    {
      value: "false",
      label: "Disable",
      description: "Manually run /router sync when you want to update"
    }
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      3, 7,
      "Enable Auto-sync? (default: enabled; no health probes)",
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
      value: "disabled",
      label: "Disable (Recommended)",
      description: "Safe default; no background model calls or extra costs"
    },
    {
      value: "10min",
      label: "Enable (10 min interval)",
      description: "Sends real probe requests to models periodically; may cost money"
    }
  ];

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const { container, selectList } = createStepComponent(
      4, 7,
      "Enable Health Probe? (real model calls; default: disabled)",
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
      probeMessage: "Red, green, yellow — just tell me which color you like best."
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
      5, 7,
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
    `  • Health probe: ${config.healthProbe?.enabled ? "Enabled (real periodic model calls; may cost money)" : "Disabled"}\n` +
    `  • Sticky mode: ${config.sticky ? "Enabled" : "Disabled"}\n\n` +
    `Found ${config.models?.length || 0} multi-channel models\n` +
    (config.groups?.length ? `  • Model groups: ${config.groups.map(g => "router/" + g.id).join(", ")}\n` : "") +
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
