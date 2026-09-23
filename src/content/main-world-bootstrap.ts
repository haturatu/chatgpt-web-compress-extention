import { trimRecognizedConversationPayload } from '../shared/conversation-payload';
import type { ConversationTrimResult } from '../shared/conversation-payload';
import type { ArchiveSnapshot } from '../shared/types';

interface MainWorldConfig {
  networkDiscoveryEnabled: boolean;
  hardMemoryEnabled: boolean;
  hardMemoryRetainedTurns: number;
  hardMemoryPayloadPath: string;
}

const BRIDGE_SOURCE = 'thread-optimizer-extension-bridge';
const defaults: MainWorldConfig = {
  networkDiscoveryEnabled: false,
  hardMemoryEnabled: false,
  hardMemoryRetainedTurns: 80,
  hardMemoryPayloadPath: ''
};
let config = defaults;
let wrapped = false;
let resolveConfigurationReady: (() => void) | null = null;
const configurationReady = new Promise<void>((resolve) => {
  resolveConfigurationReady = resolve;
});
const configurationFallback = window.setTimeout(() => resolveConfigurationReady?.(), 1000);

function normalizePath(value: string): string {
  return value.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f]{24,}/gi, '{id}');
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    const value = input instanceof Request ? input.url : String(input);
    return new URL(value, location.href);
  } catch {
    return null;
  }
}

function discoveryRecord(input: RequestInfo | URL, init: RequestInit | undefined, response: Response): void {
  if (!config.networkDiscoveryEnabled) return;
  const url = requestUrl(input);
  if (!url || url.origin !== location.origin) return;
  const contentType = response.headers.get('content-type') ?? '';
  if (!/application\/(?:json|[^;]+\+json)|text\/event-stream/i.test(contentType)) return;
  const contentLength = Number(response.headers.get('content-length'));
  const getSize = (): number => {
    const entry = performance.getEntriesByName(response.url || url.href).at(-1) as PerformanceResourceTiming | undefined;
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : Math.max(0, entry?.encodedBodySize ?? 0);
  };
  queueMicrotask(() => {
    const pathname = normalizePath(url.pathname);
    if (!pathname.startsWith('/')) return;
    window.postMessage({
      source: BRIDGE_SOURCE,
      type: 'network-record',
      record: {
        path: pathname,
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        contentType: contentType.split(';', 1)[0]!.trim(),
        status: response.status,
        encodedBytes: getSize(),
        streamed: /text\/event-stream/i.test(contentType)
      }
    }, location.origin);
  });
}

function saveSnapshotBeforeTrim(snapshot: ConversationTrimResult): Promise<boolean> {
  const conversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1];
  if (!conversationId) return Promise.resolve(false);
  const requestId = crypto.randomUUID();
  const request: ArchiveSnapshot = {
    sourceUrl: location.href,
    title: snapshot.payload.title || document.title || 'ChatGPT conversation',
    conversationId,
    turns: snapshot.turns
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onAck);
      clearTimeout(timeout);
      resolve(ok);
    };
    const onAck = (event: MessageEvent): void => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { source?: string; type?: string; requestId?: string; ok?: boolean };
      if (data?.source !== BRIDGE_SOURCE || data.type !== 'hard-memory-archive-ack' || data.requestId !== requestId) return;
      finish(Boolean(data.ok));
    };
    const timeout = window.setTimeout(() => finish(false), 15_000);
    window.addEventListener('message', onAck);
    window.postMessage({
      source: BRIDGE_SOURCE,
      type: 'hard-memory-archive',
      requestId,
      snapshot: request
    }, location.origin);
  });
}

function makeTrimmedResponse(response: Response, payload: Record<string, unknown>): Response | null {
  const headers = new Headers(response.headers);
  for (const header of ['content-encoding', 'content-length', 'content-md5', 'content-range', 'etag', 'transfer-encoding']) {
    headers.delete(header);
  }
  try {
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch {
    return null;
  }
}

async function interceptResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response
): Promise<Response> {
  discoveryRecord(input, init, response);
  if (!config.hardMemoryEnabled || !config.hardMemoryPayloadPath || !response.ok) return response;
  const url = requestUrl(input);
  if (!url || url.origin !== location.origin || normalizePath(url.pathname) !== config.hardMemoryPayloadPath) return response;
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return response;
  try {
    const payload = await response.clone().json() as unknown;
    const snapshot = trimRecognizedConversationPayload(payload, config.hardMemoryRetainedTurns);
    if (!snapshot) return response;
    const archived = await saveSnapshotBeforeTrim(snapshot);
    if (!archived) return response;
    const transformed = makeTrimmedResponse(response, snapshot.payload);
    return transformed ?? response;
  } catch {
    return response;
  }
}

function installFetchWrapper(): void {
  if (wrapped) return;
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;
  wrapped = true;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return Reflect.apply(nativeFetch, this, [input, init]).then((response: Response) =>
      configurationReady.then(() => interceptResponse(input, init, response)));
  };
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as { source?: string; type?: string; config?: Partial<MainWorldConfig> };
  if (data?.source !== BRIDGE_SOURCE || data.type !== 'configuration' || !data.config) return;
  config = {
    networkDiscoveryEnabled: Boolean(data.config.networkDiscoveryEnabled),
    hardMemoryEnabled: Boolean(data.config.hardMemoryEnabled),
    hardMemoryRetainedTurns: Number.isFinite(data.config.hardMemoryRetainedTurns)
      ? Math.max(20, Math.min(240, Math.round(Number(data.config.hardMemoryRetainedTurns))))
      : defaults.hardMemoryRetainedTurns,
    hardMemoryPayloadPath: typeof data.config.hardMemoryPayloadPath === 'string'
      ? data.config.hardMemoryPayloadPath
      : ''
  };
  window.clearTimeout(configurationFallback);
  resolveConfigurationReady?.();
});

// This script is registered only while an opt-in network feature is enabled.
// Wrap fetch synchronously so the first conversation response cannot beat storage setup.
installFetchWrapper();
