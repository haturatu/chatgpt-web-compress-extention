import { OPTIMIZER_STATE_ATTRIBUTE, OPTIMIZER_TURN_ATTRIBUTE } from './selectors';
import { TurnRegistry } from './registry';
import { findScrollableAncestor } from './scrolling';
import type { OptimizerConfig, OptimizerStats, ViewportState, WindowState } from '../shared/types';

const STREAMING_GRACE_MS = 3000;

const raf = (callback: () => void): void => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
  } else {
    window.setTimeout(callback, 0);
  }
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasStreamingMarker(element: HTMLElement): boolean {
  return Boolean(element.matches('[data-is-streaming="true"], [data-streaming="true"]') || element.querySelector(
    '[data-testid="stop-button"], button[aria-label*="Stop" i], [data-is-streaming="true"]'
  ));
}

export class Optimizer {
  private config: OptimizerConfig;
  private viewport: ViewportState = { firstVisible: 0, lastVisible: 0 };
  private window: WindowState = { start: 0, end: 0 };
  private manualStart: number | null = null;
  private streamingGraceUntil = 0;
  private destroyed = false;

  constructor(private readonly registry: TurnRegistry, config: OptimizerConfig) {
    this.config = config;
  }

  updateConfig(config: OptimizerConfig): void {
    this.config = config;
    this.manualStart = null;
    this.apply();
  }

  updateViewport(firstVisible: number, lastVisible: number): void {
    if (firstVisible < 0 || lastVisible < firstVisible) return;
    this.viewport = { firstVisible, lastVisible };
    this.apply();
  }

  reconcile(): void {
    if (!this.config.enabled) {
      this.clearManagedAttributes();
      return;
    }
    this.registry.reindex();
    this.apply();
  }

  expandBefore(): void {
    if (!this.config.enabled || this.config.mode === 'safe' || !this.config.autoLoad) return;
    const current = this.window.start;
    if (current <= 0) return;
    const anchor = this.findTopVisibleTurn();
    const before = anchor?.getBoundingClientRect().top;
    this.manualStart = Math.max(0, current - this.config.batchSize);
    this.apply();

    if (!anchor || before === undefined) return;
    raf(() => {
      if (!anchor.isConnected) return;
      const after = anchor.getBoundingClientRect().top;
      const delta = after - before;
      if (Math.abs(delta) < 0.5) return;
      const scrollContainer = findScrollableAncestor(anchor);
      if (scrollContainer) scrollContainer.scrollBy({ top: delta, behavior: 'auto' });
      else window.scrollBy({ top: delta, behavior: 'auto' });
    });
  }

  get windowState(): WindowState {
    return { ...this.window };
  }

  get viewportState(): ViewportState {
    return { ...this.viewport };
  }

  getStats(): Pick<OptimizerStats, 'turns' | 'active' | 'dormant'> {
    const turns = this.registry.ordered();
    const active = turns.filter((info) => info.element.dataset.cgptOptimizerState === 'active').length;
    return { turns: turns.length, active, dormant: Math.max(0, turns.length - active) };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearManagedAttributes();
  }

  private apply(): void {
    if (this.destroyed) return;
    const turns = this.registry.ordered();
    if (turns.length === 0) return;
    if (!this.config.enabled) {
      this.clearManagedAttributes();
      return;
    }

    if (this.config.mode === 'safe') {
      this.window = { start: 0, end: turns.length - 1 };
      turns.forEach((info) => this.setState(info.element, 'active'));
      return;
    }

    const range = this.calculateWindow(turns.length);
    this.window = range;
    const tailStart = Math.max(0, turns.length - this.config.pinnedTail);
    const latest = turns[turns.length - 1];
    const latestIsStreaming = Boolean(latest && hasStreamingMarker(latest.element));
    if (latestIsStreaming) this.streamingGraceUntil = Date.now() + STREAMING_GRACE_MS;
    const keepLatest = Date.now() < this.streamingGraceUntil;

    turns.forEach((info, index) => {
      const inWindow = index >= range.start && index <= range.end;
      const pinned = index >= tailStart || (keepLatest && index === turns.length - 1);
      this.setState(info.element, inWindow || pinned ? 'active' : 'dormant');
    });
  }

  private calculateWindow(total: number): WindowState {
    const maxIndex = total - 1;
    const windowSize = this.config.mode === 'aggressive'
      ? this.config.activeWindow
      : this.config.activeWindow + 20;
    if (total <= windowSize + this.config.pinnedTail) {
      return { start: 0, end: maxIndex };
    }

    const beforeBuffer = Math.min(30, Math.max(5, Math.floor(windowSize * 0.375)));
    const afterBuffer = Math.min(20, Math.max(5, Math.floor(windowSize * 0.25)));
    const availableStart = Math.max(0, total - windowSize);
    const naturalStart = clamp(this.viewport.firstVisible - beforeBuffer, 0, availableStart);
    if (this.manualStart !== null && this.viewport.firstVisible >= this.manualStart + windowSize) {
      this.manualStart = null;
    }

    const start = this.manualStart === null ? naturalStart : Math.min(naturalStart, this.manualStart);
    const end = Math.min(maxIndex, Math.max(start + windowSize - 1, this.viewport.lastVisible + afterBuffer));
    return { start, end };
  }

  private setState(element: HTMLElement, state: 'active' | 'dormant'): void {
    element.setAttribute(OPTIMIZER_TURN_ATTRIBUTE, 'true');
    element.setAttribute(OPTIMIZER_STATE_ATTRIBUTE, state);
  }

  private clearManagedAttributes(): void {
    for (const info of this.registry.ordered()) {
      info.element.removeAttribute(OPTIMIZER_TURN_ATTRIBUTE);
      info.element.removeAttribute(OPTIMIZER_STATE_ATTRIBUTE);
    }
  }

  private findTopVisibleTurn(): HTMLElement | null {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const turns = this.registry.ordered();
    const scrollContainer = turns[0] ? findScrollableAncestor(turns[0].element) : null;
    const scrollport = scrollContainer?.getBoundingClientRect();
    const viewportTop = Math.max(0, scrollport?.top ?? 0);
    const viewportBottom = Math.min(viewportHeight, scrollport?.bottom ?? viewportHeight);
    const visible = turns.filter((info) => {
      const rect = info.element.getBoundingClientRect();
      return rect.bottom > viewportTop && rect.top < viewportBottom;
    });
    return visible[0]?.element ?? this.registry.getByIndex(this.viewport.firstVisible)?.element ?? null;
  }
}
