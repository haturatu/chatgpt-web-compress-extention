import { loadConfig, saveConfig } from '../shared/config';
import { t } from '../shared/i18n';
import type { ContentRequest, ContentResponse, OptimizerConfig, OptimizerStats } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};

let config: OptimizerConfig;
let tabDisabled = false;
let pendingArchiveTarget: { tabId: number; url: string } | null = null;

async function activeTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0]?.id;
}

async function sendToTab(request: ContentRequest): Promise<ContentResponse | null> {
  const tabId = await activeTabId();
  if (tabId === undefined) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch {
    return null;
  }
}

function setMessage(message: string): void {
  $('message').textContent = message;
}

function renderConfig(): void {
  ($('enabled') as HTMLInputElement).checked = config.enabled;
  ($('mode') as HTMLSelectElement).value = config.mode;
  $('mode-hint').textContent = config.mode === 'hibernate'
    ? t('popupModeHintHibernate')
    : config.mode === 'safe'
      ? t('popupModeHintSafe')
      : t('popupModeHintWindow');
  ($('active-window') as HTMLInputElement).value = String(config.activeWindow);
  ($('batch-size') as HTMLInputElement).value = String(config.batchSize);
  ($('auto-load') as HTMLInputElement).checked = config.autoLoad;
  ($('show-stats') as HTMLInputElement).checked = config.showStats;
  $('active-window-value').textContent = `${config.activeWindow}`;
  $('batch-size-value').textContent = `${config.batchSize}`;
}

function renderStats(stats: OptimizerStats | undefined): void {
  const active = Boolean(stats?.enabled);
  $('status-dot').dataset.active = String(active);
  $('thread-status').textContent = !stats?.rootDetected
    ? t('threadStateNotDetected')
    : active ? t('threadStateOptimizing') : t('threadStatePaused');
  $('turns').textContent = stats ? String(stats.turns) : '—';
  $('active').textContent = stats ? String(stats.active) : '—';
  $('dormant').textContent = stats ? String(stats.dormant) : '—';
  $('long-tasks').textContent = stats ? String(stats.longTasks) : '—';
  tabDisabled = Boolean(config.enabled && stats?.rootDetected && !stats.enabled);
  $('tab-toggle').textContent = tabDisabled ? t('enableForThisTab') : t('disableForThisTab');
}

async function refreshStats(): Promise<void> {
  const response = await sendToTab({ type: 'get-stats' });
  renderStats(response?.stats);
}

function extensionMessage<T>(message: object): Promise<T | null> {
  return chrome.runtime.sendMessage(message).catch(() => null) as Promise<T | null>;
}

async function refreshArchives(): Promise<void> {
  const list = $('archives');
  list.replaceChildren();
  const response = await extensionMessage<{ ok: boolean; archives?: Array<{
    id: string; title: string; turnCount: number; createdAt: number;
  }> }>({ type: 'archive:list' });
  if (!response?.ok || !response.archives?.length) {
    const empty = document.createElement('span');
    empty.className = 'hint';
    empty.textContent = t('noSavedConversations');
    list.append(empty);
    return;
  }
  for (const archive of response.archives.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'archive-entry';
    const label = document.createElement('span');
    label.textContent = t('archiveEntry', archive.title, String(archive.turnCount));
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = t('open');
    open.setAttribute('aria-label', t('openArchiveAria', archive.title));
    open.addEventListener('click', async () => {
      setMessage(t('openingLiteReader'));
      const result = await extensionMessage<{ ok: boolean; error?: string }>({ type: 'archive:open', archiveId: archive.id });
      setMessage(result?.ok ? t('liteReaderOpened') : result?.error ?? t('couldNotOpenArchive'));
    });
    row.append(label, open);
    list.append(row);
  }
}

async function archiveCurrentConversation(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === undefined) {
    setMessage(t('openConversationToArchive'));
    return;
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    setMessage(t('activeTabCouldNotRead'));
    return;
  }
  if (!tab.url?.startsWith('https://chatgpt.com/c/') && !tab.url?.startsWith('https://chat.openai.com/c/')) {
    setMessage(t('openConversationToArchive'));
    return;
  }
  pendingArchiveTarget = { tabId, url: tab.url };
  const dialog = $('archive-confirm') as HTMLDialogElement;
  dialog.showModal();
}

async function createArchiveAndDiscard(): Promise<void> {
  const target = pendingArchiveTarget;
  if (!target) return;
  pendingArchiveTarget = null;
  const button = $('archive-current') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = t('savingCompressedArchive');
  setMessage(t('readingRenderedTurns'));
  try {
    const captured = await chrome.tabs.sendMessage(target.tabId, { type: 'create-archive-snapshot' }) as ContentResponse;
    if (!captured?.ok || !captured.snapshot) throw new Error(captured?.error ?? t('couldNotReadConversation'));
    const saved = await extensionMessage<{ ok: boolean; manifest?: { id: string; turnCount: number }; error?: string }>({
      type: 'archive:create-dom',
      snapshot: captured.snapshot,
      sourceTabId: target.tabId,
      sourceUrl: target.url
    });
    if (!saved?.ok || !saved.manifest?.id) throw new Error(saved?.error ?? t('couldNotSaveCompressedArchive'));
    setMessage(t('archiveSavedOpeningReader'));
    const handoff = await extensionMessage<{ ok: boolean; discarded?: boolean; error?: string }>({
      type: 'archive:open-and-discard',
      archiveId: saved.manifest.id,
      sourceTabId: target.tabId,
      sourceUrl: target.url
    });
    if (!handoff?.ok) throw new Error(handoff?.error ?? t('readerCouldNotOpenAfterSave'));
    setMessage(handoff.discarded
      ? t('readerOpenedDiscarded', String(saved.manifest.turnCount))
      : t('readerOpenedStillActive', String(saved.manifest.turnCount)));
    await refreshArchives();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : t('archiveCouldNotBeCreated'));
  } finally {
    button.disabled = false;
    button.textContent = t('archiveButton');
  }
}

async function updateConfig(partial: Partial<OptimizerConfig>): Promise<void> {
  config = await saveConfig({ ...config, ...partial });
  renderConfig();
  setMessage(t('saved'));
  await refreshStats();
}

async function init(): Promise<void> {
  config = await loadConfig();
  renderConfig();
  ($('settings-form') as HTMLFormElement).addEventListener('submit', (event) => event.preventDefault());
  $('enabled').addEventListener('change', () => void updateConfig({ enabled: ($('enabled') as HTMLInputElement).checked }));
  $('mode').addEventListener('change', () => void updateConfig({ mode: ($('mode') as HTMLSelectElement).value as OptimizerConfig['mode'] }));
  $('active-window').addEventListener('input', () => {
    const value = Number(($('active-window') as HTMLInputElement).value);
    $('active-window-value').textContent = String(value);
  });
  $('active-window').addEventListener('change', () => void updateConfig({ activeWindow: Number(($('active-window') as HTMLInputElement).value) }));
  $('batch-size').addEventListener('input', () => {
    const value = Number(($('batch-size') as HTMLInputElement).value);
    $('batch-size-value').textContent = String(value);
  });
  $('batch-size').addEventListener('change', () => void updateConfig({ batchSize: Number(($('batch-size') as HTMLInputElement).value) }));
  $('auto-load').addEventListener('change', () => void updateConfig({ autoLoad: ($('auto-load') as HTMLInputElement).checked }));
  $('show-stats').addEventListener('change', () => void updateConfig({ showStats: ($('show-stats') as HTMLInputElement).checked }));
  $('archive-current').addEventListener('click', () => void archiveCurrentConversation());
  $('confirm-archive').addEventListener('click', (event) => {
    event.preventDefault();
    ($('archive-confirm') as HTMLDialogElement).close();
    void createArchiveAndDiscard();
  });
  $('tab-toggle').addEventListener('click', async () => {
    const response = await sendToTab({ type: tabDisabled ? 'enable-for-tab' : 'disable-for-tab' });
    if (!response) {
      setMessage(t('openChatGPTTabToControl'));
      return;
    }
    renderStats(response.stats);
    setMessage(tabDisabled ? t('enabledForTab') : t('disabledForTab'));
  });
  $('open-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });
  await refreshStats();
  await refreshArchives();
}

void init().catch(() => setMessage(t('popupReloadError')));
