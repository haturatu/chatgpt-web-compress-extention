import { describe, expect, it } from 'vitest';
import { detectTurns } from '../src/content/detector';
import { createConversationFixture } from './fixtures/conversation';

describe.each([300, 600, 1000])('conversation fixture (%d turns)', (count) => {
  it('detects every turn', () => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 640, height: 80, top: 0, bottom: 80, left: 0, right: 640 })
    });
    document.body.innerHTML = '';
    const root = createConversationFixture(document, count);
    const started = performance.now();
    const turns = detectTurns(root);
    const elapsed = performance.now() - started;
    expect(turns).toHaveLength(count);
    expect(elapsed).toBeLessThan(500);
  });
});
