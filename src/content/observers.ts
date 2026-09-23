import { BatchLoadGate } from './scheduler';
import { TurnRegistry } from './registry';
import { findScrollableAncestor } from './scrolling';
import type { TurnInfo } from '../shared/types';

export interface ConversationObserverCallbacks {
  onMutations(records: MutationRecord[]): void;
  onViewport(firstVisible: number, lastVisible: number): void;
  onExpandBefore(): void | Promise<void>;
  onRootChanged(): void;
}

export class ConversationObservers {
  private readonly mutationObserver: MutationObserver;
  private readonly boundaryObserver: IntersectionObserver | null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly loadGate = new BatchLoadGate();
  private readonly visibleTurns = new Set<HTMLElement>();
  private boundary: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private parentObserver: MutationObserver | null = null;
  private bodyObserver: MutationObserver | null = null;
  private callbacks: ConversationObserverCallbacks | null = null;
  private currentWindowStart = 0;
  private viewportUpdateScheduled = false;
  private lastReportedFirst = -1;
  private lastReportedLast = -1;

  constructor(private readonly registry: TurnRegistry, preloadMargin: number) {
    this.mutationObserver = new MutationObserver((records) => {
      if (records.length > 0) {
        this.callbacks?.onMutations(records);
        this.scheduleViewportUpdate();
      }
    });

    this.boundaryObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => this.handleBoundaryIntersections(entries), {
        root: null,
        rootMargin: `${preloadMargin}px 0px`,
        threshold: 0
      });
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => this.scheduleViewportUpdate());
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

    const firstTurn = this.registry.ordered()[0]?.element ?? root;
    this.scrollContainer = findScrollableAncestor(firstTurn);
    if (this.scrollContainer) {
      this.scrollContainer.addEventListener('scroll', this.handleScroll, { passive: true });
      this.resizeObserver?.observe(this.scrollContainer);
    } else {
      window.addEventListener('scroll', this.handleScroll, { passive: true });
    }
    window.addEventListener('resize', this.scheduleViewportUpdate, { passive: true });
    window.addEventListener('popstate', this.handleNavigation);
    window.addEventListener('hashchange', this.handleNavigation);
    this.scheduleViewportUpdate();
  }

  updateTurns(infos: TurnInfo[]): void {
    this.setBoundary(infos.find((info) => info.index < this.currentWindowStart)?.element ?? null);
  }

  setWindowStart(start: number): void {
    const infos = this.registry.ordered();
    this.setBoundary(infos.find((info) => info.index < start)?.element ?? null);
  }

  destroy(): void {
    this.mutationObserver.disconnect();
    this.boundaryObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.parentObserver?.disconnect();
    this.bodyObserver?.disconnect();
    if (this.scrollContainer) {
      this.scrollContainer.removeEventListener('scroll', this.handleScroll);
      this.scrollContainer = null;
    } else {
      window.removeEventListener('scroll', this.handleScroll);
    }
    window.removeEventListener('resize', this.scheduleViewportUpdate);
    window.removeEventListener('popstate', this.handleNavigation);
    window.removeEventListener('hashchange', this.handleNavigation);
    this.boundary = null;
    this.visibleTurns.clear();
    this.callbacks = null;
  }

  setCurrentWindowStart(start: number): void {
    this.currentWindowStart = start;
    this.setWindowStart(start);
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

  private scheduleViewportUpdate = (): void => {
    if (this.viewportUpdateScheduled) return;
    this.viewportUpdateScheduled = true;
    const update = (): void => {
      this.viewportUpdateScheduled = false;
      this.updateViewportFromLayout();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(update);
    else window.setTimeout(update, 0);
  };

  private updateViewportFromLayout(): void {
    const infos = this.registry.ordered();
    if (infos.length === 0) {
      this.clearVisibleTurnTargets();
      return;
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const scrollport = this.scrollContainer?.getBoundingClientRect();
    const viewportTop = Math.max(0, scrollport?.top ?? 0);
    const viewportBottom = Math.min(viewportHeight, scrollport?.bottom ?? viewportHeight);
    if (viewportBottom <= viewportTop) {
      this.clearVisibleTurnTargets();
      return;
    }

    // Turns are in vertical DOM order, so locate the visible range without
    // registering every turn with a native IntersectionObserver.
    let low = 0;
    let high = infos.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (infos[middle]!.element.getBoundingClientRect().bottom > viewportTop) high = middle;
      else low = middle + 1;
    }
    const firstVisible = low;
    if (firstVisible >= infos.length || infos[firstVisible]!.element.getBoundingClientRect().bottom <= viewportTop) {
      this.clearVisibleTurnTargets();
      return;
    }

    low = firstVisible;
    high = infos.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (infos[middle]!.element.getBoundingClientRect().top < viewportBottom) low = middle + 1;
      else high = middle;
    }
    const lastVisible = low - 1;
    if (lastVisible < firstVisible || infos[lastVisible]!.element.getBoundingClientRect().top >= viewportBottom) {
      this.clearVisibleTurnTargets();
      return;
    }

    this.syncVisibleTurnTargets(infos, firstVisible, lastVisible);
    if (firstVisible === this.lastReportedFirst && lastVisible === this.lastReportedLast) return;
    this.lastReportedFirst = firstVisible;
    this.lastReportedLast = lastVisible;
    this.callbacks?.onViewport(firstVisible, lastVisible);
  }

  private syncVisibleTurnTargets(infos: TurnInfo[], first: number, last: number): void {
    if (!this.resizeObserver) return;
    let unchanged = this.visibleTurns.size === last - first + 1;
    if (unchanged) {
      for (let index = first; index <= last; index += 1) {
        if (!this.visibleTurns.has(infos[index]!.element)) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) return;

    this.clearVisibleTurnTargets();
    for (let index = first; index <= last; index += 1) {
      const element = infos[index]!.element;
      this.visibleTurns.add(element);
      this.resizeObserver.observe(element);
    }
  }

  private clearVisibleTurnTargets(): void {
    if (this.resizeObserver) {
      for (const element of this.visibleTurns) this.resizeObserver.unobserve(element);
    }
    this.visibleTurns.clear();
    this.lastReportedFirst = -1;
    this.lastReportedLast = -1;
  }

  private handleScroll = (): void => {
    this.loadGate.onScroll();
    this.scheduleViewportUpdate();
  };

  private handleNavigation = (): void => {
    this.callbacks?.onRootChanged();
  };
}
