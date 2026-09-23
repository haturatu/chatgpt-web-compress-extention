import {
  LONG_MARKDOWN_ATTRIBUTE,
  OPTIMIZER_ROOT_ATTRIBUTE,
  OPTIMIZER_STATE_ATTRIBUTE,
  OPTIMIZER_TURN_ATTRIBUTE
} from './selectors';
import { TurnRegistry } from './registry';
import { detectTurns } from './detector';
import { findScrollableAncestor } from './scrolling';
import type { OptimizerConfig, OptimizerStats, ViewportState, WindowState } from '../shared/types';

const STREAMING_GRACE_MS = 3000;
const FALLBACK_FROZEN_HEIGHT = 420;
const MEDIA_ATTRIBUTES = ['src', 'srcset', 'poster'] as const;

type OptimizerState = 'active' | 'dormant' | 'cold';
interface IndexRange { start: number; end: number }

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

function mergeRanges(ranges: IndexRange[]): IndexRange[] {
  const sorted = ranges.filter((range) => range.end >= range.start).sort((a, b) => a.start - b.start);
  const merged: IndexRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (!last || range.start > last.end + 1) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function forRangeDifference(
  source: readonly IndexRange[],
  covered: readonly IndexRange[],
  visit: (index: number) => void
): void {
  for (const range of source) {
    let cursor = range.start;
    for (const cover of covered) {
      if (cover.end < cursor) continue;
      if (cover.start > range.end) break;
      if (cover.start > cursor) {
        for (let index = cursor; index < Math.min(cover.start, range.end + 1); index += 1) visit(index);
      }
      cursor = Math.max(cursor, cover.end + 1);
      if (cursor > range.end) break;
    }
    for (let index = cursor; index <= range.end; index += 1) visit(index);
  }
}

export class Optimizer {
  private config: OptimizerConfig;
  private viewport: ViewportState = { firstVisible: 0, lastVisible: 0 };
  private window: WindowState = { start: 0, end: 0 };
  private manualStart: number | null = null;
  private streamingGraceUntil = 0;
  private destroyed = false;
  private appliedRanges: IndexRange[] = [];
  private appliedStructureRevision = -1;
  private initializedCount = 0;
  private activeCount = 0;
  private dormantCount = 0;
  private appliedMode: OptimizerConfig['mode'] | null = null;
  private readonly measuredHeights = new WeakMap<HTMLElement, number>();
  private readonly savedMediaAttributes = new WeakMap<HTMLElement, Array<{
    element: HTMLElement;
    attributes: Array<[string, string | null]>;
  }>>();

  constructor(
    private readonly registry: TurnRegistry,
    config: OptimizerConfig,
    private readonly root: HTMLElement | null = null
  ) {
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
    this.apply();
  }

  recordHeight(element: HTMLElement, height: number): void {
    if (!Number.isFinite(height) || height <= 0) return;
    this.measuredHeights.set(element, height);
  }

  expandBefore(): void {
    if (!this.config.enabled || this.config.mode === 'safe' || !this.config.autoLoad) return;
    const current = this.window.start;
    if (current <= 0) return;
    const anchor = this.registry.elementAt(this.viewport.firstVisible) ?? this.registry.elementAt(current);
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
    const turns = this.config.mode === 'safe' && this.root
      ? detectTurns(this.root).length
      : this.registry.count();
    const active = !this.config.enabled
      ? 0
      : this.config.mode === 'safe'
        ? turns
        : this.activeCount;
    return { turns, active, dormant: Math.max(0, turns - active) };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearManagedAttributes();
  }

  private apply(): void {
    if (this.destroyed) return;
    if (!this.config.enabled) {
      this.clearManagedAttributes();
      this.appliedMode = this.config.mode;
      return;
    }

    const turns = this.registry.elements();
    if (this.config.mode === 'safe') {
      this.enterSafeMode(turns);
      return;
    }

    this.root?.removeAttribute(OPTIMIZER_ROOT_ATTRIBUTE);
    if (turns.length === 0) {
      this.window = { start: 0, end: 0 };
      this.appliedRanges = [];
      this.appliedMode = this.config.mode;
      this.appliedStructureRevision = this.registry.structureRevision;
      this.initializedCount = 0;
      this.activeCount = 0;
      this.dormantCount = 0;
      return;
    }

    const total = turns.length;
    const range = this.calculateWindow(total);
    this.window = range;
    const tailStart = Math.max(0, total - this.config.pinnedTail);
    const latest = turns[total - 1];
    const latestIsStreaming = Boolean(latest && hasStreamingMarker(latest));
    if (latestIsStreaming) this.streamingGraceUntil = Date.now() + STREAMING_GRACE_MS;
    const keepLatest = Date.now() < this.streamingGraceUntil;
    const nextRanges = mergeRanges([
      range,
      { start: tailStart, end: total - 1 },
      ...(keepLatest ? [{ start: total - 1, end: total - 1 }] : [])
    ]);

    const structureChanged = this.appliedMode !== this.config.mode
      || this.registry.hasNonAppendChangesSince(this.appliedStructureRevision)
      || total < this.initializedCount;
    if (structureChanged) {
      if (this.config.mode === 'hibernate' && this.initializedCount === 0) {
        // Read all baseline sizes before writing cold-state styles to avoid read/write layout thrashing.
        for (const element of turns) {
          if (!this.measuredHeights.has(element)) this.recordHeight(element, element.getBoundingClientRect().height);
        }
      }
      let nextActiveCount = 0;
      for (let index = 0; index < total; index += 1) {
        const active = this.isInRanges(index, nextRanges);
        this.writeState(turns[index]!, this.stateFor(active));
        if (active) nextActiveCount += 1;
      }
      this.activeCount = nextActiveCount;
      this.dormantCount = total - nextActiveCount;
    } else {
      const oldRanges = this.appliedRanges;
      forRangeDifference(oldRanges, nextRanges, (index) => {
        const element = turns[index];
        if (element) this.setState(element, this.stateFor(false));
      });
      forRangeDifference(nextRanges, oldRanges, (index) => {
        const element = turns[index];
        if (element) this.setState(element, 'active');
      });
      for (let index = this.initializedCount; index < total; index += 1) {
        const element = turns[index]!;
        this.setState(element, this.stateFor(this.isInRanges(index, nextRanges)));
      }
    }

    this.appliedRanges = nextRanges;
    this.appliedStructureRevision = this.registry.structureRevision;
    this.initializedCount = total;
    this.appliedMode = this.config.mode;
  }

  private enterSafeMode(turns: readonly HTMLElement[]): void {
    const entering = this.appliedMode !== 'safe';
    if (entering && turns.some((turn) => turn.hasAttribute(OPTIMIZER_TURN_ATTRIBUTE))) {
      this.clearTurnAttributes(turns);
    }
    this.root?.setAttribute(OPTIMIZER_ROOT_ATTRIBUTE, 'safe');
    this.window = { start: 0, end: Math.max(0, turns.length - 1) };
    this.appliedRanges = [];
    this.appliedStructureRevision = this.registry.structureRevision;
    this.initializedCount = turns.length;
    this.activeCount = 0;
    this.dormantCount = 0;
    this.appliedMode = 'safe';
  }

  private calculateWindow(total: number): WindowState {
    const maxIndex = total - 1;
    const windowSize = this.config.mode === 'aggressive' || this.config.mode === 'hibernate'
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

  private stateFor(active: boolean): OptimizerState {
    if (active) return 'active';
    return this.config.mode === 'hibernate' ? 'cold' : 'dormant';
  }

  private isInRanges(index: number, ranges: readonly IndexRange[]): boolean {
    return ranges.some((range) => index >= range.start && index <= range.end);
  }

  private setState(element: HTMLElement, state: OptimizerState): void {
    const previous = element.dataset.cgptOptimizerState;
    if (previous === state && element.hasAttribute(OPTIMIZER_TURN_ATTRIBUTE)) return;
    if (previous === 'active') this.activeCount = Math.max(0, this.activeCount - 1);
    else if (previous === 'dormant' || previous === 'cold') this.dormantCount = Math.max(0, this.dormantCount - 1);
    this.writeState(element, state);
    if (state === 'active') this.activeCount += 1;
    else this.dormantCount += 1;
  }

  private writeState(element: HTMLElement, state: OptimizerState): void {
    if (!element.hasAttribute(OPTIMIZER_TURN_ATTRIBUTE)) {
      element.setAttribute(OPTIMIZER_TURN_ATTRIBUTE, 'true');
    }
    if (element.dataset.cgptOptimizerState !== state) {
      element.setAttribute(OPTIMIZER_STATE_ATTRIBUTE, state);
    }

    if (state === 'cold') {
      if (!element.style.getPropertyValue('--cgpt-frozen-height')) {
        const measured = this.measuredHeights.get(element) ?? element.getBoundingClientRect().height;
        const height = Number.isFinite(measured) && measured > 0 ? measured : FALLBACK_FROZEN_HEIGHT;
        element.style.setProperty('--cgpt-frozen-height', `${Math.ceil(height)}px`);
      }
      this.hibernateMedia(element);
    } else if (element.style.getPropertyValue('--cgpt-frozen-height')) {
      element.style.removeProperty('--cgpt-frozen-height');
    }
    if (state !== 'cold') this.restoreMedia(element);
  }

  private clearManagedAttributes(): void {
    this.root?.removeAttribute(OPTIMIZER_ROOT_ATTRIBUTE);
    this.clearTurnAttributes(this.registry.elements());
    if (this.root) {
      for (const markdown of this.root.querySelectorAll<HTMLElement>(`[${LONG_MARKDOWN_ATTRIBUTE}]`)) {
        markdown.removeAttribute(LONG_MARKDOWN_ATTRIBUTE);
      }
    }
    this.appliedRanges = [];
    this.initializedCount = 0;
    this.activeCount = 0;
    this.dormantCount = 0;
  }

  private clearTurnAttributes(turns: readonly HTMLElement[]): void {
    for (const element of turns) {
      this.restoreMedia(element);
      element.removeAttribute(OPTIMIZER_TURN_ATTRIBUTE);
      element.removeAttribute(OPTIMIZER_STATE_ATTRIBUTE);
      element.style.removeProperty('--cgpt-frozen-height');
    }
  }

  private hibernateMedia(turn: HTMLElement): void {
    if (this.savedMediaAttributes.has(turn)) return;
    const saved: Array<{ element: HTMLElement; attributes: Array<[string, string | null]> }> = [];
    for (const element of turn.querySelectorAll<HTMLElement>('img, video, audio, source')) {
      const attributes = MEDIA_ATTRIBUTES.map((name) => [name, element.getAttribute(name)] as [string, string | null]);
      const sources = attributes.flatMap(([, value]) => value
        ? value.split(',').map((entry) => entry.trim().split(/\s+/, 1)[0]!)
        : []);
      if (sources.length === 0 || sources.some((source) => {
        try {
          const protocol = new URL(source, document.baseURI).protocol;
          return protocol !== 'http:' && protocol !== 'https:';
        } catch {
          return true;
        }
      })) continue;

      attributes.push(['loading', element.getAttribute('loading')]);
      saved.push({ element, attributes });
      for (const attribute of MEDIA_ATTRIBUTES) element.removeAttribute(attribute);
      if (element instanceof HTMLImageElement) element.loading = 'lazy';
    }
    if (saved.length > 0) this.savedMediaAttributes.set(turn, saved);
  }

  private restoreMedia(turn: HTMLElement): void {
    const saved = this.savedMediaAttributes.get(turn);
    if (!saved) return;
    for (const entry of saved) {
      if (!entry.element.isConnected) continue;
      for (const [name, value] of entry.attributes) {
        if (value === null) entry.element.removeAttribute(name);
        else entry.element.setAttribute(name, value);
      }
    }
    this.savedMediaAttributes.delete(turn);
  }
}
