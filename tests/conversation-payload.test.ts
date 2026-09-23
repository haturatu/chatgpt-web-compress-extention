import { describe, expect, it } from 'vitest';
import { trimRecognizedConversationPayload } from '../src/shared/conversation-payload';

function message(id: string, role: string, text: string) {
  return { id, author: { role }, content: { parts: [text] } };
}

describe('conversation payload guard', () => {
  it('archives the full active history and trims only before the current node', () => {
    const input = {
      title: 'Private title',
      messages: [
        message('system-1', 'system', 'system prompt'),
        message('user-1', 'user', 'first question'),
        message('assistant-1', 'assistant', 'first answer'),
        message('user-2', 'user', 'second question'),
        message('assistant-2', 'assistant', 'second answer'),
        message('user-3', 'user', 'current question'),
        message('assistant-3', 'assistant', 'current answer'),
        message('branch', 'assistant', 'inactive branch')
      ],
      current_node: 'assistant-3'
    };

    const result = trimRecognizedConversationPayload(input, 2);
    expect(result?.turns.map((turn) => turn.text)).toEqual([
      'first question', 'first answer', 'second question', 'second answer', 'current question', 'current answer'
    ]);
    expect(result?.payload.messages.map((item) => item.id)).toEqual([
      'system-1', 'user-2', 'assistant-2', 'user-3', 'assistant-3'
    ]);
    expect(result?.payload.current_node).toBe('assistant-3');
    expect(input.messages).toHaveLength(8);
  });

  it('passes through unknown schemas and conversations without an older range', () => {
    expect(trimRecognizedConversationPayload({ messages: [{ text: 'unknown' }] }, 20)).toBeNull();
    expect(trimRecognizedConversationPayload({
      messages: [message('user', 'user', 'question'), message('assistant', 'assistant', 'answer')],
      current_node: 'assistant'
    }, 20)).toBeNull();
  });
});
