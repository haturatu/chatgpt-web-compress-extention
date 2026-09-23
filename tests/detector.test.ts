import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectTurns,
  findConversationRoot,
  hasDiscoverableConversationMutation,
  isConversationTurn
} from '../src/content/detector';
import { createConversationFixture } from './fixtures/conversation';

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 640, height: 80, top: 0, bottom: 80, left: 0, right: 640 })
  });
});

describe('conversation detector', () => {
  it('detects marked turns and the shared conversation root', () => {
    const conversation = createConversationFixture(document, 3);
    expect(detectTurns(conversation)).toHaveLength(3);
    const root = findConversationRoot(document);
    expect(root?.tagName).toBe('MAIN');
    expect(root?.contains(conversation)).toBe(true);
  });

  it('falls back to message-role heuristics for article-less markup', () => {
    const main = document.createElement('main');
    const conversation = document.createElement('div');
    const turn = document.createElement('div');
    turn.innerHTML = '<div data-message-author-role="user">Hello</div>';
    conversation.append(turn);
    main.append(conversation);
    document.body.append(main);

    expect(detectTurns(conversation)).toEqual([turn]);
    expect(isConversationTurn(turn)).toBe(true);
  });

  it('does not accept unrelated articles outside main', () => {
    const article = document.createElement('article');
    article.dataset.testid = 'conversation-turn-nope';
    document.body.append(article);
    expect(isConversationTurn(article)).toBe(false);
    expect(detectTurns(document)).toEqual([]);
  });

  it('retries root discovery when ChatGPT marks an existing node as a conversation turn', () => {
    const main = document.createElement('main');
    const turn = document.createElement('div');
    main.append(turn);
    document.body.append(main);

    const record = {
      type: 'attributes',
      target: turn,
      addedNodes: document.createDocumentFragment().childNodes
    } as unknown as MutationRecord;

    expect(hasDiscoverableConversationMutation([record])).toBe(false);
    turn.dataset.testid = 'conversation-turn-1';
    expect(hasDiscoverableConversationMutation([record])).toBe(true);
    expect(findConversationRoot(document)).toBe(main);
  });
});
