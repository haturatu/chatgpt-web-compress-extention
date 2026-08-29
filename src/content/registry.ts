import type { TurnInfo } from '../shared/types';

export class TurnRegistry {
  private readonly turns = new Map<HTMLElement, TurnInfo>();

  add(element: HTMLElement): TurnInfo {
    const current = this.turns.get(element);
    if (current) {
      current.lastSeen = performance.now();
      return current;
    }

    const info: TurnInfo = {
      element,
      index: 0,
      height: 0,
      visible: false,
      lastSeen: performance.now()
    };
    this.turns.set(element, info);
    return info;
  }

  addMany(elements: HTMLElement[]): void {
    elements.forEach((element) => this.add(element));
    this.reindex();
  }

  remove(element: HTMLElement): void {
    this.turns.delete(element);
  }

  cleanupDisconnected(): void {
    for (const [element] of this.turns) {
      if (!element.isConnected) this.turns.delete(element);
    }
    this.reindex();
  }

  clear(): void {
    this.turns.clear();
  }

  reindex(): void {
    this.ordered().forEach((info, index) => {
      info.index = index;
    });
  }

  ordered(): TurnInfo[] {
    return Array.from(this.turns.values()).sort((a, b) => {
      if (a.element === b.element) return 0;
      const position = a.element.compareDocumentPosition(b.element);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
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
