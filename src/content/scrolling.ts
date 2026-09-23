/** Return the nearest element that owns scrolling for a conversation node. */
export function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
    const overflowY = getComputedStyle(ancestor).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && ancestor.clientHeight > 0) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}
