import type { ArchiveChunkDescriptor, ArchiveManifest, ArchiveSnapshot, ArchivedTurn } from './types';

const DATABASE_NAME = 'chatgpt-thread-archives';
const DATABASE_VERSION = 1;
const MANIFEST_STORE = 'manifests';
const CHUNK_STORE = 'chunks';
const OPFS_DIRECTORY = 'chatgpt-thread-archives';
const CHUNK_SIZE = 25;

interface StoredChunk {
  key: string;
  bytes: ArrayBuffer;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
        database.createObjectStore(MANIFEST_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        database.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local archive storage.'));
  });
}

async function putManifest(manifest: ArchiveManifest): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MANIFEST_STORE, 'readwrite');
    transaction.objectStore(MANIFEST_STORE).put(manifest);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save archive details.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Archive details save was aborted.'));
  });
  database.close();
}

async function putChunk(key: string, bytes: ArrayBuffer): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, 'readwrite');
    transaction.objectStore(CHUNK_STORE).put({ key, bytes } satisfies StoredChunk);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save an archive section.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Archive section save was aborted.'));
  });
  database.close();
}

async function getChunk(key: string): Promise<ArrayBuffer | undefined> {
  const database = await openDatabase();
  const result = await new Promise<StoredChunk | undefined>((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, 'readonly');
    const request = transaction.objectStore(CHUNK_STORE).get(key) as IDBRequest<StoredChunk | undefined>;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read an archive section.'));
  });
  database.close();
  return result?.bytes;
}

async function deleteChunkRecords(archiveId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, 'readwrite');
    const store = transaction.objectStore(CHUNK_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && cursor.key.startsWith(`${archiveId}:`)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete archive data.'));
  });
  database.close();
}

function getOpfsDirectory(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof storage.getDirectory !== 'function') {
    return Promise.reject(new Error('Origin-private file storage is unavailable.'));
  }
  return storage.getDirectory();
}

async function writeCompressedChunk(
  archiveId: string,
  index: number,
  turns: readonly ArchivedTurn[]
): Promise<ArchiveChunkDescriptor> {
  const raw = new Blob([JSON.stringify(turns)], { type: 'application/json' });
  const key = `${archiveId}:${index}`;
  const fileName = `${index}.json.gz`;

  try {
    const root = await getOpfsDirectory();
    const archives = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
    const folder = await archives.getDirectoryHandle(archiveId, { create: true });
    const file = await folder.getFileHandle(fileName, { create: true });
    const stream = raw.stream().pipeThrough(new CompressionStream('gzip'));
    await stream.pipeTo(await file.createWritable());
    return {
      index,
      count: turns.length,
      storage: 'opfs',
      fileName: `${archiveId}/${fileName}`,
      compressedBytes: (await file.getFile()).size
    };
  } catch {
    try {
      const root = await getOpfsDirectory();
      const archives = await root.getDirectoryHandle(OPFS_DIRECTORY);
      const folder = await archives.getDirectoryHandle(archiveId);
      await folder.removeEntry(fileName);
    } catch {
      // The OPFS file may not have been created.
    }
    const compressed = await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    await putChunk(key, compressed);
    return { index, count: turns.length, storage: 'indexeddb', compressedBytes: compressed.byteLength };
  }
}

export async function saveArchive(
  snapshot: ArchiveSnapshot,
  sourceTabId: number | null,
  kind: ArchiveManifest['kind'] = 'dom-snapshot'
): Promise<ArchiveManifest> {
  if (!snapshot.turns.length) throw new Error('This conversation does not contain any turns to save.');
  if (snapshot.turns.length > 20_000) throw new Error('This archive is too large to save in one operation.');

  const id = crypto.randomUUID();
  const chunks: ArchiveChunkDescriptor[] = [];
  try {
    for (let start = 0, index = 0; start < snapshot.turns.length; start += CHUNK_SIZE, index += 1) {
      chunks.push(await writeCompressedChunk(id, index, snapshot.turns.slice(start, start + CHUNK_SIZE)));
    }
    const manifest: ArchiveManifest = {
      id,
      title: snapshot.title.slice(0, 240) || 'ChatGPT conversation',
      conversationId: snapshot.conversationId,
      sourceUrl: snapshot.sourceUrl,
      sourceTabId,
      createdAt: Date.now(),
      turnCount: snapshot.turns.length,
      heights: snapshot.turns.map((turn) => Math.max(1, Math.ceil(turn.height || 420))),
      chunks,
      kind
    };
    await putManifest(manifest);
    return manifest;
  } catch (error) {
    await removeArchiveFiles(id, chunks).catch(() => undefined);
    await deleteChunkRecords(id).catch(() => undefined);
    throw error;
  }
}

export async function readArchiveManifest(id: string): Promise<ArchiveManifest | undefined> {
  const database = await openDatabase();
  const manifest = await new Promise<ArchiveManifest | undefined>((resolve, reject) => {
    const transaction = database.transaction(MANIFEST_STORE, 'readonly');
    const request = transaction.objectStore(MANIFEST_STORE).get(id) as IDBRequest<ArchiveManifest | undefined>;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read the archive.'));
  });
  database.close();
  return manifest;
}

export async function updateArchiveSourceTabId(id: string, sourceTabId: number): Promise<void> {
  const manifest = await readArchiveManifest(id);
  if (!manifest) throw new Error('This archive is no longer available.');
  manifest.sourceTabId = sourceTabId;
  await putManifest(manifest);
}

export async function listArchives(): Promise<ArchiveManifest[]> {
  const database = await openDatabase();
  const manifests = await new Promise<ArchiveManifest[]>((resolve, reject) => {
    const transaction = database.transaction(MANIFEST_STORE, 'readonly');
    const request = transaction.objectStore(MANIFEST_STORE).getAll() as IDBRequest<ArchiveManifest[]>;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not list saved archives.'));
  });
  database.close();
  return manifests.sort((left, right) => right.createdAt - left.createdAt);
}

export async function readArchiveChunk(manifest: ArchiveManifest, index: number): Promise<ArchivedTurn[]> {
  const descriptor = manifest.chunks[index];
  if (!descriptor) throw new Error('The requested archive section does not exist.');
  let compressed: Blob | ArrayBuffer;
  if (descriptor.storage === 'opfs' && descriptor.fileName) {
    const root = await getOpfsDirectory();
    const archives = await root.getDirectoryHandle(OPFS_DIRECTORY);
    const [archiveId, fileName] = descriptor.fileName.split('/');
    if (!archiveId || !fileName) throw new Error('The archive section path is invalid.');
    const folder = await archives.getDirectoryHandle(archiveId);
    compressed = await (await folder.getFileHandle(fileName)).getFile();
  } else {
    const bytes = await getChunk(`${manifest.id}:${index}`);
    if (!bytes) throw new Error('The saved archive section is missing.');
    compressed = bytes;
  }
  const stream = compressed instanceof Blob ? compressed.stream() : new Blob([compressed]).stream();
  const json = await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).text();
  const turns = JSON.parse(json) as ArchivedTurn[];
  if (!Array.isArray(turns)) throw new Error('The saved archive section has an invalid format.');
  return turns;
}

async function removeArchiveFiles(id: string, _chunks: readonly ArchiveChunkDescriptor[]): Promise<void> {
  try {
    const root = await getOpfsDirectory();
    const archives = await root.getDirectoryHandle(OPFS_DIRECTORY);
    await archives.removeEntry(id, { recursive: true });
  } catch {
    // Continue deleting IndexedDB data when OPFS is unavailable or already empty.
  }
}

export async function deleteArchive(id: string): Promise<void> {
  const manifest = await readArchiveManifest(id);
  if (manifest) await removeArchiveFiles(id, manifest.chunks);
  await deleteChunkRecords(id);
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MANIFEST_STORE, 'readwrite');
    transaction.objectStore(MANIFEST_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete archive details.'));
  });
  database.close();
}
