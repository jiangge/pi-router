/**
 * pi-router v0.1.0-alpha
 * Transparent two-tier router for pi coding agent
 * 
 * Routes channels (same model, different providers) with opt-in model fallback chain.
 * Real model identity end-to-end — zero protocol coupling with pi-cache-optimizer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  auto?: boolean;
  models?: RouterModelConfig[];
  intent?: "suggest" | "auto" | "off";
  logDir?: string | null;
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
  strategy?: "channelFirst" | "providerFirst";
};

/**
 * Load config from ~/.pi/agent/pi-router.json
 */
function loadConfig(): RouterConfig {
  // TODO: implement config loading
  return { auto: true };
}

/**
 * Main extension export
 */
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  
  // Register router provider with mirror entries
  // TODO: implement provider registration
  
  console.log("[pi-router] Extension loaded (v0.1.0-alpha)");
  console.log("[pi-router] Config auto-discovery:", config.auto ?? true);
  
  // Register /router command
  pi.registerCommand?.({
    name: "router",
    description: "pi-router operations (status, list, explain, switch)",
    run: async (args: string, ctx) => {
      const subcommand = args.trim().toLowerCase().split(/\s+/)[0] || "help";
      
      if (subcommand === "status") {
        ctx.ui.notify("pi-router status (MVP placeholder)", "info");
      } else if (subcommand === "list") {
        ctx.ui.notify("pi-router model list (MVP placeholder)", "info");
      } else if (subcommand === "explain") {
        ctx.ui.notify("pi-router last decision explanation (MVP placeholder)", "info");
      } else {
        ctx.ui.notify(
          "pi-router v0.1.0-alpha\n\n" +
          "Commands:\n" +
          "  /router status\n" +
          "  /router list\n" +
          "  /router explain\n" +
          "\nMVP in progress — full features coming in v0.2+",
          "info"
        );
      }
    },
  });
  
  console.log("[pi-router] /router command registered");
}
