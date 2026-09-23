export const TURN_SELECTORS = [
  '[data-testid^="conversation-turn-"]',
  '[data-testid^="conversation-turn"]',
  'article'
] as const;

export const STRONG_TURN_SELECTORS = TURN_SELECTORS.slice(0, 2);

export const MAIN_SELECTORS = [
  'main',
  '[role="main"]'
] as const;

export const OPTIMIZER_TURN_ATTRIBUTE = 'data-cgpt-optimizer-turn';
export const OPTIMIZER_STATE_ATTRIBUTE = 'data-cgpt-optimizer-state';
export const OPTIMIZER_ROOT_ATTRIBUTE = 'data-cgpt-optimizer';
export const LONG_MARKDOWN_ATTRIBUTE = 'data-cgpt-long-markdown';
