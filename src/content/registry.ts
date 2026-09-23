export class TurnRegistry {
  private readonly turns: HTMLElement[] = [];
  private membership = new WeakSet<HTMLElement>();
  private indices = new WeakMap<HTMLElement, number>();
  private currentStructureRevision = 0;
  private latestNonAppendRevision = 0;

  add(element: HTMLElement): boolean {
    if (this.membership.has(element)) return false;

    const last = this.turns.at(-1);
    if (!last || this.isBefore(last, element)) {
      const index = this.turns.length;
      this.turns.push(element);
      this.membership.add(element);
      this.indices.set(element, index);
      this.currentStructureRevision += 1;
      return true;
    }

    let low = 0;
    let high = this.turns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const current = this.turns[middle];
      if (current && this.isBefore(element, current)) high = middle;
      else low = middle + 1;
    }

    this.turns.splice(low, 0, element);
    this.membership.add(element);
    this.reindexFrom(low);
    this.currentStructureRevision += 1;
    this.latestNonAppendRevision = this.currentStructureRevision;
    return true;
  }

  addMany(elements: readonly HTMLElement[]): number {
    let added = 0;
    for (const element of elements) if (this.add(element)) added += 1;
    return added;
  }

  async addManyYielding(
    elements: readonly HTMLElement[],
    yieldToBrowser: () => Promise<void>,
    chunkSize = 64,
    shouldContinue: () => boolean = () => true
  ): Promise<number> {
    let added = 0;
    for (let index = 0; index < elements.length; index += 1) {
      if (!shouldContinue()) break;
      if (this.add(elements[index]!)) added += 1;
      if ((index + 1) % chunkSize === 0 && index + 1 < elements.length) {
        await yieldToBrowser();
        if (!shouldContinue()) break;
      }
    }
    return added;
  }

  remove(element: HTMLElement): boolean {
    const index = this.indices.get(element);
    if (index === undefined) return false;
    this.turns.splice(index, 1);
    this.membership.delete(element);
    this.indices.delete(element);
    this.reindexFrom(index);
    this.currentStructureRevision += 1;
    this.latestNonAppendRevision = this.currentStructureRevision;
    return true;
  }

  removeWithin(container: HTMLElement): number {
    let writeIndex = 0;
    let removed = 0;
    for (let readIndex = 0; readIndex < this.turns.length; readIndex += 1) {
      const element = this.turns[readIndex]!;
      if (container === element || container.contains(element)) {
        this.membership.delete(element);
        this.indices.delete(element);
        removed += 1;
        continue;
      }
      if (writeIndex !== readIndex) this.turns[writeIndex] = element;
      this.indices.set(element, writeIndex);
      writeIndex += 1;
    }
    if (removed > 0) {
      this.turns.length = writeIndex;
      this.currentStructureRevision += 1;
      this.latestNonAppendRevision = this.currentStructureRevision;
    }
    return removed;
  }

  cleanupDisconnected(): void {
    let writeIndex = 0;
    let removed = 0;
    for (let readIndex = 0; readIndex < this.turns.length; readIndex += 1) {
      const element = this.turns[readIndex]!;
      if (!element.isConnected) {
        this.membership.delete(element);
        this.indices.delete(element);
        removed += 1;
        continue;
      }
      if (writeIndex !== readIndex) this.turns[writeIndex] = element;
      this.indices.set(element, writeIndex);
      writeIndex += 1;
    }
    if (removed > 0) {
      this.turns.length = writeIndex;
      this.currentStructureRevision += 1;
      this.latestNonAppendRevision = this.currentStructureRevision;
    }
  }

  clear(): void {
    if (this.turns.length === 0) return;
    for (const element of this.turns) {
      this.membership.delete(element);
      this.indices.delete(element);
    }
    this.turns.length = 0;
    this.currentStructureRevision += 1;
    this.latestNonAppendRevision = this.currentStructureRevision;
  }

  elements(): readonly HTMLElement[] {
    return this.turns;
  }

  elementAt(index: number): HTMLElement | undefined {
    return this.turns[index];
  }

  indexOf(element: HTMLElement): number | undefined {
    return this.indices.get(element);
  }

  has(element: HTMLElement): boolean {
    return this.membership.has(element);
  }

  get structureRevision(): number {
    return this.currentStructureRevision;
  }

  hasNonAppendChangesSince(revision: number): boolean {
    return this.latestNonAppendRevision > revision;
  }

  count(): number {
    return this.turns.length;
  }

  private isBefore(first: HTMLElement, second: HTMLElement): boolean {
    if (first === second) return false;
    return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  private reindexFrom(start: number): void {
    for (let index = start; index < this.turns.length; index += 1) {
      this.indices.set(this.turns[index]!, index);
    }
  }
}
