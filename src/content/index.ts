import { loadConfig, normalizeConfig } from '../shared/config';
import { logger } from '../shared/logger';
import type { ContentRequest, ContentResponse, OptimizerConfig, OptimizerStats } from '../shared/types';
import { detectTurns, extractTurnsFromNode, findConversationRoot, isValidConversationRoot } from './detector';
import { ConversationObservers } from './observers';
import { Optimizer } from './optimizer';
import { TurnRegistry } from './registry';
import { Scheduler } from './scheduler';
import { PerformanceMetrics } from './metrics';
import { StatusSurface } from './ui';

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
    if (!root || !isValidConversationRoot(root)) {
      this.disabledReason = 'unsupported-dom';
      return;
    }

    this.disabledReason = undefined;
    this.mount(root);
  }

  private mount(root: HTMLElement): void {
    this.stopDiscoveryObserver();
    this.currentRoot = root;
    this.registry.clear();
    this.registry.addMany(detectTurns(root));
    this.optimizer = new Optimizer(this.registry, this.effectiveConfig());
    this.observers = new ConversationObservers(this.registry, this.config.preloadMargin);
    this.observers.mount(root, {
      onMutations: (records) => this.handleMutations(records),
      onViewport: (firstVisible, lastVisible) => this.handleViewport(firstVisible, lastVisible),
      onExpandBefore: () => this.handleExpandBefore(),
      onRootChanged: () => this.handleRootChanged()
    });
    this.reconcile();
    logger.info('conversation optimizer mounted', { turns: this.registry.count() });
  }

  private handleMutations(records: MutationRecord[]): void {
    let registryChanged = false;
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        const elements = extractTurnsFromNode(node).filter((element) => this.currentRoot?.contains(element));
        if (elements.length > 0) {
          this.registry.addMany(elements);
          registryChanged = true;
        }
      }
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof HTMLElement) {
          this.registry.remove(node);
          for (const info of this.registry.ordered()) {
            if (node.contains(info.element)) this.registry.remove(info.element);
          }
          registryChanged = true;
        }
      }
    }

    if (!registryChanged) return;
    this.scheduler.idle(() => {
      this.registry.cleanupDisconnected();
      this.metrics.refreshDomCount();
    });
    this.scheduler.frame(() => this.reconcile());
  }

  private handleViewport(firstVisible: number, lastVisible: number): void {
    this.scheduler.frame(() => {
      this.optimizer?.updateViewport(firstVisible, lastVisible);
      this.refreshObserverWindow();
      this.updateStatus();
    });
  }

  private handleExpandBefore(): void {
    this.optimizer?.expandBefore();
    this.refreshObserverWindow();
    this.updateStatus();
  }

  private handleRootChanged(): void {
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
    const infos = this.registry.ordered();
    this.observers.updateTurns(infos);
    this.observers.setCurrentWindowStart(this.optimizer.windowState.start);
  }

  private effectiveConfig(): OptimizerConfig {
    return this.tabDisabled ? { ...this.config, enabled: false } : this.config;
  }

  private async refreshConfig(): Promise<void> {
    this.config = await loadConfig();
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
      domElements: this.metrics.domCount,
      rootDetected: Boolean(this.currentRoot),
      ...(this.disabledReason ? { disabledReason: this.disabledReason } : {})
    };
  }

  private updateStatus(): void {
    this.metrics.refreshDomCount();
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
      this.optimizer?.updateConfig(this.effectiveConfig());
      this.updateStatus();
      sendResponse({ ok: true, stats: this.getStats() });
      return false;
    }
    return false;
  };

  private teardown(): void {
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
