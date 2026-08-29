export function createConversationFixture(document: Document, count: number): HTMLElement {
  const main = document.createElement('main');
  const conversation = document.createElement('div');
  conversation.dataset.fixture = 'conversation';
  for (let index = 0; index < count; index += 1) {
    const turn = document.createElement('article');
    turn.dataset.testid = `conversation-turn-${index}`;
    turn.innerHTML = `<div data-message-author-role="${index % 2 === 0 ? 'user' : 'assistant'}"><p>Fixture turn ${index}</p></div>`;
    conversation.append(turn);
  }
  main.append(conversation);
  document.body.append(main);
  return conversation;
}
