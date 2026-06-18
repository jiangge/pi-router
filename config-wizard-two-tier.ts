/**
 * Two-tier order editor for channelFirst strategy
 * Layer 1: Model order
 * Layer 2: Channel order within each model
 */

import { matchesKey, Key, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ChannelScore } from "./config-wizard.js";
import { serializeRouteEntriesForConfig } from "./router-routes.js";

type EditMode = "model" | "channel";
type EditState = "browsing" | "moving";

export class TwoTierOrderEditor implements Component {
  private models: Array<{
    id: string;
    channels: Array<{
      name: string;
      label: string;
      routeKey: string;
      upstreamModel?: string;
      reason: string;
      category: string;
      fixed: boolean;
    }>;
  }>;

  // UI state
  private mode: EditMode = "model";  // Start with model-level editing
  private state: EditState = "browsing";

  // Model-level navigation
  private currentModelIndex = 0;
  private movingModelFromIndex?: number;

  // Channel-level navigation (when mode === "channel")
  private currentChannelIndex = 0;
  private movingChannelFromIndex?: number;

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
    private theme: any
  ) {
    this.models = models.map(m => ({
      id: m.id,
      channels: m.channels.map(ch => ({
        name: ch.channel,
        label: ch.label || (ch.upstreamModel && ch.upstreamModel !== m.id ? `${ch.channel} (${ch.upstreamModel})` : ch.channel),
        routeKey: ch.routeKey || ch.channel,
        upstreamModel: ch.upstreamModel,
        reason: ch.reason,
        category: ch.category,
        fixed: false
      }))
    }));
  }

  handleInput(data: string): void {
    if (this.mode === "model") {
      this.handleModelInput(data);
    } else {
      this.handleChannelInput(data);
    }
  }

  private handleModelInput(data: string): void {
    if (this.state === "browsing") {
      if (matchesKey(data, Key.up)) {
        if (this.currentModelIndex > 0) {
          this.currentModelIndex--;
          this.ensureModelCursorVisible();
          this.invalidate();
        }
      } else if (matchesKey(data, Key.down)) {
        if (this.currentModelIndex < this.models.length - 1) {
          this.currentModelIndex++;
          this.ensureModelCursorVisible();
          this.invalidate();
        }
      } else if (matchesKey(data, Key.enter)) {
        // Enter moving mode
        this.state = "moving";
        this.movingModelFromIndex = this.currentModelIndex;
        this.invalidate();
      } else if (matchesKey(data, Key.tab) || data === "n" || data === "N") {
        // Switch to channel-level editing
        this.mode = "channel";
        this.currentChannelIndex = 0;
        this.scrollOffset = 0;
        this.invalidate();
      } else if (data === "s" || data === "S") {
        this.onSkip?.();
      } else if (data === "c" || data === "C") {
        this.onComplete?.();
      } else if (matchesKey(data, Key.escape)) {
        this.onSkip?.();
      }
    } else {
      // Moving state
      if (matchesKey(data, Key.up)) {
        this.moveModelUp();
        this.ensureModelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.down)) {
        this.moveModelDown();
        this.ensureModelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        // Confirm position
        this.state = "browsing";
        this.movingModelFromIndex = undefined;
        this.invalidate();
      } else if (matchesKey(data, Key.escape)) {
        // Cancel move
        if (this.movingModelFromIndex !== undefined) {
          this.restoreModelPosition(this.movingModelFromIndex);
        }
        this.state = "browsing";
        this.movingModelFromIndex = undefined;
        this.invalidate();
      }
    }
  }

  private handleChannelInput(data: string): void {
    const model = this.models[this.currentModelIndex];
    if (!model) return;

    const channel = model.channels[this.currentChannelIndex];

    if (this.state === "browsing") {
      if (matchesKey(data, Key.up)) {
        // Navigate within current model only
        if (this.currentChannelIndex > 0) {
          this.currentChannelIndex--;
          this.ensureChannelCursorVisible();
          this.invalidate();
        }
      } else if (matchesKey(data, Key.down)) {
        // Navigate within current model only
        const maxIndex = model.channels.length - 1;
        if (this.currentChannelIndex < maxIndex) {
          this.currentChannelIndex++;
          this.ensureChannelCursorVisible();
          this.invalidate();
        }
      } else if (matchesKey(data, Key.enter)) {
        // Enter moving mode
        this.state = "moving";
        this.movingChannelFromIndex = this.currentChannelIndex;
        if (channel) channel.fixed = false;
        this.invalidate();
      } else if (matchesKey(data, Key.tab) || data === "b" || data === "B") {
        // Back to model-level editing
        this.mode = "model";
        this.scrollOffset = 0;
        this.invalidate();
      } else if (data === "n" || data === "N") {
        // Next model (if available)
        if (this.currentModelIndex < this.models.length - 1) {
          this.currentModelIndex++;
          this.currentChannelIndex = 0;
          this.scrollOffset = 0;
          this.invalidate();
        }
      } else if (data === "p" || data === "P") {
        // Previous model (if available)
        if (this.currentModelIndex > 0) {
          this.currentModelIndex--;
          this.currentChannelIndex = 0;
          this.scrollOffset = 0;
          this.invalidate();
        }
      } else if (data === "s" || data === "S") {
        this.onSkip?.();
      } else if (data === "c" || data === "C") {
        this.onComplete?.();
      } else if (matchesKey(data, Key.escape)) {
        // Back to model-level
        this.mode = "model";
        this.scrollOffset = 0;
        this.invalidate();
      }
    } else {
      // Moving state
      if (matchesKey(data, Key.up)) {
        this.moveChannelUp();
        this.ensureChannelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.down)) {
        this.moveChannelDown();
        this.ensureChannelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        // Confirm position
        if (channel) channel.fixed = true;
        this.state = "browsing";
        this.movingChannelFromIndex = undefined;
        this.invalidate();
      } else if (matchesKey(data, Key.escape)) {
        // Cancel move
        if (this.movingChannelFromIndex !== undefined) {
          this.restoreChannelPosition(this.movingChannelFromIndex);
        }
        this.state = "browsing";
        this.movingChannelFromIndex = undefined;
        this.invalidate();
      }
    }
  }

  render(width: number): string[] {
    // Always ensure cursor is visible before rendering
    // Calculate based on current mode
    if (this.mode === "model") {
      const modelCount = this.models.length;
      const calculatedViewportHeight = Math.min(10, modelCount);

      // Update scrollOffset to ensure cursor is visible
      if (this.currentModelIndex < this.scrollOffset) {
        this.scrollOffset = this.currentModelIndex;
      }

      if (this.currentModelIndex >= this.scrollOffset + calculatedViewportHeight) {
        this.scrollOffset = this.currentModelIndex - calculatedViewportHeight + 1;
      }

      const maxScroll = Math.max(0, modelCount - calculatedViewportHeight);
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
      this.viewportHeight = calculatedViewportHeight;
    } else {
      // Channel mode
      const channelCount = this.models[this.currentModelIndex].channels.length;
      const calculatedViewportHeight = Math.min(10, channelCount);

      // Update scrollOffset to ensure cursor is visible
      if (this.currentChannelIndex < this.scrollOffset) {
        this.scrollOffset = this.currentChannelIndex;
      }

      if (this.currentChannelIndex >= this.scrollOffset + calculatedViewportHeight) {
        this.scrollOffset = this.currentChannelIndex - calculatedViewportHeight + 1;
      }

      const maxScroll = Math.max(0, channelCount - calculatedViewportHeight);
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
      this.viewportHeight = calculatedViewportHeight;
    }

    // Check cache after ensuring cursor visibility
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    if (this.mode === "model") {
      this.renderModelMode(lines, width);
    } else {
      this.renderChannelMode(lines, width);
    }

    this.cachedLines = lines.map(line => truncateToWidth(line, width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderModelMode(lines: string[], _width: number): void {
    lines.push(this.theme.fg("accent", this.theme.bold("Step 6/6: Adjust Order (Layer 1: Model Order)")));
    lines.push("");
    lines.push(this.theme.fg("dim", `Adjusting model order  [${this.currentModelIndex + 1}/${this.models.length}]`));
    lines.push("");

    // Build model list
    const modelListLines: Array<{ text: string; modelIdx: number }> = [];

    this.models.forEach((m, modelIdx) => {
      const isCurrent = modelIdx === this.currentModelIndex;

      // Build marker
      let marker = "  ";
      if (isCurrent && this.state === "moving") {
        marker = "◆→";
      } else if (isCurrent) {
        marker = "▸ ";
      } else {
        marker = "  ";
      }

      const num = `${modelIdx + 1}.`.padEnd(3);
      const name = m.id.padEnd(25);
      const count = `(${m.channels.length} channels)`;

      let lineText = `${marker} ${num} ${name} ${count}`;

      // Apply styling
      if (isCurrent && this.state === "moving") {
        lineText = this.theme.bg("selectedBg", this.theme.fg("accent", lineText));
      } else if (isCurrent) {
        lineText = this.theme.fg("accent", lineText);
      }

      modelListLines.push({ text: lineText, modelIdx });
    });

    // Apply viewport scrolling
    const totalLines = modelListLines.length;
    const visibleHeight = Math.min(this.viewportHeight, totalLines);
    const startIdx = this.scrollOffset;
    const endIdx = Math.min(startIdx + visibleHeight, totalLines);

    // Scroll indicator (top)
    if (startIdx > 0) {
      lines.push(this.theme.fg("dim", `  ↑ ${startIdx} more above`));
    }

    // Visible lines
    for (let i = startIdx; i < endIdx; i++) {
      lines.push(modelListLines[i].text);
    }

    // Scroll indicator (bottom)
    const remaining = totalLines - endIdx;
    if (remaining > 0) {
      lines.push(this.theme.fg("dim", `  ↓ ${remaining} more below`));
    }

    // Instructions
    lines.push("");
    if (this.state === "browsing") {
      lines.push(this.theme.fg("dim", "↑↓ navigate • enter select • tab/n next(channels) • s skip • c complete"));
    } else {
      lines.push(this.theme.fg("accent", "[MOVING] ↑↓ reorder • enter confirm • esc cancel"));
    }
  }

  private renderChannelMode(lines: string[], _width: number): void {
    lines.push(this.theme.fg("accent", this.theme.bold("Step 6/6: Adjust Order (Layer 2: Channel Order)")));
    lines.push("");

    // Current model info
    const model = this.models[this.currentModelIndex];
    if (!model) return;

    const posInfo = `[${this.currentChannelIndex + 1}/${model.channels.length}]`;
    const modelInfo = this.models.length > 1
      ? `Model ${this.currentModelIndex + 1}/${this.models.length}: ${model.id}`
      : `Model: ${model.id}`;
    lines.push(this.theme.fg("dim", `${modelInfo}  ${posInfo}`));
    lines.push("");

    // Build channel list for CURRENT MODEL ONLY
    const channelListLines: Array<{ text: string; channelIdx: number }> = [];

    model.channels.forEach((ch, chIdx) => {
      const isCurrent = chIdx === this.currentChannelIndex;

      // Build prefix/marker
      let marker = "  ";
      if (isCurrent && this.state === "moving") {
        marker = "◆→";
      } else if (isCurrent) {
        marker = "▸ ";
      } else if (ch.fixed) {
        marker = "✓ ";
      }

      const num = `${chIdx + 1}.`.padEnd(4);
      const name = ch.label.padEnd(18);
      const reason = ch.reason.length > 20 ? ch.reason.substring(0, 17) + "..." : ch.reason.padEnd(20);
      const cat = `[${ch.category}]`;

      let lineText = `${marker} ${num} ${name} ${reason} ${cat}`;

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
        channelIdx: chIdx,
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
      const navHint = this.models.length > 1 ? " • n/p switch model" : "";
      lines.push(this.theme.fg("dim", `↑↓ navigate • enter select • tab/b back(models)${navHint} • s skip • c complete`));
    } else {
      lines.push(this.theme.fg("accent", "[MOVING] ↑↓ reorder • enter confirm • esc cancel"));
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  // Model-level operations
  private ensureModelCursorVisible(): void {
    const totalLines = this.models.length;
    this.viewportHeight = Math.min(20, totalLines);

    if (this.currentModelIndex < this.scrollOffset) {
      this.scrollOffset = this.currentModelIndex;
    }

    if (this.currentModelIndex >= this.scrollOffset + this.viewportHeight) {
      this.scrollOffset = this.currentModelIndex - this.viewportHeight + 1;
    }

    const maxScroll = Math.max(0, totalLines - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    this.invalidate();
  }

  private moveModelUp(): void {
    const idx = this.currentModelIndex;
    if (idx > 0) {
      [this.models[idx], this.models[idx - 1]] = [this.models[idx - 1], this.models[idx]];
      this.currentModelIndex--;
    }
  }

  private moveModelDown(): void {
    const idx = this.currentModelIndex;
    if (idx < this.models.length - 1) {
      [this.models[idx], this.models[idx + 1]] = [this.models[idx + 1], this.models[idx]];
      this.currentModelIndex++;
    }
  }

  private restoreModelPosition(originalIndex: number): void {
    const currentIdx = this.currentModelIndex;

    if (currentIdx === originalIndex) return;

    const model = this.models[currentIdx];
    this.models.splice(currentIdx, 1);
    this.models.splice(originalIndex, 0, model);
    this.currentModelIndex = originalIndex;
  }

  // Channel-level operations
  private ensureChannelCursorVisible(): void {
    const cursorLineInList = this.getChannelCursorAbsoluteLine();
    const totalLines = this.getTotalChannelLines();

    this.viewportHeight = Math.min(20, totalLines);

    if (cursorLineInList < this.scrollOffset) {
      this.scrollOffset = cursorLineInList;
    }

    if (cursorLineInList >= this.scrollOffset + this.viewportHeight) {
      this.scrollOffset = cursorLineInList - this.viewportHeight + 1;
    }

    const maxScroll = Math.max(0, totalLines - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    this.invalidate();
  }

  private getChannelCursorAbsoluteLine(): number {
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

  private getTotalChannelLines(): number {
    let total = 0;
    for (const model of this.models) {
      total++; // model header
      total += model.channels.length;
    }
    return total;
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

  getResult(): Array<{ id: string; channels: string[]; modelByChannel?: Record<string, string>; routes?: Array<{ channel: string; model?: string }> }> {
    return this.models.map(m => {
      const serialized = serializeRouteEntriesForConfig(
        m.id,
        m.channels.map(ch => ({ channel: ch.name, upstreamModelId: ch.upstreamModel || m.id }))
      );
      return {
        id: m.id,
        channels: serialized.channels,
        ...(serialized.modelByChannel ? { modelByChannel: serialized.modelByChannel } : {}),
        ...(serialized.routes ? { routes: serialized.routes } : {}),
      };
    });
  }
}
