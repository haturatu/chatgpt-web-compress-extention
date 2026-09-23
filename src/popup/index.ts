import { loadConfig, saveConfig } from '../shared/config';
import type { ContentRequest, ContentResponse, OptimizerConfig, OptimizerStats } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};

let config: OptimizerConfig;
let tabDisabled = false;

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
  $('mode-hint').textContent = config.mode === 'memory-saver'
    ? 'Hides off-window message content. Search, accessibility, and ChatGPT controls may be affected.'
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
}

void init().catch(() => setMessage('Something went wrong—reload the popup and try again.'));
