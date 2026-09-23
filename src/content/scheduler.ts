type Callback = () => void;
export type TaskPriority = 'background' | 'user-visible';

interface PrioritizedScheduler {
  postTask<T>(
    callback: () => T | PromiseLike<T>,
    options?: { priority?: TaskPriority; signal?: AbortSignal }
  ): Promise<T>;
  yield?: () => Promise<void>;
}

function nativeScheduler(): PrioritizedScheduler | undefined {
  return (globalThis as typeof globalThis & { scheduler?: PrioritizedScheduler }).scheduler;
}

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

export async function yieldToBrowser(): Promise<void> {
  const scheduler = nativeScheduler();
  if (scheduler?.yield) {
    await scheduler.yield();
    return;
  }

  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 0);
      return;
    }
    let settled = false;
    let animationFrame = 0;
    let timeout = 0;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (animationFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(animationFrame);
      if (timeout) window.clearTimeout(timeout);
      resolve();
    };
    animationFrame = requestAnimationFrame(finish);
    timeout = window.setTimeout(finish, 16);
  });
}

export class Scheduler {
  private frameScheduled = false;
  private idleScheduled = false;
  private lifecycle = new AbortController();
  private readonly scheduledTasks = new Set<TaskPriority>();
  private generation = 0;

  frame(callback: Callback): void {
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    const generation = this.generation;
    runAnimationFrame(() => {
      if (generation !== this.generation) return;
      this.frameScheduled = false;
      if (!this.lifecycle.signal.aborted) callback();
    });
  }

  task(callback: Callback, priority: TaskPriority = 'user-visible'): void {
    if (this.scheduledTasks.has(priority)) return;
    this.scheduledTasks.add(priority);
    const generation = this.generation;
    const signal = this.lifecycle.signal;
    const run = (): void => {
      if (generation !== this.generation) return;
      this.scheduledTasks.delete(priority);
      if (!signal.aborted) callback();
    };
    const scheduler = nativeScheduler();
    if (scheduler?.postTask) {
      void scheduler.postTask(run, { priority, signal }).catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.scheduledTasks.delete(priority);
        if (!signal.aborted) window.setTimeout(() => { throw error; }, 0);
      });
      return;
    }
    window.setTimeout(run, 0);
  }

  idle(callback: Callback, timeout = 2000): void {
    if (this.idleScheduled) return;
    this.idleScheduled = true;
    const generation = this.generation;
    const signal = this.lifecycle.signal;
    const run = (): void => {
      if (generation !== this.generation) return;
      this.idleScheduled = false;
      if (!signal.aborted) callback();
    };
    const scheduler = nativeScheduler();
    if (scheduler?.postTask) {
      void scheduler.postTask(run, { priority: 'background', signal }).catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.idleScheduled = false;
        if (!signal.aborted) window.setTimeout(() => { throw error; }, 0);
      });
      return;
    }
    runIdle(run, timeout);
  }

  cancelPending(): void {
    this.generation += 1;
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.frameScheduled = false;
    this.idleScheduled = false;
    this.scheduledTasks.clear();
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
