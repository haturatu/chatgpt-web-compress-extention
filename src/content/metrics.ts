export class PerformanceMetrics {
  private readonly observer: PerformanceObserver | null;
  private longTaskCount = 0;

  constructor() {
    if (typeof PerformanceObserver === 'undefined') {
      this.observer = null;
      return;
    }

    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) this.longTaskCount += 1;
        }
      });
      this.observer.observe({ type: 'longtask', buffered: true });
    } catch {
      this.observer = null;
    }
  }

  get longTasks(): number {
    return this.longTaskCount;
  }

  destroy(): void {
    this.observer?.disconnect();
  }
}
