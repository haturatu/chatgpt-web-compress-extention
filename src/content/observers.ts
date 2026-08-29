import { BatchLoadGate } from './scheduler';
import { HeightMeasurements } from './measurements';
import { TurnRegistry } from './registry';
import type { TurnInfo } from '../shared/types';

export interface ConversationObserverCallbacks {
  onMutations(records: MutationRecord[]): void;
  onViewport(firstVisible: number, lastVisible: number): void;
  onExpandBefore(): void | Promise<void>;
  onRootChanged(): void;
}

export class ConversationObservers {
  private readonly mutationObserver: MutationObserver;
  private readonly intersectionObserver: IntersectionObserver | null;
  private readonly boundaryObserver: IntersectionObserver | null;
  private readonly measurements: HeightMeasurements;
  private readonly loadGate = new BatchLoadGate();
  private readonly visibleElements = new Set<HTMLElement>();
  private readonly observedElements = new Set<HTMLElement>();
  private boundary: HTMLElement | null = null;
  private parentObserver: MutationObserver | null = null;
  private bodyObserver: MutationObserver | null = null;
  private callbacks: ConversationObserverCallbacks | null = null;

  constructor(private readonly registry: TurnRegistry, preloadMargin: number) {
    this.measurements = new HeightMeasurements(registry);
    this.mutationObserver = new MutationObserver((records) => {
      if (records.length > 0) this.callbacks?.onMutations(records);
    });

    this.intersectionObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => this.handleIntersections(entries), {
        root: null,
        rootMargin: '0px',
        threshold: [0, 0.01, 1]
      });
    this.boundaryObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => this.handleBoundaryIntersections(entries), {
        root: null,
        rootMargin: `${preloadMargin}px 0px`,
        threshold: 0
      });
  }

  mount(root: HTMLElement, callbacks: ConversationObserverCallbacks): void {
    this.callbacks = callbacks;
    this.mutationObserver.observe(root, { childList: true, subtree: true });

    const parent = root.parentElement;
    if (parent) {
      this.parentObserver = new MutationObserver(() => {
        if (!root.isConnected) callbacks.onRootChanged();
      });
      this.parentObserver.observe(parent, { childList: true });
    }

    if (document.body) {
      this.bodyObserver = new MutationObserver(() => {
        if (!root.isConnected) callbacks.onRootChanged();
      });
      this.bodyObserver.observe(document.body, { childList: true });
    }

    window.addEventListener('scroll', this.handleScroll, { passive: true });
    window.addEventListener('popstate', this.handleNavigation);
    window.addEventListener('hashchange', this.handleNavigation);
  }

  updateTurns(infos: TurnInfo[]): void {
    const elements = new Set(infos.map((info) => info.element));
    for (const element of this.observedElements) {
      if (elements.has(element)) continue;
      this.intersectionObserver?.unobserve(element);
      this.boundaryObserver?.unobserve(element);
      this.measurements.unobserve([element]);
      this.observedElements.delete(element);
      this.visibleElements.delete(element);
    }

    for (const info of infos) {
      if (this.observedElements.has(info.element)) continue;
      this.observedElements.add(info.element);
      this.intersectionObserver?.observe(info.element);
      this.measurements.observe([info.element]);
    }

    this.setBoundary(infos.find((info) => info.index < this.currentWindowStart)?.element ?? null);
  }

  setWindowStart(start: number): void {
    const infos = this.registry.ordered();
    this.setBoundary(infos.find((info) => info.index < start)?.element ?? null);
  }

  destroy(): void {
    this.mutationObserver.disconnect();
    this.intersectionObserver?.disconnect();
    this.boundaryObserver?.disconnect();
    this.measurements.destroy();
    this.parentObserver?.disconnect();
    this.bodyObserver?.disconnect();
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('popstate', this.handleNavigation);
    window.removeEventListener('hashchange', this.handleNavigation);
    this.visibleElements.clear();
    this.observedElements.clear();
    this.callbacks = null;
  }

  private currentWindowStart = 0;

  setCurrentWindowStart(start: number): void {
    this.currentWindowStart = start;
    this.setWindowStart(start);
  }

  private handleIntersections(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      if (entry.isIntersecting) {
        this.visibleElements.add(element);
        const info = this.registry.get(element);
        if (info) {
          info.visible = true;
          info.lastSeen = performance.now();
        }
      } else {
        this.visibleElements.delete(element);
        const info = this.registry.get(element);
        if (info) info.visible = false;
      }
    }

    const visibleIndices = Array.from(this.visibleElements)
      .map((element) => this.registry.get(element)?.index)
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);
    if (visibleIndices.length > 0) {
      this.callbacks?.onViewport(visibleIndices[0] ?? 0, visibleIndices[visibleIndices.length - 1] ?? 0);
    }
  }

  private handleBoundaryIntersections(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (entry.target !== this.boundary) continue;
      if (entry.isIntersecting) {
        void this.loadGate.trigger(() => this.callbacks?.onExpandBefore());
      } else {
        this.loadGate.onSentinelExit();
      }
    }
  }

  private setBoundary(nextBoundary: HTMLElement | null): void {
    if (nextBoundary === this.boundary) return;
    if (this.boundary) this.boundaryObserver?.unobserve(this.boundary);
    this.boundary = nextBoundary;
    if (this.boundary) this.boundaryObserver?.observe(this.boundary);
  }

  private handleScroll = (): void => {
    this.loadGate.onScroll();
  };

  private handleNavigation = (): void => {
    this.callbacks?.onRootChanged();
  };
}
