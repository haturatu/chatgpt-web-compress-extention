import { deleteArchive, listArchives, readArchiveManifest, saveArchive, updateArchiveSourceTabId } from '../shared/archive';
import { loadConfig } from '../shared/config';
import type { ArchiveSnapshot, NetworkDiscoveryRecord } from '../shared/types';
import { logger } from '../shared/logger';

const MAIN_SCRIPT_ID = 'thread-optimizer-main-world';
const MATCHES = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const DISCOVERY_STORAGE_KEY = 'networkDiscoveryRecords';
let discoveryQueue: Promise<void> = Promise.resolve();
let mainScriptSync: Promise<void> | null = null;
let mainScriptSyncAgain = false;

interface BackgroundRequest {
  type?: string;
  archiveId?: string;
  snapshot?: ArchiveSnapshot;
  sourceTabId?: number;
  sourceUrl?: string;
  record?: Partial<NetworkDiscoveryRecord>;
}

function isChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com')
      && /^\/c\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function isArchiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
}

function normalizeDiscoveredPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 256) return '';
  if (value.includes('?') || value.includes('#')) return '';
  return value.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f]{24,}/gi, '{id}');
}

async function updateMainWorldScript(): Promise<void> {
  const config = await loadConfig();
  const enabled = config.networkDiscoveryEnabled || config.hardMemoryEnabled;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [MAIN_SCRIPT_ID] });
  } catch {
    // It is expected that there is no registered script on first install.
  }
  if (!enabled) return;
  await chrome.scripting.registerContentScripts([{
    id: MAIN_SCRIPT_ID,
    matches: MATCHES,
    js: ['main-world-bootstrap.js'],
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true
  }]);
}

function syncMainWorldScript(): Promise<void> {
  if (mainScriptSync) {
    mainScriptSyncAgain = true;
    return mainScriptSync;
  }
  mainScriptSync = (async () => {
    do {
      mainScriptSyncAgain = false;
      await updateMainWorldScript();
    } while (mainScriptSyncAgain);
  })().finally(() => {
    mainScriptSync = null;
  });
  return mainScriptSync;
}

async function writeNetworkMetadata(record: Partial<NetworkDiscoveryRecord>): Promise<void> {
  const path = normalizeDiscoveredPath(record.path);
  if (!path) return;
  const method = typeof record.method === 'string' ? record.method.slice(0, 12).toUpperCase() : 'GET';
  const contentType = typeof record.contentType === 'string' ? record.contentType.slice(0, 80) : '';
  const key = `${method} ${path} ${contentType}`;
  const stored = await chrome.storage.local.get(DISCOVERY_STORAGE_KEY);
  const records = Array.isArray(stored[DISCOVERY_STORAGE_KEY])
    ? stored[DISCOVERY_STORAGE_KEY] as NetworkDiscoveryRecord[]
    : [];
  const next: NetworkDiscoveryRecord = {
    path,
    method,
    contentType,
    status: Number.isFinite(record.status) ? Math.max(0, Math.min(599, Number(record.status))) : 0,
    encodedBytes: Number.isFinite(record.encodedBytes) ? Math.max(0, Number(record.encodedBytes)) : 0,
    streamed: Boolean(record.streamed),
    seenAt: Date.now(),
    observations: 1
  };
  const previous = records.find((item) => `${item.method} ${item.path} ${item.contentType}` === key);
  const updated = [
    { ...next, observations: (previous?.observations ?? 0) + 1 },
    ...records.filter((item) => `${item.method} ${item.path} ${item.contentType}` !== key)
  ].slice(0, 60);
  await chrome.storage.local.set({ [DISCOVERY_STORAGE_KEY]: updated });
}

function recordNetworkMetadata(record: Partial<NetworkDiscoveryRecord>): Promise<void> {
  discoveryQueue = discoveryQueue.then(() => writeNetworkMetadata(record)).catch((error: unknown) => {
    logger.warn('network discovery record could not be saved', error);
  });
  return discoveryQueue;
}

async function saveSnapshot(snapshot: ArchiveSnapshot, sourceTabId: number | null, kind: 'dom-snapshot' | 'hard-memory') {
  if (!snapshot || !Array.isArray(snapshot.turns) || !isChatGptUrl(snapshot.sourceUrl)) {
    throw new Error('The conversation snapshot is invalid.');
  }
  if (snapshot.turns.some((turn) => typeof turn.text !== 'string' || !Array.isArray(turn.media))) {
    throw new Error('The conversation snapshot contains an unsupported turn.');
  }
  return saveArchive(snapshot, sourceTabId, kind);
}

async function openReader(archiveId: string): Promise<number> {
  if (!isArchiveId(archiveId)) throw new Error('The archive identifier is invalid.');
  const manifest = await readArchiveManifest(archiveId);
  if (!manifest) throw new Error('This local archive could not be found.');
  const url = chrome.runtime.getURL(`reader.html?archive=${encodeURIComponent(archiveId)}`);
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id === undefined) throw new Error('The Lite Reader tab could not be opened.');
  return tab.id;
}

async function discardSourceTab(tabId: number, expectedUrl: string): Promise<{ discarded: boolean; tabId: number }> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url !== expectedUrl || tab.active) return { discarded: false, tabId };
  const result = await chrome.tabs.discard(tabId);
  return { discarded: Boolean(result?.discarded), tabId: result?.id ?? tabId };
}

async function findSourceTab(sourceTabId: number | null, sourceUrl: string): Promise<chrome.tabs.Tab | null> {
  if (sourceTabId !== null) {
    try {
      const tab = await chrome.tabs.get(sourceTabId);
      if (tab.url === sourceUrl) return tab;
    } catch {
      // Try the saved URL when the browser replaced a discarded tab's internal ID.
    }
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url === sourceUrl && tab.discarded) ?? tabs.find((tab) => tab.url === sourceUrl) ?? null;
}

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  const run = async (): Promise<unknown> => {
    switch (request?.type) {
      case 'archive:create-dom': {
        if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Archive creation must come from the extension.');
        if (!request.snapshot || !Number.isInteger(request.sourceTabId)) throw new Error('The archive request is incomplete.');
        const sourceTabId = request.sourceTabId!;
        const source = await chrome.tabs.get(sourceTabId);
        if (!source.url || source.url !== request.sourceUrl || !isChatGptUrl(source.url)) {
          throw new Error('The source ChatGPT tab changed while the archive was being created.');
        }
        const manifest = await saveSnapshot(request.snapshot, sourceTabId, 'dom-snapshot');
        return { ok: true, manifest };
      }
      case 'archive:create-hard': {
        if (sender.tab?.id === undefined || !sender.url || !isChatGptUrl(sender.url) || !request.snapshot) {
          throw new Error('The hard-memory archive request is invalid.');
        }
        const manifest = await saveSnapshot(request.snapshot, sender.tab.id, 'hard-memory');
        return { ok: true, manifest };
      }
      case 'archive:list':
        return { ok: true, archives: await listArchives() };
      case 'archive:delete': {
        if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !isArchiveId(request.archiveId)) {
          throw new Error('Archive deletion must come from the extension.');
        }
        await deleteArchive(request.archiveId);
        return { ok: true };
      }
      case 'archive:open':
        if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !request.archiveId) {
          throw new Error('Reader access must come from the extension.');
        }
        return { ok: true, tabId: await openReader(request.archiveId) };
      case 'archive:open-and-discard': {
        if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !request.archiveId
          || !Number.isInteger(request.sourceTabId) || !request.sourceUrl || !isChatGptUrl(request.sourceUrl)) {
          throw new Error('The Reader handoff request is invalid.');
        }
        const manifest = await readArchiveManifest(request.archiveId);
        if (!manifest || manifest.sourceTabId !== request.sourceTabId || manifest.sourceUrl !== request.sourceUrl) {
          throw new Error('The archive does not match the selected ChatGPT tab.');
        }
        await openReader(request.archiveId);
        let discarded = false;
        let sourceTabId = request.sourceTabId!;
        try {
          const result = await discardSourceTab(request.sourceTabId, request.sourceUrl);
          discarded = result.discarded;
          sourceTabId = result.tabId;
          if (discarded && sourceTabId !== request.sourceTabId) {
            await updateArchiveSourceTabId(request.archiveId, sourceTabId);
          }
        } catch (error) {
          logger.warn('saved archive opened, but source tab could not be discarded', error);
        }
        return { ok: true, discarded, sourceTabId };
      }
      case 'archive:resume': {
        if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !request.archiveId) {
          throw new Error('Resume must come from the Lite Reader.');
        }
        const manifest = await readArchiveManifest(request.archiveId);
        if (!manifest || !isChatGptUrl(manifest.sourceUrl)) throw new Error('The source conversation could not be found.');
        const source = await findSourceTab(manifest.sourceTabId, manifest.sourceUrl);
        if (source?.id !== undefined) {
          if (manifest.sourceTabId !== source.id) await updateArchiveSourceTabId(manifest.id, source.id);
          await chrome.tabs.update(source.id, { active: true });
          return { ok: true, opened: true, sourceTabId: source.id };
        }
        await chrome.tabs.create({ url: manifest.sourceUrl, active: true });
        return { ok: true, opened: true };
      }
      case 'archive:delete-and-resume': {
        if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !isArchiveId(request.archiveId)) {
          throw new Error('Archive deletion must come from the Lite Reader.');
        }
        const manifest = await readArchiveManifest(request.archiveId);
        if (!manifest) throw new Error('This archive is no longer available.');
        await deleteArchive(manifest.id);
        const source = await findSourceTab(manifest.sourceTabId, manifest.sourceUrl);
        if (source?.id !== undefined) {
          await chrome.tabs.update(source.id, { active: true });
          return { ok: true, sourceTabId: source.id };
        }
        await chrome.tabs.create({ url: manifest.sourceUrl, active: true });
        return { ok: true };
      }
      case 'network:record':
        if (sender.tab?.id === undefined || !sender.url || !isChatGptUrl(sender.url)) {
          throw new Error('Network discovery must come from a ChatGPT content script.');
        }
        if (request.record) await recordNetworkMetadata(request.record);
        return { ok: true };
      case 'hard-memory:sync':
        if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Configuration must come from the extension.');
        await syncMainWorldScript();
        return { ok: true };
      default:
        return { ok: false, error: 'Unsupported background request.' };
    }
  };

  void run().then(sendResponse).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'The requested operation failed.';
    logger.warn('background operation did not complete', message);
    sendResponse({ ok: false, error: message });
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && ('networkDiscoveryEnabled' in changes || 'hardMemoryEnabled' in changes)) {
    void syncMainWorldScript().catch((error: unknown) => logger.error('main-world script update failed', error));
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void syncMainWorldScript().catch((error: unknown) => logger.error('main-world script setup failed', error));
});

chrome.runtime.onStartup.addListener(() => {
  void syncMainWorldScript().catch((error: unknown) => logger.error('main-world script setup failed', error));
});

void syncMainWorldScript().catch((error: unknown) => logger.error('main-world script setup failed', error));
