#!/usr/bin/env node

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222';
const match = process.argv[3] ?? '';

function waitForSocket(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DevTools WebSocket connection timed out.')), 10000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Could not connect to the DevTools WebSocket.'));
    }, { once: true });
  });
}

async function main() {
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/list`);
  if (!response.ok) throw new Error(`DevTools target list returned HTTP ${response.status}.`);
  const targets = await response.json();
  const target = targets.find((item) => item.type === 'page'
    && /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(item.url)
    && (!match || item.url.includes(match)));
  if (!target) throw new Error(`No matching ChatGPT page is available at ${endpoint}.`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await waitForSocket(socket);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timeout);
    if (message.error) entry.reject(new Error(message.error.message ?? 'DevTools command failed.'));
    else entry.resolve(message.result);
  });

  const send = (method) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} did not respond within 10 seconds.`));
    }, 10000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method }));
  });

  try {
    await send('Runtime.enable');
    const [heap, dom] = await Promise.all([
      send('Runtime.getHeapUsage'),
      send('Memory.getDOMCounters')
    ]);
    process.stdout.write(`${JSON.stringify({
      url: target.url.replace(/\/c\/[^/?#]+/, '/c/{id}').split(/[?#]/, 1)[0],
      jsHeapUsedBytes: heap.usedSize,
      jsHeapTotalBytes: heap.totalSize,
      embedderHeapUsedBytes: heap.embedderHeapUsedSize,
      backingStorageBytes: heap.backingStorageSize,
      documents: dom.documents,
      domNodes: dom.nodes,
      jsEventListeners: dom.jsEventListeners
    }, null, 2)}\n`);
  } finally {
    socket.close();
  }
}

main().catch((error) => {
  process.stderr.write(`FATAL: ${error instanceof Error ? error.message : 'Memory measurement failed.'}\n`);
  process.exitCode = 1;
});
