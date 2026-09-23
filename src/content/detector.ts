import { MAIN_SELECTORS, STRONG_TURN_SELECTORS, TURN_SELECTORS } from './selectors';

const DISCOVERY_MARKUP_SELECTOR = 'main, [role="main"], article, [data-testid^="conversation-turn"], [data-message-author-role]';

const asElements = (nodes: NodeListOf<HTMLElement> | HTMLElement[]): HTMLElement[] =>
  Array.from(nodes);

const unique = (elements: HTMLElement[]): HTMLElement[] =>
  Array.from(new Set(elements));

export function isConversationTurn(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (!element.closest('main, [role="main"]')) return false;

  const testId = element.dataset.testid ?? '';
  if (testId.startsWith('conversation-turn')) return true;
  const hasMessageRole = Boolean(element.querySelector('[data-message-author-role]'));
  if (!hasMessageRole) return false;

  const visibilityElement = element as HTMLElement & {
    checkVisibility?: (options?: { contentVisibilityAuto?: boolean }) => boolean;
  };
  if (visibilityElement.checkVisibility) {
    try {
      return visibilityElement.checkVisibility({ contentVisibilityAuto: true });
    } catch {
      // Older engines can ignore the option shape even when the method exists.
    }
  }
  return element.getBoundingClientRect().width !== 0;
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

export function hasDiscoverableConversationMutation(records: readonly MutationRecord[]): boolean {
  return records.some((record) => {
    if (record.type === 'attributes') {
      const target = record.target;
      if (!(target instanceof HTMLElement)) return false;
      if (target.matches(DISCOVERY_MARKUP_SELECTOR)) return true;
      return Boolean(target.closest('main, [role="main"]')
        && target.matches('[data-testid], [data-message-author-role]'));
    }

    return Array.from(record.addedNodes).some((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const hasMain = node.matches('main, [role="main"]') || Boolean(node.querySelector('main, [role="main"]'));
      if (hasMain) return true;
      const hasTurn = node.matches(DISCOVERY_MARKUP_SELECTOR)
        || Boolean(node.querySelector('article, [data-testid^="conversation-turn"], [data-message-author-role]'));
      return hasTurn && Boolean(node.closest('main, [role="main"]'));
    });
  });
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

export async function detectTurnsYielding(
  root: ParentNode,
  yieldToBrowser: () => Promise<void>,
  chunkSize = 64,
  shouldContinue: () => boolean = () => true
): Promise<HTMLElement[]> {
  for (const selector of STRONG_TURN_SELECTORS) {
    const nodes = root.querySelectorAll<HTMLElement>(selector);
    if (nodes.length === 0) continue;
    const candidates: HTMLElement[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      if (!shouldContinue()) return [];
      const element = nodes[index]!;
      if (isConversationTurn(element)) candidates.push(element);
      if ((index + 1) % chunkSize === 0 && index + 1 < nodes.length) {
        await yieldToBrowser();
        if (!shouldContinue()) return [];
      }
    }
    if (candidates.length > 0) return unique(candidates);
  }

  const articles = root.querySelectorAll<HTMLElement>(TURN_SELECTORS[2]);
  const articleCandidates: HTMLElement[] = [];
  for (let index = 0; index < articles.length; index += 1) {
    if (!shouldContinue()) return [];
    const element = articles[index]!;
    if (isConversationTurn(element)) articleCandidates.push(element);
    if ((index + 1) % chunkSize === 0 && index + 1 < articles.length) {
      await yieldToBrowser();
      if (!shouldContinue()) return [];
    }
  }
  if (articleCandidates.length > 0) return unique(articleCandidates);

  const messages = root.querySelectorAll<HTMLElement>('[data-message-author-role]');
  const candidates: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (let index = 0; index < messages.length; index += 1) {
    if (!shouldContinue()) return [];
    const message = messages[index]!;
    const markedParent = message.closest<HTMLElement>('[data-testid^="conversation-turn"]');
    const candidate = markedParent ?? message.closest<HTMLElement>('article') ?? message.parentElement;
    if (candidate && !seen.has(candidate) && isConversationTurn(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
    if ((index + 1) % chunkSize === 0 && index + 1 < messages.length) {
      await yieldToBrowser();
      if (!shouldContinue()) return [];
    }
  }
  return candidates;
}

export function extractTurnsFromNode(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  const own = TURN_SELECTORS.some((selector) => node.matches(selector)) ? [node] : [];
  return unique([...own, ...detectTurns(node)]);
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
    if (!main.isConnected) continue;
    const strongTurn = main.querySelector<HTMLElement>(STRONG_TURN_SELECTORS.join(','));
    if (strongTurn?.isConnected) return main;

    const article = main.querySelector<HTMLElement>(TURN_SELECTORS[2]);
    if (article && isConversationTurn(article)) return main;

    const message = main.querySelector<HTMLElement>('[data-message-author-role]');
    const heuristicTurn = message?.closest<HTMLElement>('article') ?? message?.parentElement;
    if (heuristicTurn && isConversationTurn(heuristicTurn)) return main;
  }

  return null;
}
