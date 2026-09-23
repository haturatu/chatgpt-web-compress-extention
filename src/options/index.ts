import { loadConfig, saveConfig } from '../shared/config';
import type { NetworkDiscoveryRecord, OptimizerConfig } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing options element: ${id}`);
  return element as T;
};

let config: OptimizerConfig;
let discoveryRecords: NetworkDiscoveryRecord[] = [];

function render(): void {
  ($('enabled') as HTMLInputElement).checked = config.enabled;
  ($('mode') as HTMLSelectElement).value = config.mode;
  $('mode-hint').textContent = config.mode === 'hibernate'
    ? 'Hides off-window content and pauses restorable remote media; page search may be affected.'
    : config.mode === 'safe'
      ? 'Uses CSS containment; the browser tracks turns without scroll-time extension work.'
      : 'Keeps a moving group of turns active around your viewport.';
  ($('active-window') as HTMLInputElement).value = String(config.activeWindow);
  ($('batch-size') as HTMLInputElement).value = String(config.batchSize);
  ($('pinned-tail') as HTMLInputElement).value = String(config.pinnedTail);
  ($('preload-margin') as HTMLInputElement).value = String(config.preloadMargin);
  ($('auto-load') as HTMLInputElement).checked = config.autoLoad;
  ($('show-stats') as HTMLInputElement).checked = config.showStats;
  ($('network-discovery') as HTMLInputElement).checked = config.networkDiscoveryEnabled;
  ($('hard-memory') as HTMLInputElement).checked = config.hardMemoryEnabled;
  ($('hard-memory-turns') as HTMLInputElement).value = String(config.hardMemoryRetainedTurns);
  renderDiscoveryCandidates();
}

function renderDiscoveryCandidates(): void {
  const select = $('hard-memory-path') as HTMLSelectElement;
  const current = config.hardMemoryPayloadPath;
  select.replaceChildren(new Option('No response selected', ''));
  const candidates = discoveryRecords.filter((record) => /application\/json|\+json/i.test(record.contentType));
  if (current && !candidates.some((record) => record.path === current)) {
    select.add(new Option(`${current} · saved selection`, current));
  }
  for (const record of candidates) {
    const size = record.encodedBytes > 0 ? `${Math.round(record.encodedBytes / 1024)} KB` : 'size unknown';
    select.add(new Option(`${record.method} ${record.path} · ${size} · ${record.observations} seen`, record.path));
  }
  select.value = candidates.some((record) => record.path === current) ? current : '';
  $('discovery-count').textContent = candidates.length
    ? `${candidates.length} JSON response paths recorded`
    : 'No JSON responses recorded';
}

async function loadDiscoveryRecords(): Promise<void> {
  const stored = await chrome.storage.local.get('networkDiscoveryRecords');
  discoveryRecords = Array.isArray(stored.networkDiscoveryRecords)
    ? stored.networkDiscoveryRecords as NetworkDiscoveryRecord[]
    : [];
  renderDiscoveryCandidates();
}

function value(id: string): number {
  return Number(($<HTMLInputElement>(id)).value);
}

async function init(): Promise<void> {
  config = await loadConfig();
  render();
  ($('settings-form') as HTMLFormElement).addEventListener('submit', async (event) => {
    event.preventDefault();
    const next = {
      ...config,
      enabled: ($('enabled') as HTMLInputElement).checked,
      mode: ($('mode') as HTMLSelectElement).value as OptimizerConfig['mode'],
      activeWindow: value('active-window'),
      batchSize: value('batch-size'),
      pinnedTail: value('pinned-tail'),
      preloadMargin: value('preload-margin'),
      autoLoad: ($('auto-load') as HTMLInputElement).checked,
      showStats: ($('show-stats') as HTMLInputElement).checked,
      networkDiscoveryEnabled: ($('network-discovery') as HTMLInputElement).checked,
      hardMemoryEnabled: ($('hard-memory') as HTMLInputElement).checked,
      hardMemoryRetainedTurns: value('hard-memory-turns'),
      hardMemoryPayloadPath: ($('hard-memory-path') as HTMLSelectElement).value
    };
    if (next.hardMemoryEnabled && !next.hardMemoryPayloadPath) {
      $('message').textContent = 'Select a JSON response from Network discovery before enabling Hard Memory.';
      $('hard-memory-path').focus();
      return;
    }
    config = await saveConfig(next);
    await chrome.runtime.sendMessage({ type: 'hard-memory:sync' }).catch(() => undefined);
    render();
    $('message').textContent = 'Saved. Reload the ChatGPT tab to apply document-start settings.';
  });
  $('clear-discovery').addEventListener('click', async () => {
    await chrome.storage.local.remove('networkDiscoveryRecords');
    discoveryRecords = [];
    if (config.hardMemoryPayloadPath) {
      config = await saveConfig({ ...config, hardMemoryPayloadPath: '' });
      await chrome.runtime.sendMessage({ type: 'hard-memory:sync' }).catch(() => undefined);
    }
    renderDiscoveryCandidates();
    $('message').textContent = 'Discovery data cleared';
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && 'networkDiscoveryRecords' in changes) void loadDiscoveryRecords();
  });
  await loadDiscoveryRecords();
}

void init().catch(() => { $('message').textContent = 'Something went wrong—reload this page and try again.'; });
