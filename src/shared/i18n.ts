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
