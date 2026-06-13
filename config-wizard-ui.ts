/**
 * Interactive Components for Configuration Wizard
 */

import { Container, Text, SelectList, type SelectItem, matchesKey, Key, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ChannelScore } from "./config-wizard.js";

// ============================================================================
// Channel Order Editor Component
// ============================================================================

type EditState = "browsing" | "moving";

export class ChannelOrderEditor implements Component {
  private models: Array<{
    id: string;
    channels: Array<{ 
      name: string; 
      reason: string;
      category: string;
      fixed: boolean;
    }>;
  }>;
  
  private currentModelIndex = 0;
  private currentChannelIndex = 0;
  private state: EditState = "browsing";
  private movingFromIndex?: number;
  
  private cachedWidth?: number;
  private cachedLines?: string[];
  
  // Viewport state for scrolling
  private viewportHeight = 20;  // Default visible lines for channel list
  private scrollOffset = 0;     // Current scroll position
  
  public onSkip?: () => void;
  public onComplete?: () => void;
  
  constructor(
    models: Array<{
      id: string;
      channels: ChannelScore[];
    }>,
    private theme: any
  ) {
    this.models = models.map(m => ({
      id: m.id,
      channels: m.channels.map(ch => ({
        name: ch.channel,
        reason: ch.reason,
        category: ch.category,
        fixed: false
      }))
    }));
  }
  
  handleInput(data: string): void {
    const model = this.models[this.currentModelIndex];
    if (!model) return;
    
    const channel = model.channels[this.currentChannelIndex];
    
    if (this.state === "browsing") {
      // === Browsing mode ===
      if (matchesKey(data, Key.up)) {
        if (this.currentChannelIndex > 0) {
          this.currentChannelIndex--;
        } else {
          // Wrap to previous model's last channel
          if (this.currentModelIndex > 0) {
            this.currentModelIndex--;
            this.currentChannelIndex = this.models[this.currentModelIndex].channels.length - 1;
          }
        }
        this.ensureCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.down)) {
        const maxIndex = model.channels.length - 1;
        if (this.currentChannelIndex < maxIndex) {
          this.currentChannelIndex++;
        } else {
          // Wrap to next model's first channel
          if (this.currentModelIndex < this.models.length - 1) {
            this.currentModelIndex++;
            this.currentChannelIndex = 0;
          }
        }
        this.ensureCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        // Enter moving mode
        this.state = "moving";
        this.movingFromIndex = this.currentChannelIndex;
        if (channel) channel.fixed = false;
        this.invalidate();
      } else if (matchesKey(data, Key.tab)) {
        // Switch to next model
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;
        this.currentChannelIndex = 0;
        this.scrollOffset = 0;
        this.ensureCursorVisible();
        this.invalidate();
      } else if (data === "s" || data === "S") {
        this.onSkip?.();
      } else if (data === "c" || data === "C") {
        this.onComplete?.();
      } else if (matchesKey(data, Key.escape)) {
        this.onSkip?.();
      }
      
    } else if (this.state === "moving") {
      // === Moving mode ===
      if (matchesKey(data, Key.up)) {
        this.moveChannelUp();
        this.ensureCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.down)) {
        this.moveChannelDown();
        this.ensureCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        // Confirm position
        if (channel) channel.fixed = true;
        this.state = "browsing";
        this.movingFromIndex = undefined;
        this.invalidate();
      } else if (matchesKey(data, Key.escape)) {
        // Cancel move
        if (this.movingFromIndex !== undefined) {
          this.restoreChannelPosition(this.movingFromIndex);
        }
        this.state = "browsing";
        this.movingFromIndex = undefined;
        this.invalidate();
      }
    }
  }
  
  /**
   * Ensure the cursor position is visible within the viewport
   */
  private ensureCursorVisible(): void {
    // Calculate the absolute line position of the cursor within the channel list
    const cursorLineInList = this.getCursorAbsoluteLine();
    const totalLines = this.getTotalChannelLines();

    // Adjust viewport height based on total items
    this.viewportHeight = Math.min(20, totalLines);

    // Scroll up if cursor is above viewport
    if (cursorLineInList < this.scrollOffset) {
      this.scrollOffset = cursorLineInList;
    }

    // Scroll down if cursor is below viewport
    if (cursorLineInList >= this.scrollOffset + this.viewportHeight) {
      this.scrollOffset = cursorLineInList - this.viewportHeight + 1;
    }

    // Clamp scroll offset
    const maxScroll = Math.max(0, totalLines - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    // Invalidate cache since scrollOffset changed
    this.invalidate();
  }
  
  /**
   * Get the absolute line index of the cursor within the flattened channel list
   */
  private getCursorAbsoluteLine(): number {
    let line = 0;
    for (let mIdx = 0; mIdx < this.models.length; mIdx++) {
      // Model header line
      line++;
      
      if (mIdx === this.currentModelIndex) {
        return line + this.currentChannelIndex;
      }
      
      line += this.models[mIdx].channels.length;
    }
    return line;
  }
  
  /**
   * Get total number of lines in the channel list (headers + channels)
   */
  private getTotalChannelLines(): number {
    let total = 0;
    for (const model of this.models) {
      total++; // model header
      total += model.channels.length;
    }
    return total;
  }
  
  render(width: number): string[] {
    // Don't use cache if scrollOffset changed (ensureCursorVisible invalidates cache)
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    
    const lines: string[] = [];
    
    // Title
    lines.push(this.theme.fg("accent", this.theme.bold("Step 6/6: Adjust Channel Order")));
    lines.push("");
    
    // Current model/channel info
    const model = this.models[this.currentModelIndex];
    if (model) {
      const ch = model.channels[this.currentChannelIndex];
      const posInfo = `[${this.currentChannelIndex + 1}/${model.channels.length}]`;
      const modelInfo = this.models.length > 1 
        ? `Model ${this.currentModelIndex + 1}/${this.models.length}: ${model.id}` 
        : `Model: ${model.id}`;
      lines.push(this.theme.fg("dim", `${modelInfo}  ${posInfo}`));
    }
    lines.push("");
    
    // Build the full channel list with headers
    const channelListLines: Array<{ text: string; isHeader: boolean; modelIdx: number; channelIdx: number }> = [];
    
    this.models.forEach((m, modelIdx) => {
      // Model header
      const headerPrefix = modelIdx === this.currentModelIndex ? "▶ " : "  ";
      channelListLines.push({
        text: this.theme.fg("accent", `${headerPrefix}${m.id} (${m.channels.length} channels)`),
        isHeader: true,
        modelIdx,
        channelIdx: -1,
      });
      
      // Channels
      m.channels.forEach((ch, chIdx) => {
        const isCurrent = modelIdx === this.currentModelIndex && chIdx === this.currentChannelIndex;
        
        // Build prefix/marker
        let marker = "    ";
        if (isCurrent && this.state === "moving") {
          marker = " ◆→ ";
        } else if (isCurrent) {
          marker = " ▸  ";
        } else if (ch.fixed) {
          marker = " ✓  ";
        }
        
        const num = `${chIdx + 1}.`.padEnd(3);
        const name = ch.name.padEnd(18);
        const reason = ch.reason.length > 20 ? ch.reason.substring(0, 17) + "..." : ch.reason.padEnd(20);
        const cat = `[${ch.category}]`;
        
        let lineText = `${marker}${num} ${name} ${reason} ${cat}`;
        
        // Apply styling
        if (isCurrent && this.state === "moving") {
          lineText = this.theme.bg("selectedBg", this.theme.fg("accent", lineText));
        } else if (isCurrent) {
          lineText = this.theme.fg("accent", lineText);
        } else if (ch.fixed) {
          lineText = this.theme.fg("success", lineText);
        }
        
        channelListLines.push({
          text: lineText,
          isHeader: false,
          modelIdx,
          channelIdx: chIdx,
        });
      });
    });
    
    // Apply viewport scrolling
    const totalLines = channelListLines.length;
    const visibleHeight = Math.min(this.viewportHeight, totalLines);
    const startIdx = this.scrollOffset;
    const endIdx = Math.min(startIdx + visibleHeight, totalLines);
    
    // Scroll indicator (top)
    if (startIdx > 0) {
      lines.push(this.theme.fg("dim", `  ↑ ${startIdx} more above`));
    }
    
    // Visible lines
    for (let i = startIdx; i < endIdx; i++) {
      lines.push(channelListLines[i].text);
    }
    
    // Scroll indicator (bottom)
    const remaining = totalLines - endIdx;
    if (remaining > 0) {
      lines.push(this.theme.fg("dim", `  ↓ ${remaining} more below`));
    }
    
    // Instructions
    lines.push("");
    if (this.state === "browsing") {
      lines.push(this.theme.fg("dim", "↑↓ navigate • enter select • tab switch model • s skip • c complete"));
    } else {
      lines.push(this.theme.fg("accent", "[MOVING] ↑↓ reorder • enter confirm • esc cancel"));
    }
    
    this.cachedLines = lines.map(line => truncateToWidth(line, width));
    this.cachedWidth = width;
    return this.cachedLines;
  }
  
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
  
  private moveChannelUp(): void {
    const model = this.models[this.currentModelIndex];
    const idx = this.currentChannelIndex;
    if (idx > 0) {
      [model.channels[idx], model.channels[idx - 1]] = 
      [model.channels[idx - 1], model.channels[idx]];
      this.currentChannelIndex--;
    }
  }
  
  private moveChannelDown(): void {
    const model = this.models[this.currentModelIndex];
    const idx = this.currentChannelIndex;
    if (idx < model.channels.length - 1) {
      [model.channels[idx], model.channels[idx + 1]] = 
      [model.channels[idx + 1], model.channels[idx]];
      this.currentChannelIndex++;
    }
  }
  
  private restoreChannelPosition(originalIndex: number): void {
    const model = this.models[this.currentModelIndex];
    const currentIdx = this.currentChannelIndex;
    
    if (currentIdx === originalIndex) return;
    
    const channel = model.channels[currentIdx];
    model.channels.splice(currentIdx, 1);
    model.channels.splice(originalIndex, 0, channel);
    this.currentChannelIndex = originalIndex;
  }
  
  getResult(): Array<{ id: string; channels: string[] }> {
    return this.models.map(m => ({
      id: m.id,
      channels: m.channels.map(ch => ch.name)
    }));
  }
}

// ============================================================================
// Step Component (Reusable for each wizard step)
// ============================================================================

export function createStepComponent(
  stepNum: number,
  totalSteps: number,
  title: string,
  items: SelectItem[],
  theme: any,
  onSelect: (value: string) => void,
  onCancel: () => void
) {
  const container = new Container();
  
  // Top border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  
  // Title
  const titleText = `${title} (${stepNum}/${totalSteps})`;
  container.addChild(new Text(theme.fg("accent", theme.bold(titleText)), 1, 0));
  container.addChild(new Text("", 0, 0));
  
  // SelectList
  const selectList = new SelectList(items, Math.min(items.length, 8), {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  });
  selectList.onSelect = (item) => onSelect(item.value);
  selectList.onCancel = onCancel;
  container.addChild(selectList);
  
  // Help text
  container.addChild(new Text("", 0, 0));
  container.addChild(new Text(theme.fg("dim", "↑↓ select • enter confirm • esc cancel"), 1, 0));
  
  // Bottom border
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  
  return {
    container,
    selectList
  };
}
