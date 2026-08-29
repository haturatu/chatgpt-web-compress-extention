type Callback = () => void;

const runAnimationFrame = (callback: FrameRequestCallback): number => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return window.setTimeout(() => callback(performance.now()), 0);
};

const runIdle = (callback: IdleRequestCallback, timeout: number): number => {
  if (typeof requestIdleCallback === 'undefined') {
    return window.setTimeout(() => callback({
      didTimeout: true,
      timeRemaining: () => 0
    }), timeout);
  }
  return requestIdleCallback(callback, { timeout });
};

export class Scheduler {
  private frameScheduled = false;
  private idleScheduled = false;

  frame(callback: Callback): void {
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    runAnimationFrame(() => {
      this.frameScheduled = false;
      callback();
    });
  }

  idle(callback: Callback, timeout = 2000): void {
    if (this.idleScheduled) return;
    this.idleScheduled = true;
    runIdle(() => {
      this.idleScheduled = false;
      callback();
    }, timeout);
  }
}

export type LoadState = 'idle' | 'armed' | 'loading' | 'cooldown';

export class BatchLoadGate {
  private state: LoadState = 'idle';

  onScroll(): void {
    if (this.state === 'idle') this.state = 'armed';
  }

  async trigger(load: () => void | Promise<void>): Promise<void> {
    if (this.state !== 'armed' && this.state !== 'idle') return;
    this.state = 'loading';
    try {
      await load();
    } finally {
      this.state = 'cooldown';
    }
  }

  onSentinelExit(): void {
    if (this.state === 'cooldown') this.state = 'idle';
  }

  get current(): LoadState {
    return this.state;
  }
}
