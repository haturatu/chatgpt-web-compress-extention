import { loadConfig, saveConfig } from '../shared/config';
import { localizeDocument, t } from '../shared/i18n';
import type { NetworkDiscoveryRecord, OptimizerConfig } from '../shared/types';

localizeDocument();

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
    ? t('modeHintHibernate')
    : config.mode === 'safe'
      ? t('modeHintSafe')
      : t('modeHintWindow');
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
  select.replaceChildren(new Option(t('noResponseSelected'), ''));
  const candidates = discoveryRecords.filter((record) => /application\/json|\+json/i.test(record.contentType));
  if (current && !candidates.some((record) => record.path === current)) {
    select.add(new Option(t('jsonResponsePathSaved', current), current));
  }
  for (const record of candidates) {
    const size = record.encodedBytes > 0
      ? t('kilobytes', String(Math.round(record.encodedBytes / 1024)))
      : t('sizeUnknown');
    select.add(new Option(t('jsonResponseEntry', record.method, record.path, size, String(record.observations)), record.path));
  }
  select.value = candidates.some((record) => record.path === current) ? current : '';
  $('discovery-count').textContent = candidates.length
    ? t('responsesRecorded', String(candidates.length))
    : t('noResponsesRecorded');
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
      $('message').textContent = t('selectJsonBeforeHardMemory');
      $('hard-memory-path').focus();
      return;
    }
    config = await saveConfig(next);
    await chrome.runtime.sendMessage({ type: 'hard-memory:sync' }).catch(() => undefined);
    render();
    $('message').textContent = t('savedReloadToApply');
  });
  $('clear-discovery').addEventListener('click', async () => {
    await chrome.storage.local.remove('networkDiscoveryRecords');
    discoveryRecords = [];
    if (config.hardMemoryPayloadPath) {
      config = await saveConfig({ ...config, hardMemoryPayloadPath: '' });
      await chrome.runtime.sendMessage({ type: 'hard-memory:sync' }).catch(() => undefined);
    }
    renderDiscoveryCandidates();
    $('message').textContent = t('discoveryDataCleared');
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && 'networkDiscoveryRecords' in changes) void loadDiscoveryRecords();
  });
  await loadDiscoveryRecords();
}

void init().catch(() => { $('message').textContent = t('optionsReloadError'); });
