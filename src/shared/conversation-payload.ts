import type { ArchivedMedia, ArchivedTurn } from './types';

interface PayloadMessage {
  id: string;
  author: { role: string };
  content: { parts: unknown[] };
  create_time?: number | null;
}

interface ConversationPayload {
  messages: PayloadMessage[];
  current_node: string;
  title?: string;
  [key: string]: unknown;
}

export interface ConversationTrimResult {
  payload: ConversationPayload;
  turns: ArchivedTurn[];
}

function textFromParts(parts: readonly unknown[]): string {
  return parts.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      return [(part as { text: string }).text];
    }
    return [];
  }).join('\n').trim();
}

function collectMedia(parts: readonly unknown[]): ArchivedMedia[] {
  const media: ArchivedMedia[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const image = record.image_url;
    const directUrl = typeof record.url === 'string' ? record.url : null;
    const imageUrl = typeof image === 'string'
      ? image
      : image && typeof image === 'object' && typeof (image as { url?: unknown }).url === 'string'
        ? (image as { url: string }).url
        : null;
    const source = imageUrl ?? (record.type === 'image' ? directUrl : null);
    if (source && /^https?:\/\//i.test(source)) {
      media.push({
        kind: 'image',
        source,
        alt: typeof record.alt_text === 'string' ? record.alt_text : 'Image attachment',
        ...(typeof record.width === 'number' ? { width: record.width } : {}),
        ...(typeof record.height === 'number' ? { height: record.height } : {})
      });
      return;
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  for (const part of parts) visit(part, 0);
  return media;
}

function asPayload(value: unknown): ConversationPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<ConversationPayload>;
  if (!Array.isArray(payload.messages) || typeof payload.current_node !== 'string' || payload.messages.length < 2) {
    return null;
  }
  if (!payload.messages.every((message) => message && typeof message.id === 'string'
    && message.author && typeof message.author.role === 'string'
    && message.content && Array.isArray(message.content.parts))) return null;
  if (!payload.messages.some((message) => message.id === payload.current_node)) return null;
  return payload as ConversationPayload;
}

export function trimRecognizedConversationPayload(value: unknown, retainedUserTurns: number): ConversationTrimResult | null {
  const payload = asPayload(value);
  if (!payload) return null;
  const currentIndex = payload.messages.findIndex((message) => message.id === payload.current_node);
  if (currentIndex < 0) return null;

  let userTurns = 0;
  let firstRetained = currentIndex;
  for (let index = currentIndex; index >= 0; index -= 1) {
    if (payload.messages[index]!.author.role === 'user') userTurns += 1;
    if (userTurns >= retainedUserTurns && payload.messages[index]!.author.role === 'user') {
      firstRetained = index;
      break;
    }
    firstRetained = index;
  }
  if (firstRetained <= 0) return null;

  const activeMessages = payload.messages.slice(0, currentIndex + 1);
  const turns = activeMessages.flatMap((message, index): ArchivedTurn[] => {
    const role = message.author.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const text = textFromParts(message.content.parts);
    const media = collectMedia(message.content.parts);
    if (!text && media.length === 0) return [];
    return [{ index, role, text, height: 420, media }];
  });
  const keptMessages = payload.messages.slice(firstRetained, currentIndex + 1);
  if (turns.length < 2 || !keptMessages.some((message) => message.id === payload.current_node)) return null;

  return {
    turns,
    payload: {
      ...payload,
      messages: [
        ...payload.messages.slice(0, firstRetained).filter((message) => message.author.role === 'system'),
        ...keptMessages
      ]
    }
  };
}
