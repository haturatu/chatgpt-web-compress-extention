import { loadConfig, saveConfig } from '../shared/config';
import type { OptimizerConfig } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing options element: ${id}`);
  return element as T;
};

let config: OptimizerConfig;

function render(): void {
  ($('enabled') as HTMLInputElement).checked = config.enabled;
  ($('mode') as HTMLSelectElement).value = config.mode;
  ($('active-window') as HTMLInputElement).value = String(config.activeWindow);
  ($('batch-size') as HTMLInputElement).value = String(config.batchSize);
  ($('pinned-tail') as HTMLInputElement).value = String(config.pinnedTail);
  ($('preload-margin') as HTMLInputElement).value = String(config.preloadMargin);
  ($('auto-load') as HTMLInputElement).checked = config.autoLoad;
  ($('show-stats') as HTMLInputElement).checked = config.showStats;
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
      showStats: ($('show-stats') as HTMLInputElement).checked
    };
    config = await saveConfig(next);
    render();
    $('message').textContent = 'Saved';
  });
}

void init().catch(() => { $('message').textContent = 'Something went wrong—reload this page and try again.'; });
