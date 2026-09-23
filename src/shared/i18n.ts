/** Uses Chrome's locale negotiation, which selects the best matching packaged _locales catalog. */
export function t(key: string, ...substitutions: string[]): string {
  if (typeof chrome === 'undefined' || !chrome.i18n) return key;
  return chrome.i18n.getMessage(key, substitutions.length ? substitutions : undefined) || key;
}

export function uiLocale(): string {
  if (typeof chrome !== 'undefined' && chrome.i18n) {
    return chrome.i18n.getMessage('documentLanguage') || chrome.i18n.getUILanguage();
  }
  return typeof navigator === 'undefined' ? 'en' : navigator.language || 'en';
}

export function localizeDocument(doc: Document = document): void {
  doc.documentElement.lang = uiLocale();
  const tokenPattern = /__MSG_([A-Za-z0-9_@]+)__/g;
  const localize = (value: string): string => value.replace(tokenPattern, (_match, key: string) => t(key));
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeValue?.includes('__MSG_')) node.nodeValue = localize(node.nodeValue);
  }
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.value.includes('__MSG_')) {
        element.setAttribute(attribute.name, localize(attribute.value));
      }
    }
  }
}
