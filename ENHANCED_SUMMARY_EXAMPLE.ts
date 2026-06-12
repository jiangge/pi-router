/**
 * Enhanced simple text summary (no AI required)
 * 
 * Uses heuristic rules to extract key information from conversation:
 * 1. Last user message (current task)
 * 2. Key decisions and actions
 * 3. Error messages and warnings
 * 4. Code snippets or file names
 * 5. Recent topics
 */
function generateEnhancedTextSummary(
  messages: any[],
  fromModel: PiModel,
  toModel: PiModel
): string {
  const userMessages = messages.filter(m => m.role === "user");
  const assistantMessages = messages.filter(m => m.role === "assistant");
  
  // 1. Extract last user message (current task)
  const lastUserMessage = userMessages[userMessages.length - 1];
  const lastUserContent = lastUserMessage
    ? extractContent(lastUserMessage)
    : "(no user message)";
  
  // 2. Extract key decisions (messages with decision keywords)
  const decisions = messages
    .filter(m => {
      const content = extractContent(m);
      return /决定|决策|选择|使用|采用|implement|decide|choose/i.test(content);
    })
    .slice(-3)
    .map(m => `- ${extractContent(m).substring(0, 100)}`);
  
  // 3. Extract errors and warnings
  const errors = messages
    .filter(m => {
      const content = extractContent(m);
      return /错误|失败|error|fail|warning|exception/i.test(content);
    })
    .slice(-2)
    .map(m => `- ${extractContent(m).substring(0, 100)}`);
  
  // 4. Extract file names and code references
  const files = new Set<string>();
  const codePattern = /`([^`]+\.(ts|js|json|md|py|go|rs))`/g;
  messages.forEach(m => {
    const content = extractContent(m);
    let match;
    while ((match = codePattern.exec(content)) !== null) {
      files.add(match[1]);
    }
  });
  
  // 5. Extract recent topics (simple keyword extraction)
  const topics = extractTopics(messages);
  
  // Build enhanced summary
  const lines: string[] = [
    "[Context Transfer Summary - Enhanced Mode]",
    "",
    "Model Switch:",
    `  From: ${fromModel.id}@${fromModel.provider}`,
    `  To: ${toModel.id}@${toModel.provider}`,
    "",
    "Conversation Stats:",
    `  Total messages: ${messages.length}`,
    `  User messages: ${userMessages.length}`,
    `  Assistant messages: ${assistantMessages.length}`,
    "",
    "Current Task:",
    lastUserContent.substring(0, 500) + (lastUserContent.length > 500 ? "..." : ""),
  ];
  
  if (decisions.length > 0) {
    lines.push("");
    lines.push("Recent Decisions:");
    lines.push(...decisions);
  }
  
  if (errors.length > 0) {
    lines.push("");
    lines.push("Recent Issues:");
    lines.push(...errors);
  }
  
  if (files.size > 0) {
    lines.push("");
    lines.push("Files Mentioned:");
    Array.from(files).slice(0, 5).forEach(f => lines.push(`  - ${f}`));
  }
  
  if (topics.length > 0) {
    lines.push("");
    lines.push("Topics:");
    topics.forEach(t => lines.push(`  - ${t}`));
  }
  
  lines.push("");
  lines.push("Note: This is a rule-based summary (no AI). Quality may be limited.");
  
  return lines.join("\\n");
}

/**
 * Extract content from message
 */
function extractContent(message: any): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join(" ");
  }
  return JSON.stringify(message.content);
}

/**
 * Extract topics using simple keyword patterns
 */
function extractTopics(messages: any[]): string[] {
  const topics = new Set<string>();
  const recentMessages = messages.slice(-10);
  
  const patterns = [
    // Actions
    /(?:implement|create|build|develop|write|fix|debug|解决|实现|创建)\\s+([\\w\\s-]+?)(?:\\.|,|;|:|$)/i,
    // Technologies
    /(?:use|using|with|采用)\\s+(\\w+(?:\\.\\w+)?(?:\\s+\\w+)?)(?:\\s+|$)/i,
    // Files
    /(?:in|file|文件)\\s+`?([\\w-]+\\.[\\w]+)`?/i,
  ];
  
  for (const msg of recentMessages) {
    const content = extractContent(msg);
    
    for (const pattern of patterns) {
      const matches = content.matchAll(new RegExp(pattern.source, pattern.flags + "g"));
      for (const match of matches) {
        if (match[1]) {
          const topic = match[1].trim();
          if (topic.length >= 3 && topic.length <= 50 && !/^\\d+$/.test(topic)) {
            topics.add(topic);
            if (topics.size >= 5) return Array.from(topics);
          }
        }
      }
    }
  }
  
  return Array.from(topics);
}
