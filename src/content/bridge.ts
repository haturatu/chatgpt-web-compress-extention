import { loadConfig } from '../shared/config';
import { t } from '../shared/i18n';
import type { ArchiveSnapshot, NetworkDiscoveryRecord } from '../shared/types';

const BRIDGE_SOURCE = 'thread-optimizer-extension-bridge';

interface MainWorldMessage {
  source?: string;
  type?: string;
  record?: Partial<NetworkDiscoveryRecord>;
  requestId?: string;
  snapshot?: ArchiveSnapshot;
}

function sendConfiguration(): void {
  void loadConfig().then((config) => {
    window.postMessage({
      source: BRIDGE_SOURCE,
      type: 'configuration',
      config: {
        networkDiscoveryEnabled: config.networkDiscoveryEnabled,
        hardMemoryEnabled: config.hardMemoryEnabled,
        hardMemoryRetainedTurns: config.hardMemoryRetainedTurns,
        hardMemoryPayloadPath: config.hardMemoryPayloadPath
      }
    }, location.origin);
  });
}

window.addEventListener('message', (event: MessageEvent<MainWorldMessage>) => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== BRIDGE_SOURCE) return;
  const message = event.data;
  if (message.type === 'network-record' && message.record) {
    void chrome.runtime.sendMessage({ type: 'network:record', record: message.record }).catch(() => undefined);
    return;
  }
  if (message.type !== 'hard-memory-archive' || !message.requestId || !message.snapshot) return;
  void loadConfig().then(async (config) => {
    if (!config.hardMemoryEnabled || !message.snapshot || message.snapshot.sourceUrl !== location.href) {
      throw new Error(t('errorHardMemoryDisabled'));
    }
    const response = await chrome.runtime.sendMessage({ type: 'archive:create-hard', snapshot: message.snapshot });
    if (!response?.ok || !response.manifest?.id) throw new Error(response?.error ?? t('couldNotSaveCompressedArchive'));
    window.postMessage({
      source: BRIDGE_SOURCE,
      type: 'hard-memory-archive-ack',
      requestId: message.requestId,
      ok: true,
      archiveId: response.manifest.id
    }, location.origin);
  }).catch(() => {
    window.postMessage({
      source: BRIDGE_SOURCE,
      type: 'hard-memory-archive-ack',
      requestId: message.requestId,
      ok: false
    }, location.origin);
  });
}, { passive: true });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (['networkDiscoveryEnabled', 'hardMemoryEnabled', 'hardMemoryRetainedTurns', 'hardMemoryPayloadPath']
    .some((key) => key in changes)) sendConfiguration();
});

sendConfiguration();
