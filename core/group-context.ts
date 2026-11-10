import { routeIncompatibility } from './routing-policy.js';

// These host adapters implement transformMessages and provider-specific tool-id/signature
// normalization. Unknown extension APIs are fine for fresh text, not foreign tool history.
const historyApis = new Set(['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai', 'google-vertex', 'bedrock-converse-stream']);
export function groupContextIncompatibility(model: any, context: any, options: any, tokens: number): string | undefined {
  if (![model.contextWindow, model.maxTokens].every(v => Number.isFinite(v) && v > 0) || !Array.isArray(model.input)) return 'required capability metadata unknown';
  const output = options?.maxTokens ?? model.maxTokens;
  if (!Number.isFinite(output) || output <= 0 || output > model.maxTokens) return 'output token limit exceeded/invalid';
  const basic = routeIncompatibility(model, context, { ...options, maxTokens: output }, tokens);
  if (basic) return basic;
  const pending = new Set<string>();
  let foreignHistory = false;
  for (const message of context.messages ?? []) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      if (pending.size) return 'unpaired tool calls; compact or repair history first';
      if (message.provider !== model.provider || message.model !== model.id || message.api !== model.api) {
        if (blocks.some((b: any) => b.type === 'thinking' || b.type === 'toolCall')) foreignHistory = true;
      }
      for (const block of blocks) if (block.type === 'toolCall') {
        if (!block.id || pending.has(block.id)) return 'invalid/duplicate tool call id';
        pending.add(block.id);
      }
    } else if (message.role === 'toolResult') {
      if (!pending.delete(message.toolCallId)) return 'orphan or duplicate tool result';
    } else if (message.role === 'user' && pending.size) return 'unpaired tool calls';
  }
  if (pending.size) return 'unpaired tool calls';
  if (foreignHistory && !historyApis.has(model.api)) return 'foreign reasoning/tool history requires a known host conversion adapter';
  if (context.tools?.length && model.compat?.supportsTools !== true && !historyApis.has(model.api)) return 'tools capability unknown for custom API';
  return undefined;
}

/** Conservative common catalog; unresolved leaves never receive invented capabilities. */
export function commonGroupCapabilities(models: any[]): any | undefined {
  if (!models.length || models.some(m => !Array.isArray(m.input) || ![m.contextWindow, m.maxTokens].every(v => Number.isFinite(v) && v > 0))) return undefined;
  const input = models[0].input.filter((kind: string) => models.every(m => m.input.includes(kind)));
  if (!input.length) return undefined;
  const firstMap = models[0].thinkingLevelMap;
  const thinkingLevelMap = firstMap && Object.fromEntries(Object.entries(firstMap).filter(([key, value]) => models.every(m => JSON.stringify(m.thinkingLevelMap?.[key]) === JSON.stringify(value))));
  return {
    input, contextWindow: Math.min(...models.map(m => m.contextWindow)), maxTokens: Math.min(...models.map(m => m.maxTokens)),
    reasoning: models.every(m => !!m.reasoning) && models.every(m => JSON.stringify(m.reasoning) === JSON.stringify(models[0].reasoning)) ? models[0].reasoning : false,
    ...(thinkingLevelMap && Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
    compat: { supportsTools: models.every(m => m.compat?.supportsTools !== false && (m.compat?.supportsTools === true || historyApis.has(m.api))) },
  };
}
