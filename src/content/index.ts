import { loadConfig, normalizeConfig } from '../shared/config';
import { logger } from '../shared/logger';
import type { ContentRequest, ContentResponse, OptimizerConfig, OptimizerStats } from '../shared/types';
import { detectTurnsYielding, extractTurnsFromNode, findConversationRoot } from './detector';
import { ConversationObservers } from './observers';
import { Optimizer } from './optimizer';
import { TurnRegistry } from './registry';
import { Scheduler, yieldToBrowser } from './scheduler';
import { PerformanceMetrics } from './metrics';
import { StatusSurface } from './ui';
import { LONG_MARKDOWN_ATTRIBUTE } from './selectors';

const MARKDOWN_SELECTOR = '[class~="markdown"]';
const LONG_MARKDOWN_CHILD_COUNT = 24;

function markLongMarkdown(root: HTMLElement): void {
  for (const markdown of root.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR)) {
    if (markdown.children.length >= LONG_MARKDOWN_CHILD_COUNT) {
      markdown.setAttribute(LONG_MARKDOWN_ATTRIBUTE, '');
    }
  }
}

function markLongMarkdownFromMutations(root: HTMLElement, records: readonly MutationRecord[]): void {
  const candidates = new Set<HTMLElement>();
  for (const record of records) {
    const target = record.target instanceof HTMLElement
      ? record.target
      : record.target.parentElement;
    const ancestor = target?.closest<HTMLElement>(MARKDOWN_SELECTOR);
    if (ancestor) candidates.add(ancestor);

    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      const parentMarkdown = node.parentElement?.closest<HTMLElement>(MARKDOWN_SELECTOR);
      if (parentMarkdown) candidates.add(parentMarkdown);
      if (node.matches(MARKDOWN_SELECTOR)) candidates.add(node);
      for (const markdown of node.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR)) candidates.add(markdown);
    }
  }

  for (const markdown of candidates) {
    if (root.contains(markdown) && markdown.children.length >= LONG_MARKDOWN_CHILD_COUNT) {
      markdown.setAttribute(LONG_MARKDOWN_ATTRIBUTE, '');
    }
  }
}

class ContentController {
  private config: OptimizerConfig = normalizeConfig(undefined);
  private readonly registry = new TurnRegistry();
  private readonly scheduler = new Scheduler();
  private readonly metrics = new PerformanceMetrics();
  private readonly status = new StatusSurface();
  private optimizer: Optimizer | null = null;
  private observers: ConversationObservers | null = null;
  private currentRoot: HTMLElement | null = null;
  private discoveryObserver: MutationObserver | null = null;
  private storageListener: ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void) | null = null;
  private tabDisabled = false;
  private lastUrl = location.href;
  private disabledReason: string | undefined;
  private mountGeneration = 0;

  async start(): Promise<void> {
    this.config = await loadConfig();
    this.storageListener = (changes, areaName) => {
      if (areaName !== 'local' || Object.keys(changes).length === 0) return;
      void this.refreshConfig();
    };
    chrome.storage.onChanged.addListener(this.storageListener);
    chrome.runtime.onMessage.addListener(this.handleMessage);
    this.beginDiscovery();
  }

  private beginDiscovery(): void {
    this.stopDiscoveryObserver();
    this.discoverAndMount();
    if (this.currentRoot) return;

    if (!document.body) return;
    this.discoveryObserver = new MutationObserver((records) => {
      const relevant = records.some((record) => Array.from(record.addedNodes).some((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const hasMain = node.matches('main, [role="main"]') || Boolean(node.querySelector('main, [role="main"]'));
        const hasTurn = node.matches(
          'article, [data-testid^="conversation-turn"], [data-message-author-role]'
        ) || Boolean(node.querySelector(
          'article, [data-testid^="conversation-turn"], [data-message-author-role]'
        ));
        return hasMain || (hasTurn && Boolean(node.closest('main, [role="main"]')));
      }));
      if (relevant) this.scheduler.frame(() => this.discoverAndMount());
    });
    this.discoveryObserver.observe(document.body, { childList: true, subtree: true });
  }

  private discoverAndMount(): void {
    if (this.lastUrl !== location.href) {
      this.lastUrl = location.href;
      this.teardown();
    }

    if (this.currentRoot?.isConnected) return;
    const root = findConversationRoot(document);
    if (!root) {
      this.disabledReason = 'unsupported-dom';
      return;
    }

    this.disabledReason = undefined;
    this.mount(root);
  }

  private mount(root: HTMLElement): void {
    this.stopDiscoveryObserver();
    const generation = ++this.mountGeneration;
    this.currentRoot = root;
    this.registry.clear();
    this.optimizer = new Optimizer(this.registry, this.effectiveConfig(), root);
    this.observers = new ConversationObservers(this.registry, this.config.preloadMargin, this.config.mode);
    this.observers.mount(root, {
      onMutations: (records) => this.handleMutations(records),
      onViewport: (firstVisible, lastVisible) => this.handleViewport(firstVisible, lastVisible),
      onResize: (entries) => this.handleResizes(entries),
      onExpandBefore: () => this.handleExpandBefore(),
      onRootChanged: () => this.handleRootChanged()
    });

    if (this.config.enabled && !this.tabDisabled) markLongMarkdown(root);
    if (this.config.mode === 'safe') {
      this.reconcile();
      logger.info('conversation optimizer mounted', { mode: 'safe-css-native' });
      return;
    }
    void this.initializeTurns(root, generation);
  }

  private async initializeTurns(root: HTMLElement, generation: number): Promise<void> {
    const shouldContinue = (): boolean =>
      generation === this.mountGeneration && root === this.currentRoot && root.isConnected;
    const elements = await detectTurnsYielding(root, yieldToBrowser, 64, shouldContinue);
    if (generation !== this.mountGeneration || root !== this.currentRoot || !root.isConnected) return;
    await this.registry.addManyYielding(elements, yieldToBrowser, 64, () =>
      generation === this.mountGeneration && root === this.currentRoot && root.isConnected
    );
    if (generation !== this.mountGeneration || root !== this.currentRoot || !root.isConnected) return;
    this.observers?.refreshViewport(true);
    this.reconcile();
    logger.info('conversation optimizer mounted', { turns: this.registry.count(), mode: this.config.mode });
  }

  private handleMutations(records: MutationRecord[]): void {
    const root = this.currentRoot;
    if (!root) return;
    if (this.config.enabled && !this.tabDisabled) markLongMarkdownFromMutations(root, records);
    if (this.config.mode === 'safe') {
      if (this.config.showStats) this.scheduler.idle(() => this.updateStatus());
      return;
    }

    let registryChanged = false;
    let registryRemoved = false;
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        const elements = extractTurnsFromNode(node).filter((element) => this.currentRoot?.contains(element));
        if (elements.length > 0 && this.registry.addMany(elements) > 0) registryChanged = true;
      }
      for (const node of Array.from(record.removedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        const mayContainTurn = this.registry.has(node)
          || Boolean(node.querySelector('[data-testid^="conversation-turn"], article, [data-message-author-role]'));
        if (mayContainTurn && this.registry.removeWithin(node) > 0) {
          registryChanged = true;
          registryRemoved = true;
        }
      }
    }

    if (!registryChanged) return;
    this.observers?.refreshViewport(true);
    if (registryRemoved) {
      this.scheduler.idle(() => {
        this.registry.cleanupDisconnected();
        this.scheduler.task(() => this.reconcile(), 'user-visible');
      });
    }
    this.scheduler.task(() => this.reconcile(), 'user-visible');
  }

  private handleViewport(firstVisible: number, lastVisible: number): void {
    this.optimizer?.updateViewport(firstVisible, lastVisible);
    this.refreshObserverWindow();
    this.updateStatus();
  }

  private handleResizes(entries: readonly ResizeObserverEntry[]): void {
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement) || !this.registry.has(entry.target)) continue;
      this.optimizer?.recordHeight(entry.target, entry.target.getBoundingClientRect().height || entry.contentRect.height);
    }
  }

  private handleExpandBefore(): void {
    this.optimizer?.expandBefore();
    this.refreshObserverWindow();
    this.updateStatus();
  }

  private handleRootChanged(): void {
    if (!this.currentRoot) return;
    this.teardown();
    this.beginDiscovery();
  }

  private reconcile(): void {
    if (!this.currentRoot?.isConnected || this.lastUrl !== location.href) {
      this.handleRootChanged();
      return;
    }
    this.optimizer?.reconcile();
    this.refreshObserverWindow();
    this.updateStatus();
  }

  private refreshObserverWindow(): void {
    if (!this.observers || !this.optimizer) return;
    this.observers.setCurrentWindowStart(this.optimizer.windowState.start);
  }

  private effectiveConfig(): OptimizerConfig {
    return this.tabDisabled ? { ...this.config, enabled: false } : this.config;
  }

  private async refreshConfig(): Promise<void> {
    const previous = this.config;
    this.config = await loadConfig();
    if (previous.mode !== this.config.mode || previous.preloadMargin !== this.config.preloadMargin) {
      const root = this.currentRoot;
      if (root?.isConnected) {
        this.teardown();
        this.mount(root);
        return;
      }
    }
    if (this.config.enabled && !this.tabDisabled && this.currentRoot) markLongMarkdown(this.currentRoot);
    this.optimizer?.updateConfig(this.effectiveConfig());
    this.reconcile();
  }

  private getStats(): OptimizerStats {
    const optimizationStats = this.optimizer?.getStats() ?? { turns: 0, active: 0, dormant: 0 };
    const viewport = this.optimizer?.viewportState ?? { firstVisible: 0, lastVisible: 0 };
    return {
      enabled: this.config.enabled && !this.tabDisabled && Boolean(this.optimizer),
      mode: this.config.mode,
      ...optimizationStats,
      firstVisible: viewport.firstVisible,
      lastVisible: viewport.lastVisible,
      longTasks: this.metrics.longTasks,
      rootDetected: Boolean(this.currentRoot),
      ...(this.disabledReason ? { disabledReason: this.disabledReason } : {})
    };
  }

  private updateStatus(): void {
    const stats = this.getStats();
    this.status.update(stats, stats.enabled, this.config.showStats);
  }

  private handleMessage = (
    request: ContentRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ContentResponse) => void
  ): boolean => {
    if (request?.type === 'get-state' || request?.type === 'get-stats') {
      sendResponse({ ok: true, stats: this.getStats() });
      return false;
    }
    if (request?.type === 'disable-for-tab') {
      this.tabDisabled = true;
      this.optimizer?.updateConfig(this.effectiveConfig());
      this.updateStatus();
      sendResponse({ ok: true, stats: this.getStats() });
      return false;
    }
    if (request?.type === 'enable-for-tab') {
      this.tabDisabled = false;
      if (this.config.enabled && this.currentRoot) markLongMarkdown(this.currentRoot);
      this.optimizer?.updateConfig(this.effectiveConfig());
      this.updateStatus();
      sendResponse({ ok: true, stats: this.getStats() });
      return false;
    }
    return false;
  };

  private teardown(): void {
    this.mountGeneration += 1;
    this.scheduler.cancelPending();
    this.stopDiscoveryObserver();
    this.observers?.destroy();
    this.optimizer?.destroy();
    this.status.destroy();
    this.registry.clear();
    this.observers = null;
    this.optimizer = null;
    this.currentRoot = null;
  }

  private stopDiscoveryObserver(): void {
    this.discoveryObserver?.disconnect();
    this.discoveryObserver = null;
  }
}

void new ContentController().start().catch((error: unknown) => {
  logger.error('optimizer startup failed; leaving ChatGPT untouched', error);
});
