/**
 * Two-tier order editor for channelFirst strategy
 * Layer 1: Model order
 * Layer 2: Channel order within each model
 */

import { matchesKey, Key, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ChannelScore } from "./config-wizard.js";
import { serializeRouteEntriesForConfig } from "./router-routes.js";

type EditMode = "model" | "channel";
type EditState = "browsing" | "moving" | "confirmDelete";

type EditableRouteItem = {
  name: string;
  label: string;
  routeKey: string;
  upstreamModel?: string;
  reason: string;
  category: string;
  fixed: boolean;
};

type EditableModelItem = {
  id: string;
  channels: EditableRouteItem[];
};

export class TwoTierOrderEditor implements Component {
  private models: EditableModelItem[];

  // UI state
  private mode: EditMode = "model";  // Start with model-level editing
  private state: EditState = "browsing";

  // Model-level navigation
  private currentModelIndex = 0;
  private movingModelFromIndex?: number;
  private selectedModelIndices = new Set<number>();
  private modelSelectionAnchor?: number;
  private movingModelSnapshot?: EditableModelItem[];

  // Channel-level navigation (when mode === "channel")
  private currentChannelIndex = 0;
  private movingChannelFromIndex?: number;
  private selectedChannelIndices = new Set<number>();
  private channelSelectionAnchor?: number;
  private movingChannelSnapshot?: EditableRouteItem[];

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
    if (this.models.length === 0) {
      if (data === "c" || data === "C") this.onComplete?.();
      else if (matchesKey(data, Key.escape)) this.onSkip?.();
      return;
    }

    if (this.state === "confirmDelete") {
      if (matchesKey(data, Key.delete) || matchesKey(data, Key.enter)) {
        this.deleteSelectedModelsOrCurrent();
        this.state = "browsing";
        this.invalidate();
      } else if (matchesKey(data, Key.escape)) {
        this.state = "browsing";
        this.invalidate();
      }
      return;
    }

    if (this.state === "browsing") {
      if (matchesKey(data, Key.shift("up"))) {
        this.extendModelSelection(-1);
      } else if (matchesKey(data, Key.shift("down"))) {
        this.extendModelSelection(1);
      } else if (matchesKey(data, Key.space)) {
        this.toggleModelSelection(this.currentModelIndex);
      } else if (data === "a" || data === "A") {
        this.selectAllModels();
      } else if (matchesKey(data, Key.delete)) {
        this.state = "confirmDelete";
        this.invalidate();
      } else if (matchesKey(data, Key.up)) {
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
        if (this.selectedModelIndices.size > 0) {
          this.movingModelSnapshot = this.cloneModels();
        } else {
          this.movingModelFromIndex = this.currentModelIndex;
        }
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
        if (this.selectedModelIndices.size > 0) {
          this.clearModelSelection();
        } else {
          this.onSkip?.();
        }
      }
    } else {
      // Moving state
      if (matchesKey(data, Key.up)) {
        if (this.selectedModelIndices.size > 0) this.moveSelectedModelsUp();
        else this.moveModelUp();
        this.ensureModelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.down)) {
        if (this.selectedModelIndices.size > 0) this.moveSelectedModelsDown();
        else this.moveModelDown();
        this.ensureModelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        // Confirm position
        this.state = "browsing";
        this.movingModelFromIndex = undefined;
        this.movingModelSnapshot = undefined;
        this.clearModelSelection();
        this.invalidate();
      } else if (matchesKey(data, Key.escape)) {
        // Cancel move
        if (this.movingModelSnapshot) {
          this.models = this.movingModelSnapshot;
          this.clearModelSelection();
        } else if (this.movingModelFromIndex !== undefined) {
          this.restoreModelPosition(this.movingModelFromIndex);
        }
        this.state = "browsing";
        this.movingModelFromIndex = undefined;
        this.movingModelSnapshot = undefined;
        this.invalidate();
      }
    }
  }

  private handleChannelInput(data: string): void {
    const model = this.models[this.currentModelIndex];
    if (!model) return;

    const channel = model.channels[this.currentChannelIndex];

    if (this.state === "confirmDelete") {
      if (matchesKey(data, Key.delete) || matchesKey(data, Key.enter)) {
        this.deleteSelectedChannelsOrCurrent();
        this.state = "browsing";
        this.invalidate();
      } else if (matchesKey(data, Key.escape)) {
        this.state = "browsing";
        this.invalidate();
      }
      return;
    }

    if (this.state === "browsing") {
      if (matchesKey(data, Key.shift("up"))) {
        this.extendChannelSelection(-1);
      } else if (matchesKey(data, Key.shift("down"))) {
        this.extendChannelSelection(1);
      } else if (matchesKey(data, Key.space)) {
        this.toggleChannelSelection(this.currentChannelIndex);
      } else if (data === "a" || data === "A") {
        this.selectAllChannels();
      } else if (matchesKey(data, Key.delete)) {
        this.state = "confirmDelete";
        this.invalidate();
      } else if (matchesKey(data, Key.up)) {
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
        if (this.selectedChannelIndices.size > 0) {
          this.movingChannelSnapshot = model.channels.map(ch => ({ ...ch }));
        } else {
          this.movingChannelFromIndex = this.currentChannelIndex;
        }
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
          this.clearChannelSelection();
          this.scrollOffset = 0;
          this.invalidate();
        }
      } else if (data === "p" || data === "P") {
        // Previous model (if available)
        if (this.currentModelIndex > 0) {
          this.currentModelIndex--;
          this.currentChannelIndex = 0;
          this.clearChannelSelection();
          this.scrollOffset = 0;
          this.invalidate();
        }
      } else if (data === "s" || data === "S") {
        this.onSkip?.();
      } else if (data === "c" || data === "C") {
        this.onComplete?.();
      } else if (matchesKey(data, Key.escape)) {
        if (this.selectedChannelIndices.size > 0) {
          this.clearChannelSelection();
        } else {
          // Back to model-level
          this.mode = "model";
          this.scrollOffset = 0;
          this.invalidate();
        }
      }
    } else {
      // Moving state
      if (matchesKey(data, Key.up)) {
        if (this.selectedChannelIndices.size > 0) this.moveSelectedChannelsUp();
        else this.moveChannelUp();
        this.ensureChannelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.down)) {
        if (this.selectedChannelIndices.size > 0) this.moveSelectedChannelsDown();
        else this.moveChannelDown();
        this.ensureChannelCursorVisible();
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        // Confirm position
        if (channel) channel.fixed = true;
        this.state = "browsing";
        this.movingChannelFromIndex = undefined;
        this.movingChannelSnapshot = undefined;
        this.clearChannelSelection();
        this.invalidate();
      } else if (matchesKey(data, Key.escape)) {
        // Cancel move
        if (this.movingChannelSnapshot) {
          model.channels = this.movingChannelSnapshot;
          this.clearChannelSelection();
        } else if (this.movingChannelFromIndex !== undefined) {
          this.restoreChannelPosition(this.movingChannelFromIndex);
        }
        this.state = "browsing";
        this.movingChannelFromIndex = undefined;
        this.movingChannelSnapshot = undefined;
        this.invalidate();
      }
    }
  }

  render(width: number): string[] {
    if (this.mode === "channel" && !this.models[this.currentModelIndex]) {
      this.mode = "model";
      this.currentModelIndex = Math.max(0, Math.min(this.currentModelIndex, this.models.length - 1));
      this.currentChannelIndex = 0;
      this.clearChannelSelection();
    }

    // Always ensure cursor is visible before rendering
    // Calculate based on current mode
    if (this.mode === "model") {
      const modelCount = this.models.length;
      const calculatedViewportHeight = Math.min(10, modelCount);
      if (modelCount === 0) {
        this.currentModelIndex = 0;
        this.viewportHeight = 0;
      } else {

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
      }
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
    if (this.models.length === 0) {
      lines.push(this.theme.fg("dim", "No models remaining"));
      lines.push("");
      lines.push(this.theme.fg("dim", "c complete • esc cancel"));
      return;
    }
    lines.push(this.theme.fg("dim", `Adjusting model order  [${this.currentModelIndex + 1}/${this.models.length}]`));
    lines.push("");

    // Build model list
    const modelListLines: Array<{ text: string; modelIdx: number }> = [];

    this.models.forEach((m, modelIdx) => {
      const isCurrent = modelIdx === this.currentModelIndex;
      const isSelected = this.selectedModelIndices.has(modelIdx);

      // Build marker
      let marker = "  ";
      if (isCurrent && this.state === "moving") {
        marker = "◆→";
      } else if (isCurrent) {
        marker = "▸ ";
      } else if (isSelected) {
        marker = "● ";
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
      } else if (isSelected) {
        lineText = this.theme.fg("success", lineText);
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
    if (this.state === "confirmDelete") {
      const count = this.selectedModelIndices.size || 1;
      lines.push(this.theme.fg("warning", `Delete ${count} selected model${count === 1 ? "" : "s"}? delete/enter confirm • esc cancel`));
    } else if (this.state === "browsing") {
      lines.push(this.theme.fg("dim", "↑↓ navigate • space select • shift+↑↓ range • a all • delete remove • enter move • tab/n channels • esc clear/back • c complete"));
    } else {
      const moving = this.selectedModelIndices.size > 0 ? `${this.selectedModelIndices.size} selected` : "current";
      lines.push(this.theme.fg("accent", `[MOVING ${moving}] ↑↓ reorder • enter confirm • esc cancel`));
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
      const isSelected = this.selectedChannelIndices.has(chIdx);

      // Build prefix/marker
      let marker = "  ";
      if (isCurrent && this.state === "moving") {
        marker = "◆→";
      } else if (isCurrent) {
        marker = "▸ ";
      } else if (isSelected) {
        marker = "● ";
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
      } else if (isSelected) {
        lineText = this.theme.fg("success", lineText);
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
    if (this.state === "confirmDelete") {
      const count = this.selectedChannelIndices.size || 1;
      lines.push(this.theme.fg("warning", `Delete ${count} selected model/channel pair${count === 1 ? "" : "s"}? delete/enter confirm • esc cancel`));
    } else if (this.state === "browsing") {
      const navHint = this.models.length > 1 ? " • n/p switch model" : "";
      lines.push(this.theme.fg("dim", `↑↓ navigate • space select • shift+↑↓ range • a all • delete remove • enter move • tab/b models${navHint} • esc clear/back • c complete`));
    } else {
      const moving = this.selectedChannelIndices.size > 0 ? `${this.selectedChannelIndices.size} selected` : "current";
      lines.push(this.theme.fg("accent", `[MOVING ${moving}] ↑↓ reorder • enter confirm • esc cancel`));
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private cloneModels(): EditableModelItem[] {
    return this.models.map(model => ({
      id: model.id,
      channels: model.channels.map(channel => ({ ...channel })),
    }));
  }

  private toggleModelSelection(index: number): void {
    if (this.selectedModelIndices.has(index)) this.selectedModelIndices.delete(index);
    else this.selectedModelIndices.add(index);
    this.modelSelectionAnchor = index;
    this.invalidate();
  }

  private clearModelSelection(): void {
    this.selectedModelIndices.clear();
    this.modelSelectionAnchor = undefined;
    this.invalidate();
  }

  private selectAllModels(): void {
    this.selectedModelIndices = new Set(this.models.map((_, index) => index));
    this.modelSelectionAnchor = this.currentModelIndex;
    this.invalidate();
  }

  private extendModelSelection(delta: -1 | 1): void {
    const anchor = this.modelSelectionAnchor ?? this.currentModelIndex;
    const nextIndex = Math.max(0, Math.min(this.models.length - 1, this.currentModelIndex + delta));
    this.currentModelIndex = nextIndex;
    const [start, end] = [Math.min(anchor, nextIndex), Math.max(anchor, nextIndex)];
    for (let index = start; index <= end; index++) this.selectedModelIndices.add(index);
    this.modelSelectionAnchor = anchor;
    this.ensureModelCursorVisible();
    this.invalidate();
  }

  private reindexSelectedModelsByCurrentIds(): void {
    const selectedIds = new Set(Array.from(this.selectedModelIndices).map(index => this.models[index]?.id).filter(Boolean));
    this.selectedModelIndices.clear();
    this.models.forEach((model, index) => {
      if (selectedIds.has(model.id)) this.selectedModelIndices.add(index);
    });
  }

  private deleteSelectedModelsOrCurrent(): void {
    const deleteIndices = this.selectedModelIndices.size > 0
      ? Array.from(this.selectedModelIndices)
      : [this.currentModelIndex];
    const toDelete = new Set(deleteIndices);
    this.models = this.models.filter((_, index) => !toDelete.has(index));
    this.currentModelIndex = Math.max(0, Math.min(this.currentModelIndex, this.models.length - 1));
    this.currentChannelIndex = 0;
    this.clearModelSelection();
    this.clearChannelSelection();
  }

  private toggleChannelSelection(index: number): void {
    if (this.selectedChannelIndices.has(index)) this.selectedChannelIndices.delete(index);
    else this.selectedChannelIndices.add(index);
    this.channelSelectionAnchor = index;
    this.invalidate();
  }

  private clearChannelSelection(): void {
    this.selectedChannelIndices.clear();
    this.channelSelectionAnchor = undefined;
    this.invalidate();
  }

  private selectAllChannels(): void {
    const model = this.models[this.currentModelIndex];
    this.selectedChannelIndices = new Set((model?.channels || []).map((_, index) => index));
    this.channelSelectionAnchor = this.currentChannelIndex;
    this.invalidate();
  }

  private extendChannelSelection(delta: -1 | 1): void {
    const model = this.models[this.currentModelIndex];
    if (!model) return;
    const anchor = this.channelSelectionAnchor ?? this.currentChannelIndex;
    const nextIndex = Math.max(0, Math.min(model.channels.length - 1, this.currentChannelIndex + delta));
    this.currentChannelIndex = nextIndex;
    const [start, end] = [Math.min(anchor, nextIndex), Math.max(anchor, nextIndex)];
    for (let index = start; index <= end; index++) this.selectedChannelIndices.add(index);
    this.channelSelectionAnchor = anchor;
    this.ensureChannelCursorVisible();
    this.invalidate();
  }

  private reindexSelectedChannelsByCurrentRouteKeys(): void {
    const model = this.models[this.currentModelIndex];
    if (!model) return;
    const selectedKeys = new Set(Array.from(this.selectedChannelIndices).map(index => model.channels[index]?.routeKey).filter(Boolean));
    this.selectedChannelIndices.clear();
    model.channels.forEach((channel, index) => {
      if (selectedKeys.has(channel.routeKey)) this.selectedChannelIndices.add(index);
    });
  }

  private deleteSelectedChannelsOrCurrent(): void {
    const model = this.models[this.currentModelIndex];
    if (!model) return;
    const deleteIndices = this.selectedChannelIndices.size > 0
      ? Array.from(this.selectedChannelIndices)
      : [this.currentChannelIndex];
    const toDelete = new Set(deleteIndices);
    model.channels = model.channels.filter((_, index) => !toDelete.has(index));
    if (model.channels.length === 0) {
      this.models.splice(this.currentModelIndex, 1);
      this.currentModelIndex = Math.max(0, Math.min(this.currentModelIndex, this.models.length - 1));
      this.currentChannelIndex = 0;
      this.mode = this.models.length > 0 ? this.mode : "model";
    } else {
      this.currentChannelIndex = Math.max(0, Math.min(this.currentChannelIndex, model.channels.length - 1));
    }
    this.clearChannelSelection();
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

  private moveSelectedModelsUp(): void {
    const sorted = Array.from(this.selectedModelIndices).sort((a, b) => a - b);
    for (const idx of sorted) {
      if (idx > 0 && !this.selectedModelIndices.has(idx - 1)) {
        [this.models[idx - 1], this.models[idx]] = [this.models[idx], this.models[idx - 1]];
        this.selectedModelIndices.delete(idx);
        this.selectedModelIndices.add(idx - 1);
        if (this.currentModelIndex === idx) this.currentModelIndex = idx - 1;
      }
    }
  }

  private moveSelectedModelsDown(): void {
    const sorted = Array.from(this.selectedModelIndices).sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx < this.models.length - 1 && !this.selectedModelIndices.has(idx + 1)) {
        [this.models[idx], this.models[idx + 1]] = [this.models[idx + 1], this.models[idx]];
        this.selectedModelIndices.delete(idx);
        this.selectedModelIndices.add(idx + 1);
        if (this.currentModelIndex === idx) this.currentModelIndex = idx + 1;
      }
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

  private moveSelectedChannelsUp(): void {
    const model = this.models[this.currentModelIndex];
    const sorted = Array.from(this.selectedChannelIndices).sort((a, b) => a - b);
    for (const idx of sorted) {
      if (idx > 0 && !this.selectedChannelIndices.has(idx - 1)) {
        [model.channels[idx - 1], model.channels[idx]] = [model.channels[idx], model.channels[idx - 1]];
        this.selectedChannelIndices.delete(idx);
        this.selectedChannelIndices.add(idx - 1);
        if (this.currentChannelIndex === idx) this.currentChannelIndex = idx - 1;
      }
    }
  }

  private moveSelectedChannelsDown(): void {
    const model = this.models[this.currentModelIndex];
    const sorted = Array.from(this.selectedChannelIndices).sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx < model.channels.length - 1 && !this.selectedChannelIndices.has(idx + 1)) {
        [model.channels[idx], model.channels[idx + 1]] = [model.channels[idx + 1], model.channels[idx]];
        this.selectedChannelIndices.delete(idx);
        this.selectedChannelIndices.add(idx + 1);
        if (this.currentChannelIndex === idx) this.currentChannelIndex = idx + 1;
      }
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
    return this.models.filter(m => m.channels.length > 0).map(m => {
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
