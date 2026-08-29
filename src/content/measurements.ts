import { TurnRegistry } from './registry';

function getBlockSize(entry: ResizeObserverEntry): number {
  const borderBoxSize = entry.borderBoxSize as readonly ResizeObserverSize[] | ResizeObserverSize;
  if (Array.isArray(borderBoxSize) && borderBoxSize[0]) return borderBoxSize[0].blockSize;
  if (!Array.isArray(borderBoxSize)) return (borderBoxSize as ResizeObserverSize).blockSize;
  return entry.contentRect.height;
}

export class HeightMeasurements {
  private readonly observer: ResizeObserver | null;

  constructor(private readonly registry: TurnRegistry) {
    this.observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          const info = this.registry.get(element);
          if (info) info.height = getBlockSize(entry);
        }
      });
  }

  observe(elements: HTMLElement[]): void {
    elements.forEach((element) => this.observer?.observe(element));
  }

  unobserve(elements: HTMLElement[]): void {
    elements.forEach((element) => this.observer?.unobserve(element));
  }

  destroy(): void {
    this.observer?.disconnect();
  }
}
