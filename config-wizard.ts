/**
 * Configuration Wizard for pi-router
 * Interactive setup with channel classification and smart sorting
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Types
// ============================================================================

interface WizardConfig {
  strategy: "channelFirst" | "custom";
  sortBy: "capabilityFirst" | "cost" | "latency" | "manual";
  autoSync: boolean;
  healthProbe: {
    enabled: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    probeMessage?: string;
  };
  sticky: boolean;
}

interface ChannelClassification {
  category: "oauth" | "free" | "aggregator";
  reason: string;
}

interface DiscoveredChannel {
  name: string;
  category: "oauth" | "free" | "aggregator";
  reason: string;
}

interface ModelWithChannels {
  id: string;
  channels: Array<{
    name: string;
    reason: string;
    category: string;
    score: number;
  }>;
}

type WizardPiModel = {
  id: string;
  provider: string;
  baseUrl?: string;
};

type ProviderMeta = Record<string, { baseUrl?: string }>;

// ============================================================================
// Channel Classification
// ============================================================================

/**
 * Load auth.json
 */
function loadAuthJson(): Record<string, any> {
  const authPath = path.join(os.homedir(), ".pi/agent/auth.json");
  if (!fs.existsSync(authPath)) return {};
  
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch (err) {
    console.warn("[pi-router] Failed to load auth.json:", err);
    return {};
  }
}

/**
 * Check if URL is local
 */
function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.match(/^192\.168\.\d+\.\d+$/) !== null ||
      hostname.match(/^10\.\d+\.\d+\.\d+$/) !== null ||
      hostname.match(/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/) !== null
    );
  } catch (err) {
    return false;
  }
}

/**
 * Official API domains for major AI providers (whitelist approach)
 * Based on 2026 official documentation
 *
 * Coverage: Global mainstream models
 */
const OFFICIAL_API_DOMAINS: Record<string, string[]> = {
  // === North America ===

  // Anthropic (Claude)
  "anthropic": ["api.anthropic.com", "anthropic.com"],

  // OpenAI (GPT, O1)
  "openai": ["api.openai.com", "openai.com"],
  "openai-codex": ["api.openai.com", "openai.com"],

  // Google (Gemini)
  "google": ["generativelanguage.googleapis.com", "googleapis.com"],
  "gemini": ["generativelanguage.googleapis.com", "googleapis.com"],

  // Cohere
  "cohere": ["api.cohere.ai", "api.cohere.com", "cohere.ai", "cohere.com"],

  // Perplexity
  "perplexity": ["api.perplexity.ai", "perplexity.ai"],

  // xAI (Grok)
  "xai": ["api.x.ai", "x.ai"],
  "grok": ["api.x.ai", "x.ai"],

  // Meta (Llama)
  "meta": ["developers.meta.com", "meta.com"],
  "llama": ["developers.meta.com", "meta.com"],

  // Amazon (Nova, Bedrock)
  "amazon": ["amazonaws.com", "bedrock-runtime.amazonaws.com", "bedrock-mantle.amazonaws.com"],
  "kiro": ["codewhisperer.us-east-1.amazonaws.com", "amazonaws.com"],
  "nova": ["amazonaws.com", "bedrock-runtime.amazonaws.com"],

  // NVIDIA (Nemotron)
  "nvidia": ["integrate.api.nvidia.com", "api.nvidia.com"],
  "nemotron": ["integrate.api.nvidia.com", "api.nvidia.com"],

  // Reka AI
  "reka": ["api.reka.ai", "reka.ai"],

  // === Europe ===

  // Mistral AI (France)
  "mistral": ["api.mistral.ai", "mistral.ai"],

  // === Asia Pacific ===

  // China - Major Players

  // DeepSeek
  "deepseek": ["api.deepseek.com", "deepseek.com"],

  // Moonshot AI (Kimi)
  "moonshot": ["api.moonshot.ai", "moonshot.ai", "api.moonshot.cn"],
  "kimi": ["api.moonshot.ai", "moonshot.ai", "api.moonshot.cn"],

  // Alibaba (Qwen, Tongyi)
  "qwen": ["dashscope.aliyuncs.com", "aliyun.com"],
  "tongyi": ["dashscope.aliyuncs.com", "aliyun.com"],

  // Zhipu AI (GLM, ChatGLM)
  "zhipu": ["open.bigmodel.cn", "bigmodel.cn"],
  "glm": ["open.bigmodel.cn", "bigmodel.cn"],
  "chatglm": ["open.bigmodel.cn", "bigmodel.cn"],

  // MiniMax
  "minimax": ["api.minimaxi.com", "minimaxi.com", "platform.minimax.io"],

  // Tencent (Hunyuan)
  "tencent": ["hunyuan.tencentcloudapi.com", "tencentcloudapi.com", "lkeap.cloud.tencent.com"],
  "hunyuan": ["hunyuan.tencentcloudapi.com", "tencentcloudapi.com"],

  // Baidu (ERNIE/Wenxin)
  "baidu": ["aip.baidubce.com", "baidubce.com"],
  "ernie": ["aip.baidubce.com", "baidubce.com"],
  "wenxin": ["aip.baidubce.com", "baidubce.com"],

  // ByteDance (Doubao/Coze)
  "bytedance": ["ark.cn-beijing.volces.com", "volces.com"],
  "doubao": ["ark.cn-beijing.volces.com", "volces.com"],

  // 01.AI (Yi)
  "01ai": ["api.lingyiwanwu.com", "lingyiwanwu.com"],
  "yi": ["api.lingyiwanwu.com", "lingyiwanwu.com"],

  // Baichuan AI
  "baichuan": ["api.baichuan-ai.com", "baichuan-ai.com"],

  // iFlytek (Spark/Xinghuo)
  "iflytek": ["spark-api.xf-yun.com", "xfyun.cn", "global.xfyun.cn"],
  "spark": ["spark-api.xf-yun.com", "xfyun.cn"],
  "xinghuo": ["spark-api.xf-yun.com", "xfyun.cn"],

  // Shanghai AI Lab (InternLM)
  "internlm": ["internlm.intern-ai.org.cn", "intern-ai.org.cn"],

  // SenseTime (SenseNova)
  "sensetime": ["api.sensenova.cn", "sensenova.cn"],
  "sensenova": ["api.sensenova.cn", "sensenova.cn"],

  // StepFun (Step)
  "stepfun": ["api.stepfun.ai", "stepfun.ai"],
  "step": ["api.stepfun.ai", "stepfun.ai"],

  // MiniCPM (OpenBMB)
  "minicpm": ["api.openbmb.cn", "openbmb.cn"],

  // === Additional Models (Common aliases) ===

  // Gemma (Google)
  "gemma": ["generativelanguage.googleapis.com", "googleapis.com"],

  // Phi (Microsoft)
  "phi": ["ai.azure.com", "azure.com"],

  // Solar (Upstage)
  "solar": ["api.upstage.ai", "upstage.ai"],

  // Jamba (AI21 Labs)
  "jamba": ["api.ai21.com", "ai21.com"],
  "ai21": ["api.ai21.com", "ai21.com"],
};

/**
 * Check if URL matches official domain (whitelist-based)
 */
function matchesOfficialDomain(url: string, channelName: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Check exact match or subdomain match for this channel
    const domains = OFFICIAL_API_DOMAINS[channelName.toLowerCase()];
    if (domains) {
      return domains.some(domain =>
        hostname === domain || hostname.endsWith('.' + domain)
      );
    }

    // Check if hostname matches ANY official domain (for generic channels)
    const allOfficialDomains = Object.values(OFFICIAL_API_DOMAINS).flat();
    return allOfficialDomains.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch (err) {
    return false;
  }
}

/**
 * Classify a single channel
 */
function classifyChannel(
  channelName: string,
  authData: Record<string, any>,
  providerMeta: ProviderMeta
): ChannelClassification {
  const providerData = providerMeta[channelName];

  // 1. Check auth.json (authenticated channels)
  if (authData[channelName]) {
    // OAuth type is treated as official OAuth channel.
    if (authData[channelName].type === "oauth") {
      return {
        category: "oauth",
        reason: "OAuth official auth"
      };
    }

    // api_key type: official only when baseUrl matches official domain.
    if (providerData?.baseUrl && matchesOfficialDomain(providerData.baseUrl, channelName)) {
      return {
        category: "oauth",
        reason: "Official API"
      };
    }

    return {
      category: "aggregator",
      reason: "Third-party platform"
    };
  }
  
  // 2. Check baseUrl from models.json-derived provider metadata.
  if (providerData?.baseUrl) {
    const baseUrl = providerData.baseUrl;
    
    if (isLocalUrl(baseUrl)) {
      return {
        category: "free",
        reason: "Local deployment"
      };
    }
    
    if (matchesOfficialDomain(baseUrl, channelName)) {
      return {
        category: "oauth",
        reason: "Official domain"
      };
    }
    
    return {
      category: "aggregator",
      reason: "Third-party platform"
    };
  }
  
  // 3. Default to third-party.
  return {
    category: "aggregator",
    reason: "Third-party platform"
  };
}

/**
 * Scan and classify all channels from flattened PiModel[] returned by loadModelsJson().
 */
export function scanAndClassifyChannels(
  models: WizardPiModel[],
  authDataOverride?: Record<string, any>
): Map<string, ChannelClassification> {
  const result = new Map<string, ChannelClassification>();
  const authData = authDataOverride ?? loadAuthJson();
  const providerMeta: ProviderMeta = {};
  const allChannels = new Set<string>();
  
  Object.keys(authData).forEach(ch => allChannels.add(ch));
  
  for (const model of models) {
    allChannels.add(model.provider);
    const existing = providerMeta[model.provider];
    if (!existing || (!existing.baseUrl && model.baseUrl)) {
      providerMeta[model.provider] = { baseUrl: model.baseUrl };
    }
  }
  
  for (const channelName of allChannels) {
    const classification = classifyChannel(channelName, authData, providerMeta);
    result.set(channelName, classification);
  }
  
  return result;
}

// ============================================================================
// Smart Sorting
// ============================================================================

interface ChannelScore {
  channel: string;
  score: number;
  reason: string;
  category: string;
}

/**
 * Score a channel based on sort strategy
 */
function scoreChannel(
  channelName: string,
  category: string,
  sortBy: string
): ChannelScore {
  let score = 50;
  let reason = "";
  
  switch (sortBy) {
    case "cost":
      if (category === "free") {
        score = 100;
        reason = "Free self-hosted";
      } else if (category === "aggregator") {
        score = 70;
        reason = "Aggregator low price";
      } else if (category === "oauth") {
        score = 60;
        reason = "Official pricing";
      }
      break;
      
    case "capabilityFirst":
      if (category === "oauth") {
        score = 100;
        reason = "Official full features";
      } else if (category === "aggregator") {
        score = 80;
        reason = "Third-party stable";
      } else if (category === "free") {
        score = 60;
        reason = "Self-hosted may be limited";
      }
      break;
      
    case "latency":
      if (category === "aggregator") {
        score = 100;
        reason = "Global nodes low latency";
      } else if (category === "oauth") {
        score = 80;
        reason = "Official nodes";
      } else if (category === "free") {
        score = 70;
        reason = "Local deployment";
      }
      break;
      
    case "manual":
      score = 50;
      reason = "Manual order";
      break;
  }
  
  return { channel: channelName, score, reason, category };
}

/**
 * Smart sort channels based on strategy
 */
export function smartSortChannels(
  channels: string[],
  classifications: Map<string, ChannelClassification>,
  sortBy: string
): ChannelScore[] {
  return channels
    .map(ch => {
      const classification = classifications.get(ch);
      const category = classification?.category || "aggregator";
      return scoreChannel(ch, category, sortBy);
    })
    .sort((a, b) => b.score - a.score);
}

// ============================================================================
// Export for use in main index.ts
// ============================================================================

export type {
  WizardConfig,
  ChannelClassification,
  DiscoveredChannel,
  ModelWithChannels,
  ChannelScore
};
