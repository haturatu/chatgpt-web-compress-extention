import type { TurnInfo } from '../shared/types';

export class TurnRegistry {
  private readonly turns = new Map<HTMLElement, TurnInfo>();
  private orderedCache: TurnInfo[] | null = null;

  add(element: HTMLElement): TurnInfo {
    const current = this.turns.get(element);
    if (current) return current;

    const info: TurnInfo = {
      element,
      index: 0
    };
    this.turns.set(element, info);
    this.orderedCache = null;
    return info;
  }

  addMany(elements: HTMLElement[]): void {
    elements.forEach((element) => this.add(element));
    this.reindex();
  }

  remove(element: HTMLElement): void {
    if (this.turns.delete(element)) this.orderedCache = null;
  }

  cleanupDisconnected(): void {
    let changed = false;
    for (const [element] of this.turns) {
      if (!element.isConnected) {
        this.turns.delete(element);
        changed = true;
      }
    }
    if (changed) this.reindex();
  }

  clear(): void {
    this.turns.clear();
    this.orderedCache = [];
  }

  reindex(): void {
    this.orderedCache = null;
    this.ordered().forEach((info, index) => {
      info.index = index;
    });
  }

  ordered(): TurnInfo[] {
    if (!this.orderedCache) {
      this.orderedCache = Array.from(this.turns.values()).sort((a, b) => {
        if (a.element === b.element) return 0;
        const position = a.element.compareDocumentPosition(b.element);
        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    }
    return this.orderedCache;
  }

  get(element: HTMLElement): TurnInfo | undefined {
    return this.turns.get(element);
  }

  getByIndex(index: number): TurnInfo | undefined {
    return this.ordered()[index];
  }

  count(): number {
    return this.turns.size;
  }
}
