import { BatchLoadGate } from './scheduler';
import { TurnRegistry } from './registry';
import { findScrollableAncestor } from './scrolling';
import type { OptimizationMode } from '../shared/types';

export interface ConversationObserverCallbacks {
  onMutations(records: MutationRecord[]): void;
  onViewport(firstVisible: number, lastVisible: number): void;
  onResize(entries: readonly ResizeObserverEntry[]): void;
  onExpandBefore(): void | Promise<void>;
  onRootChanged(): void;
}

interface ContentVisibilityEvent extends Event {
  readonly skipped?: boolean;
}

interface NavigationEventTarget extends EventTarget {}

export class ConversationObservers {
  private readonly mutationObserver: MutationObserver;
  private boundaryObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly loadGate = new BatchLoadGate();
  private readonly visibleResizeTargets = new Set<HTMLElement>();
  private readonly contentVisibilityTurns = new Set<HTMLElement>();
  private readonly lifecycle = new AbortController();
  private boundary: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private parentObserver: MutationObserver | null = null;
  private bodyObserver: MutationObserver | null = null;
  private callbacks: ConversationObserverCallbacks | null = null;
  private viewportUpdateScheduled = false;
  private forceGeometryUpdate = false;
  private lastReportedFirst = -1;
  private lastReportedLast = -1;
  private contentVisibilityEventsSupported = false;
  private receivedContentVisibilityEvent = false;
  private seededVisibilityWithCheckVisibility = false;
  private mountedUrl = location.href;
  private destroyed = false;

  constructor(
    private readonly registry: TurnRegistry,
    private readonly preloadMargin: number,
    private readonly mode: OptimizationMode
  ) {
    this.mutationObserver = new MutationObserver((records) => {
      if (records.length === 0) return;
      if (location.href !== this.mountedUrl) {
        this.mountedUrl = location.href;
        this.callbacks?.onRootChanged();
        return;
      }
      this.callbacks?.onMutations(records);
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

    this.installNavigationListener();
    if (this.mode === 'safe') return;

    const firstTurn = this.registry.elementAt(0)
      ?? root.querySelector<HTMLElement>('[data-testid^="conversation-turn"], article, [data-message-author-role]')
      ?? root;
    this.scrollContainer = findScrollableAncestor(firstTurn);
    this.boundaryObserver = this.createBoundaryObserver();
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
        this.callbacks?.onResize(entries);
        this.scheduleViewportUpdate(true);
      });

    if (this.scrollContainer) {
      this.scrollContainer.addEventListener('scroll', this.handleScroll, { passive: true, signal: this.lifecycle.signal });
      this.resizeObserver?.observe(this.scrollContainer);
    } else {
      window.addEventListener('scroll', this.handleScroll, { passive: true, signal: this.lifecycle.signal });
    }
    window.addEventListener('resize', this.handleWindowResize, { passive: true, signal: this.lifecycle.signal });

    this.contentVisibilityEventsSupported = 'oncontentvisibilityautostatechange' in root
      || 'ContentVisibilityAutoStateChangeEvent' in window;
    root.addEventListener('contentvisibilityautostatechange', this.handleContentVisibilityChange, {
      capture: true,
      signal: this.lifecycle.signal
    });
    this.scheduleViewportUpdate();
  }

  refreshViewport(forceGeometry = false): void {
    this.scheduleViewportUpdate(forceGeometry);
  }

  setCurrentWindowStart(start: number): void {
    const boundaryIndex = start - 1;
    this.setBoundary(boundaryIndex >= 0 ? this.registry.elementAt(boundaryIndex) ?? null : null);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifecycle.abort();
    this.mutationObserver.disconnect();
    this.boundaryObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.parentObserver?.disconnect();
    this.bodyObserver?.disconnect();
    this.boundary = null;
    this.scrollContainer = null;
    this.visibleResizeTargets.clear();
    this.contentVisibilityTurns.clear();
    this.callbacks = null;
  }

  private createBoundaryObserver(): IntersectionObserver | null {
    if (typeof IntersectionObserver === 'undefined') return null;
    const options: IntersectionObserverInit & { scrollMargin?: string } = {
      root: this.scrollContainer,
      rootMargin: `${this.preloadMargin}px 0px`,
      threshold: 0
    };
    if ('scrollMargin' in IntersectionObserver.prototype) {
      options.scrollMargin = `${this.preloadMargin}px 0px`;
    }
    return new IntersectionObserver((entries) => this.handleBoundaryIntersections(entries), options);
  }

  private installNavigationListener(): void {
    const navigation = (window as Window & { navigation?: NavigationEventTarget }).navigation;
    if (navigation) {
      navigation.addEventListener('currententrychange', this.handleNavigation, { signal: this.lifecycle.signal });
      return;
    }
    window.addEventListener('popstate', this.handleNavigation, { signal: this.lifecycle.signal });
    window.addEventListener('hashchange', this.handleNavigation, { signal: this.lifecycle.signal });
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

  private scheduleViewportUpdate = (forceGeometry = false): void => {
    if (this.destroyed) return;
    if (forceGeometry) this.forceGeometryUpdate = true;
    if (this.viewportUpdateScheduled) return;
    this.viewportUpdateScheduled = true;
    const update = (): void => {
      this.viewportUpdateScheduled = false;
      if (this.destroyed) return;
      const forceLayout = this.forceGeometryUpdate;
      this.forceGeometryUpdate = false;
      if (!forceLayout && this.contentVisibilityEventsSupported && this.receivedContentVisibilityEvent) {
        this.updateViewportFromContentVisibility();
      } else {
        this.updateViewportFromLayout();
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(update);
    else window.setTimeout(update, 0);
  };

  private updateViewportFromLayout(): void {
    const turns = this.registry.elements();
    if (turns.length === 0) {
      this.clearVisibleResizeTargets();
      this.contentVisibilityTurns.clear();
      return;
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const scrollport = this.scrollContainer?.getBoundingClientRect();
    const viewportTop = Math.max(0, scrollport?.top ?? 0);
    const viewportBottom = Math.min(viewportHeight, scrollport?.bottom ?? viewportHeight);
    if (viewportBottom <= viewportTop) {
      this.clearVisibleResizeTargets();
      this.contentVisibilityTurns.clear();
      return;
    }

    let low = 0;
    let high = turns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (turns[middle]!.getBoundingClientRect().bottom > viewportTop) high = middle;
      else low = middle + 1;
    }
    const firstVisible = low;
    if (firstVisible >= turns.length || turns[firstVisible]!.getBoundingClientRect().bottom <= viewportTop) {
      this.clearVisibleResizeTargets();
      this.contentVisibilityTurns.clear();
      return;
    }

    low = firstVisible;
    high = turns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (turns[middle]!.getBoundingClientRect().top < viewportBottom) low = middle + 1;
      else high = middle;
    }
    const lastVisible = low - 1;
    if (lastVisible < firstVisible || turns[lastVisible]!.getBoundingClientRect().top >= viewportBottom) {
      this.clearVisibleResizeTargets();
      this.contentVisibilityTurns.clear();
      return;
    }

    this.contentVisibilityTurns.clear();
    if (this.contentVisibilityEventsSupported && !this.seededVisibilityWithCheckVisibility) {
      this.seededVisibilityWithCheckVisibility = true;
      for (let index = firstVisible; index <= lastVisible; index += 1) {
        const element = turns[index]! as HTMLElement & {
          checkVisibility?: (options?: { contentVisibilityAuto?: boolean }) => boolean;
        };
        let visible = true;
        try {
          if (element.checkVisibility) visible = element.checkVisibility({ contentVisibilityAuto: true });
        } catch {
          visible = true;
        }
        if (visible) this.contentVisibilityTurns.add(element);
      }
      if (this.contentVisibilityTurns.size === 0) {
        for (let index = firstVisible; index <= lastVisible; index += 1) this.contentVisibilityTurns.add(turns[index]!);
      }
    } else {
      for (let index = firstVisible; index <= lastVisible; index += 1) this.contentVisibilityTurns.add(turns[index]!);
    }
    this.syncVisibleResizeTargets(turns, firstVisible, lastVisible);
    this.reportViewport(firstVisible, lastVisible);
  }

  private updateViewportFromContentVisibility(): void {
    const turns = this.registry.elements();
    let firstVisible = turns.length;
    let lastVisible = -1;
    for (const element of this.contentVisibilityTurns) {
      const index = this.registry.indexOf(element);
      if (index === undefined) continue;
      firstVisible = Math.min(firstVisible, index);
      lastVisible = Math.max(lastVisible, index);
    }
    if (lastVisible < firstVisible) {
      this.updateViewportFromLayout();
      return;
    }
    this.syncVisibleResizeTargets(turns, firstVisible, lastVisible);
    this.reportViewport(firstVisible, lastVisible);
  }

  private reportViewport(firstVisible: number, lastVisible: number): void {
    if (firstVisible === this.lastReportedFirst && lastVisible === this.lastReportedLast) return;
    this.lastReportedFirst = firstVisible;
    this.lastReportedLast = lastVisible;
    this.callbacks?.onViewport(firstVisible, lastVisible);
  }

  private syncVisibleResizeTargets(turns: readonly HTMLElement[], first: number, last: number): void {
    if (!this.resizeObserver) return;
    let unchanged = this.visibleResizeTargets.size === last - first + 1;
    if (unchanged) {
      for (let index = first; index <= last; index += 1) {
        if (!this.visibleResizeTargets.has(turns[index]!)) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) return;

    this.clearVisibleResizeTargets();
    for (let index = first; index <= last; index += 1) {
      const element = turns[index]!;
      this.visibleResizeTargets.add(element);
      this.resizeObserver.observe(element);
    }
  }

  private clearVisibleResizeTargets(): void {
    if (this.resizeObserver) {
      for (const element of this.visibleResizeTargets) this.resizeObserver.unobserve(element);
    }
    this.visibleResizeTargets.clear();
    this.lastReportedFirst = -1;
    this.lastReportedLast = -1;
  }

  private handleContentVisibilityChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || this.registry.indexOf(target) === undefined) return;
    const skipped = (event as ContentVisibilityEvent).skipped;
    if (typeof skipped !== 'boolean') return;
    this.receivedContentVisibilityEvent = true;
    if (skipped) this.contentVisibilityTurns.delete(target);
    else this.contentVisibilityTurns.add(target);
    this.scheduleViewportUpdate();
  };

  private handleScroll = (): void => {
    this.loadGate.onScroll();
    if (!this.contentVisibilityEventsSupported || !this.receivedContentVisibilityEvent) {
      this.scheduleViewportUpdate();
    }
  };

  private handleWindowResize = (): void => {
    this.scheduleViewportUpdate(true);
  };

  private handleNavigation = (): void => {
    if (this.mountedUrl === location.href) return;
    this.mountedUrl = location.href;
    this.callbacks?.onRootChanged();
  };
}
