/**
 * Flat order editor for custom strategy
 * Shows all model@channel pairs in a single flat list
 */

import { matchesKey, Key, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ChannelScore } from "./config-wizard.js";

type EditState = "browsing" | "moving";

export class FlatOrderEditor implements Component {
  private items: Array<{
    model: string;
    channel: string;
    routeKey: string;
    upstreamModel?: string;
    label: string;
    reason: string;
    category: string;
  }>;

  // UI state
  private state: EditState = "browsing";
  private currentIndex = 0;
  private movingFromIndex?: number;

  // Viewport state
  private viewportHeight = 10;  // Conservative value to ensure cursor always visible with dynamic footer
  private scrollOffset = 0;

  // Cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  public onSkip?: () => void;
  public onComplete?: () => void;

  constructor(
    models: Array<{
      id: string;
      channels: ChannelScore[];
    }>,
    private theme: any,
    initialOrder?: string[]  // Optional initial customOrder
  ) {
    // Build flat list from models
    this.items = [];
    const seen = new Set<string>();

    if (initialOrder && initialOrder.length > 0) {
      // Use provided order first
      for (const item of initialOrder) {
        // FIX #4: Validate format before splitting
        if (!item || typeof item !== 'string' || !item.includes('@')) {
          console.warn(`[pi-router] Invalid custom order entry (missing '@'): ${item}`);
          continue;
        }

        const parts = item.split("@");
        if (parts.length !== 2) {
          console.warn(`[pi-router] Invalid custom order entry (malformed): ${item}`);
          continue;
        }

        const [modelId, channelName] = parts;
        const model = models.find(m => m.id === modelId);
        if (!model) continue;

        const channel = model.channels.find(ch => (ch.routeKey || ch.channel) === channelName || ch.channel === channelName);
        if (!channel) continue;

        const key = `${modelId}@${channel.routeKey || channel.channel}`;
        if (seen.has(key)) continue;
        seen.add(key);

        this.items.push({
          model: modelId,
          channel: channel.channel,
          routeKey: channel.routeKey || channel.channel,
          upstreamModel: channel.upstreamModel,
          label: channel.label || (channel.upstreamModel && channel.upstreamModel !== modelId ? `${channel.channel} (${channel.upstreamModel})` : channel.channel),
          reason: channel.reason,
          category: channel.category,
        });
      }
    }

    // Append any newly discovered model@channel pairs that were not present in
    // the saved custom order, using the default model-first layout.
    const maxChannels = Math.max(...models.map(m => m.channels.length));

    for (let i = 0; i < maxChannels; i++) {
      for (const model of models) {
        if (i >= model.channels.length) continue;

        const ch = model.channels[i];
        const key = `${model.id}@${ch.routeKey || ch.channel}`;
        if (seen.has(key)) continue;
        seen.add(key);

        this.items.push({
          model: model.id,
          channel: ch.channel,
          routeKey: ch.routeKey || ch.channel,
          upstreamModel: ch.upstreamModel,
          label: ch.label || (ch.upstreamModel && ch.upstreamModel !== model.id ? `${ch.channel} (${ch.upstreamModel})` : ch.channel),
          reason: ch.reason,
          category: ch.category,
        });
      }
    }

    // Ensure cursor is visible on init
    this.ensureCursorVisible();
  }

  handleInput(data: string): void {
    if (this.state === "browsing") {
      this.handleBrowsingInput(data);
    } else {
      this.handleMovingInput(data);
    }
  }

  private handleBrowsingInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      if (this.currentIndex > 0) {
        this.currentIndex--;
        this.ensureCursorVisible();
        this.invalidate();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.currentIndex < this.items.length - 1) {
        this.currentIndex++;
        this.ensureCursorVisible();
        this.invalidate();
      }
    } else if (matchesKey(data, Key.enter)) {
      // Enter moving mode
      this.state = "moving";
      this.movingFromIndex = this.currentIndex;
      this.invalidate();
    } else if (data === "s" || data === "S") {
      this.onSkip?.();
    } else if (data === "c" || data === "C") {
      this.onComplete?.();
    } else if (matchesKey(data, Key.escape)) {
      this.onSkip?.();
    }
  }

  private handleMovingInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.moveItemUp();
      this.ensureCursorVisible();
      this.invalidate();
    } else if (matchesKey(data, Key.down)) {
      this.moveItemDown();
      this.ensureCursorVisible();
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      // Confirm position
      this.state = "browsing";
      this.movingFromIndex = undefined;
      this.invalidate();
    } else if (matchesKey(data, Key.escape)) {
      // Cancel move
      if (this.movingFromIndex !== undefined) {
        this.restoreItemPosition(this.movingFromIndex);
      }
      this.state = "browsing";
      this.movingFromIndex = undefined;
      this.invalidate();
    }
  }

  render(width: number): string[] {
    // Always ensure cursor is visible before rendering
    // This handles the initial render case
    const itemCount = this.items.length;

    // Calculate available height for items
    // Use conservative value (10 lines) to ensure cursor visibility
    // even with dynamic pi footer (which can vary with loaded extensions)
    const calculatedViewportHeight = Math.min(10, itemCount);

    // Update scrollOffset to ensure cursor is visible
    if (this.currentIndex < this.scrollOffset) {
      this.scrollOffset = this.currentIndex;
    }

    if (this.currentIndex >= this.scrollOffset + calculatedViewportHeight) {
      this.scrollOffset = this.currentIndex - calculatedViewportHeight + 1;
    }

    const maxScroll = Math.max(0, itemCount - calculatedViewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    this.viewportHeight = calculatedViewportHeight;

    // Check cache after ensuring cursor visibility
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    lines.push(this.theme.fg("accent", this.theme.bold("Step 6/6: Adjust Order (Custom Mode)")));
    lines.push("");
    lines.push(this.theme.fg("dim", `All model@channel combinations  [${this.currentIndex + 1}/${this.items.length}]`));
    lines.push(this.theme.fg("dim", "Freely reorder any item"));
    lines.push("");

    // Build item list
    const itemListLines: Array<{ text: string; index: number }> = [];

    this.items.forEach((item, idx) => {
      const isCurrent = idx === this.currentIndex;

      // Build marker
      let marker = "  ";
      if (isCurrent && this.state === "moving") {
        marker = "◆→";
      } else if (isCurrent) {
        marker = "▸ ";
      }

      const num = `${idx + 1}.`.padEnd(4);
      const pair = `${item.model}@${item.label}`.padEnd(35);
      const reason = item.reason.length > 18 ? item.reason.substring(0, 15) + "..." : item.reason.padEnd(18);
      const cat = `[${item.category}]`;

      let lineText = `${marker} ${num} ${pair} ${reason} ${cat}`;

      // Apply styling
      if (isCurrent && this.state === "moving") {
        lineText = this.theme.bg("selectedBg", this.theme.fg("accent", lineText));
      } else if (isCurrent) {
        lineText = this.theme.fg("accent", lineText);
      }

      itemListLines.push({ text: lineText, index: idx });
    });

    // Apply viewport scrolling
    const totalLines = itemListLines.length;
    const visibleHeight = Math.min(this.viewportHeight, totalLines);
    const startIdx = this.scrollOffset;
    const endIdx = Math.min(startIdx + visibleHeight, totalLines);

    // Scroll indicator (top)
    if (startIdx > 0) {
      lines.push(this.theme.fg("dim", `  ↑ ${startIdx} more above`));
    }

    // Visible lines
    for (let i = startIdx; i < endIdx; i++) {
      lines.push(itemListLines[i].text);
    }

    // Scroll indicator (bottom)
    const remaining = totalLines - endIdx;
    if (remaining > 0) {
      lines.push(this.theme.fg("dim", `  ↓ ${remaining} more below`));
    }

    // Instructions
    lines.push("");
    if (this.state === "browsing") {
      lines.push(this.theme.fg("dim", "↑↓ navigate • enter select • s skip • c complete"));
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

  private ensureCursorVisible(): void {
    const totalLines = this.items.length;
    this.viewportHeight = Math.min(20, totalLines);

    if (this.currentIndex < this.scrollOffset) {
      this.scrollOffset = this.currentIndex;
    }

    if (this.currentIndex >= this.scrollOffset + this.viewportHeight) {
      this.scrollOffset = this.currentIndex - this.viewportHeight + 1;
    }

    const maxScroll = Math.max(0, totalLines - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    this.invalidate();
  }

  private moveItemUp(): void {
    const idx = this.currentIndex;
    if (idx > 0) {
      [this.items[idx], this.items[idx - 1]] = [this.items[idx - 1], this.items[idx]];
      this.currentIndex--;
    }
  }

  private moveItemDown(): void {
    const idx = this.currentIndex;
    if (idx < this.items.length - 1) {
      [this.items[idx], this.items[idx + 1]] = [this.items[idx + 1], this.items[idx]];
      this.currentIndex++;
    }
  }

  private restoreItemPosition(originalIndex: number): void {
    const currentIdx = this.currentIndex;

    if (currentIdx === originalIndex) return;

    const item = this.items[currentIdx];
    this.items.splice(currentIdx, 1);
    this.items.splice(originalIndex, 0, item);
    this.currentIndex = originalIndex;
  }

  getResult(): string[] {
    return this.items.map(item => `${item.model}@${item.routeKey}`);
  }
}
