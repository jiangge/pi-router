export type RouterRouteConfig = {
  channel: string;
  /** Exact upstream model id for this provider/channel route. Defaults to the canonical model id. */
  model?: string;
};

export type RouterCustomRouteConfig = {
  model: string;
  channel: string;
  /** Exact upstream model id when this custom route targets a model-name variant. */
  upstreamModel?: string;
};

export type RouteLikeModelConfig = {
  id: string;
  channels?: string[];
  aliases?: string[];
  modelByChannel?: Record<string, string>;
  routes?: RouterRouteConfig[];
};

export type RouterRouteEntry = {
  modelId: string;
  channel: string;
  upstreamModelId: string;
  routeKey: string;
  label: string;
  explicitModel: boolean;
};

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function makeRouteKey(channel: string, upstreamModelId: string | undefined, canonicalModelId: string): string {
  return upstreamModelId && upstreamModelId !== canonicalModelId
    ? `${channel}#${upstreamModelId}`
    : channel;
}

export function getRouteDisplayLabel(route: Pick<RouterRouteEntry, "channel" | "upstreamModelId" | "modelId">): string {
  return route.upstreamModelId && route.upstreamModelId !== route.modelId
    ? `${route.channel} (${route.upstreamModelId})`
    : route.channel;
}

export function getRouteSignature(route: Pick<RouterRouteEntry, "channel" | "upstreamModelId" | "modelId">): string {
  return `${route.channel}\u0000${route.upstreamModelId || route.modelId}`;
}

export function getModelRouteEntries(modelConfig: RouteLikeModelConfig): RouterRouteEntry[] {
  const entries: RouterRouteEntry[] = [];
  const seen = new Set<string>();
  const add = (channelInput: unknown, upstreamInput: unknown, explicitModel: boolean) => {
    const channel = cleanString(channelInput);
    if (!channel || channel === "router" || channel === "pi-router") return;
    const explicitUpstream = cleanString(upstreamInput);
    const upstreamModelId = explicitUpstream || modelConfig.id;
    const routeKey = makeRouteKey(channel, upstreamModelId, modelConfig.id);
    const signature = `${channel}\u0000${upstreamModelId}`;
    if (seen.has(signature)) return;
    const entry: RouterRouteEntry = {
      modelId: modelConfig.id,
      channel,
      upstreamModelId,
      routeKey,
      explicitModel: explicitModel && !!explicitUpstream,
      label: "",
    };
    entry.label = getRouteDisplayLabel(entry);
    seen.add(signature);
    entries.push(entry);
  };

  if (Array.isArray(modelConfig.routes) && modelConfig.routes.length > 0) {
    for (const route of modelConfig.routes) {
      add(route?.channel, route?.model, true);
    }
    return entries;
  }

  for (const channel of modelConfig.channels || []) {
    add(channel, modelConfig.modelByChannel?.[channel], !!modelConfig.modelByChannel?.[channel]);
  }

  return entries;
}

export function serializeRouteEntriesForConfig(
  modelId: string,
  entries: Array<Pick<RouterRouteEntry, "channel" | "upstreamModelId">>
): { channels: string[]; modelByChannel?: Record<string, string>; routes?: RouterRouteConfig[] } {
  const channels: string[] = [];
  const channelCounts = new Map<string, number>();
  const uniqueEntries: Array<{ channel: string; upstreamModelId: string }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const channel = cleanString(entry.channel);
    const upstreamModelId = cleanString(entry.upstreamModelId) || modelId;
    if (!channel) continue;
    const signature = `${channel}\u0000${upstreamModelId}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    uniqueEntries.push({ channel, upstreamModelId });
    if (!channels.includes(channel)) channels.push(channel);
    channelCounts.set(channel, (channelCounts.get(channel) || 0) + 1);
  }

  const hasDuplicateChannel = Array.from(channelCounts.values()).some(count => count > 1);
  if (hasDuplicateChannel) {
    return {
      channels,
      routes: uniqueEntries.map(entry => ({
        channel: entry.channel,
        ...(entry.upstreamModelId !== modelId ? { model: entry.upstreamModelId } : {}),
      })),
    };
  }

  const modelByChannel: Record<string, string> = {};
  for (const entry of uniqueEntries) {
    if (entry.upstreamModelId !== modelId) {
      modelByChannel[entry.channel] = entry.upstreamModelId;
    }
  }

  return {
    channels,
    ...(Object.keys(modelByChannel).length > 0 ? { modelByChannel } : {}),
  };
}

export function customRouteToOrderString(route: RouterCustomRouteConfig): string {
  return `${route.model}@${route.channel}`;
}
