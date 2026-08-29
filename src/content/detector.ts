import { MAIN_SELECTORS, STRONG_TURN_SELECTORS, TURN_SELECTORS } from './selectors';

const asElements = (nodes: NodeListOf<HTMLElement> | HTMLElement[]): HTMLElement[] =>
  Array.from(nodes);

const unique = (elements: HTMLElement[]): HTMLElement[] =>
  Array.from(new Set(elements));

export function isConversationTurn(element: HTMLElement): boolean {
  if (!element.isConnected || element.getBoundingClientRect().width === 0) return false;
  if (!element.closest('main, [role="main"]')) return false;

  const testId = element.dataset.testid ?? '';
  const hasConversationTestId = testId.startsWith('conversation-turn');
  const hasMessageRole = Boolean(element.querySelector('[data-message-author-role]'));
  return hasConversationTestId || hasMessageRole;
}

function collectCandidates(root: ParentNode, selector: string): HTMLElement[] {
  return asElements(root.querySelectorAll<HTMLElement>(selector)).filter(isConversationTurn);
}

function collectHeuristicCandidates(root: ParentNode): HTMLElement[] {
  const messages = asElements(root.querySelectorAll<HTMLElement>('[data-message-author-role]'));
  const candidates = messages.map((message) => {
    const markedParent = message.closest<HTMLElement>('[data-testid^="conversation-turn"]');
    if (markedParent) return markedParent;
    return message.closest<HTMLElement>('article') ?? message.parentElement;
  }).filter((element): element is HTMLElement => element !== null);
  return unique(candidates.filter(isConversationTurn));
}

export function detectTurns(root: ParentNode): HTMLElement[] {
  for (const selector of STRONG_TURN_SELECTORS) {
    const candidates = unique(collectCandidates(root, selector));
    if (candidates.length > 0) return candidates;
  }

  const articles = unique(collectCandidates(root, TURN_SELECTORS[2]));
  if (articles.length > 0) return articles;

  return collectHeuristicCandidates(root);
}

export function extractTurnsFromNode(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  const own = TURN_SELECTORS.some((selector) => node.matches(selector)) ? [node] : [];
  return unique([...own, ...detectTurns(node)]);
}

function commonAncestor(elements: HTMLElement[]): HTMLElement | null {
  const [first, ...rest] = elements;
  if (!first) return null;
  let ancestor: HTMLElement | null = first.parentElement;
  while (ancestor) {
    if (rest.every((element) => ancestor?.contains(element))) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return null;
}

export function isValidConversationRoot(root: HTMLElement): boolean {
  if (!root.isConnected || !root.closest('main, [role="main"]')) return false;
  if (root.matches('article, [data-testid^="conversation-turn"]')) return false;
  return detectTurns(root).length > 0;
}

export function findConversationRoot(documentRoot: Document | HTMLElement): HTMLElement | null {
  const mainCandidates = unique([
    ...asElements(documentRoot.querySelectorAll<HTMLElement>(MAIN_SELECTORS[0])),
    ...asElements(documentRoot.querySelectorAll<HTMLElement>(MAIN_SELECTORS[1]))
  ]);

  for (const main of mainCandidates) {
    const turns = detectTurns(main);
    if (turns.length === 0) continue;
    const root = commonAncestor(turns) ?? main;
    if (isValidConversationRoot(root)) return root;
  }

  return null;
}
