import { readArchiveChunk, readArchiveManifest } from '../shared/archive';
import { t, uiLocale } from '../shared/i18n';
import type { ArchiveManifest, ArchivedMedia, ArchivedTurn } from '../shared/types';

const WINDOW_SIZE = 40;
const BUFFER_BEFORE = 6;
const CACHE_LIMIT = 4;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(t('readerInterfaceMissing', id));
  return element as T;
};

const params = new URL(location.href).searchParams;
const archiveId = params.get('archive') ?? '';
let manifest: ArchiveManifest | null = null;
let prefixHeights: number[] = [];
let renderSequence = 0;
let measureObserver: ResizeObserver | null = null;
let searchStatus: string | null = null;
let chunkStarts: number[] = [];
const chunkCache = new Map<number, ArchivedTurn[]>();

function setStatus(message: string): void {
  $('reader-status').textContent = message;
}

function firstIndexAtOffset(offset: number): number {
  let low = 0;
  let high = prefixHeights.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (prefixHeights[middle + 1]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, (manifest?.turnCount ?? 1) - 1));
}

function rebuildPrefixHeights(): void {
  if (!manifest) return;
  prefixHeights = [0];
  for (let index = 0; index < manifest.turnCount; index += 1) {
    prefixHeights.push(prefixHeights[index]! + Math.max(80, manifest.heights[index] ?? 420));
  }
}

function observeRenderedCards(): void {
  measureObserver?.disconnect();
  if (typeof ResizeObserver === 'undefined' || !manifest) return;
  measureObserver = new ResizeObserver((entries) => {
    if (!manifest) return;
    const scroller = $('conversation-scroll');
    const anchor = firstIndexAtOffset(scroller.scrollTop);
    const offset = scroller.scrollTop - (prefixHeights[anchor] ?? 0);
    let changed = false;
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement) || !entry.target.isConnected) continue;
      const index = Number(entry.target.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= manifest.heights.length) continue;
      const height = Math.max(80, Math.ceil(entry.contentRect.height));
      if (Math.abs((manifest.heights[index] ?? 420) - height) <= 1) continue;
      manifest.heights[index] = height;
      changed = true;
    }
    if (!changed) return;
    rebuildPrefixHeights();
    scroller.scrollTop = (prefixHeights[anchor] ?? 0) + offset;
    requestAnimationFrame(() => void renderWindow());
  });
  for (const card of $('turn-window').querySelectorAll<HTMLElement>('.turn-card')) measureObserver.observe(card);
}

function chunkIndexForTurn(index: number): number {
  let low = 0;
  let high = chunkStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (chunkStarts[middle]! <= index) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

async function getChunk(index: number): Promise<ArchivedTurn[]> {
  const cached = chunkCache.get(index);
  if (cached) {
    chunkCache.delete(index);
    chunkCache.set(index, cached);
    return cached;
  }
  if (!manifest) throw new Error(t('noArchiveOpen'));
  const chunk = await readArchiveChunk(manifest, index);
  chunkCache.set(index, chunk);
  while (chunkCache.size > CACHE_LIMIT) chunkCache.delete(chunkCache.keys().next().value as number);
  return chunk;
}

function renderMedia(container: HTMLElement, media: ArchivedMedia): void {
  const card = document.createElement('div');
  card.className = 'media-placeholder';
  const label = document.createElement('span');
  const mediaKind = media.kind === 'image' ? t('image') : media.kind === 'video' ? t('video') : t('audio');
  label.textContent = media.alt || t('mediaAttachment', mediaKind);
  const load = document.createElement('button');
  load.type = 'button';
  load.textContent = media.kind === 'image' ? t('loadImage') : t('openMedia', mediaKind);
  load.setAttribute('aria-label', t('mediaActionAria', load.textContent, media.alt || t('archivedAttachment')));
  if (media.kind === 'image') {
    load.addEventListener('click', () => {
      const image = document.createElement('img');
      image.alt = media.alt || t('archivedImage');
      image.loading = 'lazy';
      if (media.width) image.width = media.width;
      if (media.height) image.height = media.height;
      image.src = media.source;
      card.replaceChildren(label, image, openSource(media));
    }, { once: true });
    card.append(label, load);
  } else {
    card.append(label, openSource(media));
  }
  container.append(card);
}

function openSource(media: ArchivedMedia): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = media.source;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = t('openOriginalMedia');
  return link;
}

function createTurnCard(turn: ArchivedTurn, index: number): HTMLElement {
  const article = document.createElement('article');
  article.className = 'turn-card';
  article.dataset.index = String(index);
  const heading = document.createElement('header');
  heading.className = 'turn-heading';
  const role = document.createElement('span');
  role.className = 'turn-role';
  role.textContent = turn.role === 'user'
    ? t('roleUser')
    : turn.role === 'assistant'
      ? t('roleAssistant')
      : turn.role || t('roleMessage');
  const number = document.createElement('span');
  number.textContent = t('messageNumber', String(index + 1));
  heading.append(role, number);
  article.append(heading);
  if (turn.text) {
    const text = document.createElement('pre');
    text.className = 'turn-text';
    text.textContent = turn.text;
    article.append(text);
  }
  if (turn.media?.length) {
    const media = document.createElement('div');
    media.className = 'media-list';
    for (const item of turn.media) renderMedia(media, item);
    article.append(media);
  }
  return article;
}

async function renderWindow(): Promise<void> {
  if (!manifest) return;
  const sequence = ++renderSequence;
  const scroller = $('conversation-scroll');
  const firstVisible = firstIndexAtOffset(scroller.scrollTop);
  const start = Math.max(0, firstVisible - BUFFER_BEFORE);
  const end = Math.min(manifest.turnCount, start + WINDOW_SIZE);
  const required = new Set<number>();
  for (let index = start; index < end; index += 1) required.add(chunkIndexForTurn(index));
  try {
    const entries = await Promise.all([...required].map(async (index) => [index, await getChunk(index)] as const));
    if (sequence !== renderSequence) return;
    const chunks = new Map(entries);
    const rendered: HTMLElement[] = [];
    for (let index = start; index < end; index += 1) {
      const chunk = chunks.get(chunkIndexForTurn(index));
      const chunkIndex = chunkIndexForTurn(index);
      const turn = chunk?.[index - (chunkStarts[chunkIndex] ?? 0)];
      if (turn) rendered.push(createTurnCard(turn, index));
    }
    $('top-spacer').style.height = `${prefixHeights[start] ?? 0}px`;
    $('bottom-spacer').style.height = `${Math.max(0, prefixHeights[manifest.turnCount]! - (prefixHeights[end] ?? 0))}px`;
    $('turn-window').replaceChildren(...rendered);
    observeRenderedCards();
    setStatus(searchStatus ?? t('readerShowing', String(start + 1), String(Math.max(start, end)), String(manifest.turnCount), String(WINDOW_SIZE)));
  } catch {
    setStatus(t('readerSectionReadError'));
  }
}

async function findInArchive(query: string): Promise<void> {
  if (!manifest) return;
  const needle = query.trim().toLocaleLowerCase(uiLocale());
  if (!needle) {
    searchStatus = null;
    setStatus(t('archiveContainsMessages', String(manifest.turnCount)));
    return;
  }
  searchStatus = t('searchingArchive');
  setStatus(searchStatus);
  const matches: number[] = [];
  try {
    for (let chunkIndex = 0; chunkIndex < manifest.chunks.length; chunkIndex += 1) {
      const turns = await readArchiveChunk(manifest, chunkIndex);
      const offset = chunkStarts[chunkIndex] ?? 0;
      turns.forEach((turn, index) => {
        if (turn.text.toLocaleLowerCase(uiLocale()).includes(needle)) matches.push(offset + index);
      });
      if (chunkCache.size > CACHE_LIMIT) chunkCache.delete(chunkCache.keys().next().value as number);
    }
    if (matches.length === 0) {
      searchStatus = t('searchNoMatches');
      setStatus(searchStatus);
      return;
    }
    const target = matches[0]!;
    $('conversation-scroll').scrollTop = prefixHeights[target] ?? 0;
    await renderWindow();
    searchStatus = t('searchFirstMatch', String(matches.length));
    setStatus(searchStatus);
  } catch {
    searchStatus = t('searchReadError');
    setStatus(searchStatus);
  }
}

async function resumeInChatGPT(): Promise<void> {
  if (!manifest) return;
  setStatus(t('returningToChatGPT'));
  const result = await chrome.runtime.sendMessage({ type: 'archive:resume', archiveId: manifest.id })
    .catch(() => null) as { ok?: boolean; error?: string } | null;
  setStatus(result?.ok ? t('chatGPTOpenedOriginalTab') : result?.error ?? t('couldNotReopenChatGPT'));
}

async function removeArchive(): Promise<void> {
  if (!manifest) return;
  const result = await chrome.runtime.sendMessage({ type: 'archive:delete-and-resume', archiveId: manifest.id })
    .catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!result?.ok) {
    setStatus(result?.error ?? t('archiveCouldNotBeDeleted'));
    return;
  }
  setStatus(t('archiveDeletedReturning'));
  window.setTimeout(() => window.close(), 400);
}

async function init(): Promise<void> {
  if (!archiveId) throw new Error(t('missingArchiveIdentifier'));
  manifest = await readArchiveManifest(archiveId) ?? null;
  if (!manifest) throw new Error(t('errorArchiveUnavailable'));
  document.title = `${manifest.title} · ${t('liteReader')}`;
  $('archive-title').textContent = manifest.title;
  $('archive-detail').textContent = t('messageCountAndSavedAt', String(manifest.turnCount), new Date(manifest.createdAt).toLocaleString(uiLocale()));
  chunkStarts = [];
  let chunkOffset = 0;
  for (const chunk of manifest.chunks) {
    chunkStarts.push(chunkOffset);
    chunkOffset += chunk.count;
  }
  if (chunkOffset !== manifest.turnCount) throw new Error(t('archiveIndexMismatch'));
  rebuildPrefixHeights();
  $('conversation-scroll').addEventListener('scroll', () => void renderWindow(), { passive: true });
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void findInArchive(($('archive-search') as HTMLInputElement).value);
  });
  $('resume').addEventListener('click', () => void resumeInChatGPT());
  $('delete').addEventListener('click', () => ($('delete-confirm') as HTMLDialogElement).showModal());
  $('confirm-delete').addEventListener('click', (event) => {
    event.preventDefault();
    ($('delete-confirm') as HTMLDialogElement).close();
    void removeArchive();
  });
  await renderWindow();
}

void init().catch((error: unknown) => setStatus(error instanceof Error ? error.message : t('couldNotOpenThisArchive')));
