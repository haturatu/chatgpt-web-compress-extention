import { beforeEach, describe, expect, it } from 'vitest';
import { detectTurns, findConversationRoot, isConversationTurn } from '../src/content/detector';
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
    expect(findConversationRoot(document)).toBe(conversation);
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
});
