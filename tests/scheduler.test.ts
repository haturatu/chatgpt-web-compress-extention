import { describe, expect, it } from 'vitest';
import { BatchLoadGate } from '../src/content/scheduler';

describe('BatchLoadGate', () => {
  it('allows one batch until the boundary leaves the preload area', async () => {
    const gate = new BatchLoadGate();
    const load = () => undefined;

    await gate.trigger(load);
    expect(gate.current).toBe('cooldown');
    await gate.trigger(load);
    expect(gate.current).toBe('cooldown');

    gate.onSentinelExit();
    expect(gate.current).toBe('idle');
    gate.onScroll();
    expect(gate.current).toBe('armed');
    await gate.trigger(load);
    expect(gate.current).toBe('cooldown');
  });
});
