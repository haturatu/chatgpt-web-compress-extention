import { loadConfig, saveConfig } from '../shared/config';
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
    ? 'Hides off-window content and remote media. Search and page controls may be affected.'
    : config.mode === 'safe'
      ? 'Uses CSS containment; the browser tracks turns without scroll-time extension work.'
      : 'Keeps a moving group of turns active around your viewport.';
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
  $('thread-status').textContent = !stats?.rootDetected ? 'Not detected' : active ? 'Optimizing' : 'Paused';
  $('turns').textContent = stats ? String(stats.turns) : '—';
  $('active').textContent = stats ? String(stats.active) : '—';
  $('dormant').textContent = stats ? String(stats.dormant) : '—';
  $('long-tasks').textContent = stats ? String(stats.longTasks) : '—';
  tabDisabled = Boolean(config.enabled && stats?.rootDetected && !stats.enabled);
  $('tab-toggle').textContent = tabDisabled ? 'Enable for this tab' : 'Disable for this tab';
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
    empty.textContent = 'No saved conversations';
    list.append(empty);
    return;
  }
  for (const archive of response.archives.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'archive-entry';
    const label = document.createElement('span');
    label.textContent = `${archive.title} · ${archive.turnCount} turns`;
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open';
    open.setAttribute('aria-label', `Open ${archive.title} in Lite Reader`);
    open.addEventListener('click', async () => {
      setMessage('Opening Lite Reader…');
      const result = await extensionMessage<{ ok: boolean; error?: string }>({ type: 'archive:open', archiveId: archive.id });
      setMessage(result?.ok ? 'Lite Reader opened' : result?.error ?? 'Could not open this archive.');
    });
    row.append(label, open);
    list.append(row);
  }
}

async function archiveCurrentConversation(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === undefined) {
    setMessage('Open a ChatGPT conversation to create an archive.');
    return;
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    setMessage('The active tab could not be read.');
    return;
  }
  if (!tab.url?.startsWith('https://chatgpt.com/c/') && !tab.url?.startsWith('https://chat.openai.com/c/')) {
    setMessage('Open a ChatGPT conversation to create an archive.');
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
  button.textContent = 'Saving compressed archive…';
  setMessage('Reading currently rendered turns…');
  try {
    const captured = await chrome.tabs.sendMessage(target.tabId, { type: 'create-archive-snapshot' }) as ContentResponse;
    if (!captured?.ok || !captured.snapshot) throw new Error(captured?.error ?? 'Could not read this conversation.');
    const saved = await extensionMessage<{ ok: boolean; manifest?: { id: string; turnCount: number }; error?: string }>({
      type: 'archive:create-dom',
      snapshot: captured.snapshot,
      sourceTabId: target.tabId,
      sourceUrl: target.url
    });
    if (!saved?.ok || !saved.manifest?.id) throw new Error(saved?.error ?? 'Could not save the compressed archive.');
    setMessage('Archive saved. Opening the Lite Reader…');
    const handoff = await extensionMessage<{ ok: boolean; discarded?: boolean; error?: string }>({
      type: 'archive:open-and-discard',
      archiveId: saved.manifest.id,
      sourceTabId: target.tabId,
      sourceUrl: target.url
    });
    if (!handoff?.ok) throw new Error(handoff?.error ?? 'The archive was saved, but the Reader could not open.');
    setMessage(handoff.discarded
      ? `Lite Reader opened with ${saved.manifest.turnCount} turns; the original tab was discarded.`
      : `Lite Reader opened with ${saved.manifest.turnCount} turns; the original tab is still active in memory.`);
    await refreshArchives();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'The archive could not be created.');
  } finally {
    button.disabled = false;
    button.textContent = 'Archive visible turns & free memory…';
  }
}

async function updateConfig(partial: Partial<OptimizerConfig>): Promise<void> {
  config = await saveConfig({ ...config, ...partial });
  renderConfig();
  setMessage('Saved');
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
      setMessage('Open a ChatGPT tab to control this setting.');
      return;
    }
    renderStats(response.stats);
    setMessage(tabDisabled ? 'Enabled for this tab' : 'Disabled for this tab');
  });
  $('open-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });
  await refreshStats();
  await refreshArchives();
}

void init().catch(() => setMessage('Something went wrong—reload the popup and try again.'));
