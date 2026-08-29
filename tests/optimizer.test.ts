import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/shared/config';
import { detectTurns } from '../src/content/detector';
import { Optimizer } from '../src/content/optimizer';
import { TurnRegistry } from '../src/content/registry';
import { createConversationFixture } from './fixtures/conversation';

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 640, height: 80, top: 40, bottom: 120, left: 0, right: 640 })
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  window.scrollBy = vi.fn();
});

describe('Optimizer', () => {
  it('uses containment attributes without hiding DOM with display:none', () => {
    const root = createConversationFixture(document, 120);
    const registry = new TurnRegistry();
    registry.addMany(detectTurns(root));
    const optimizer = new Optimizer(registry, {
      ...DEFAULT_CONFIG,
      mode: 'aggressive',
      activeWindow: 20,
      pinnedTail: 5
    });

    optimizer.updateViewport(50, 55);
    const stats = optimizer.getStats();
    expect(stats.turns).toBe(120);
    expect(stats.active).toBeGreaterThanOrEqual(20);
    expect(root.querySelectorAll('[data-cgpt-optimizer-state="dormant"]')).toHaveLength(95);
    expect((root.querySelector('[data-cgpt-optimizer-state="dormant"]') as HTMLElement | null)?.style.display).toBe('');
    expect(root.querySelector('[data-cgpt-optimizer-state="dormant"]')?.isConnected).toBe(true);
  });

  it('clears managed attributes when disabled', () => {
    const root = createConversationFixture(document, 30);
    const registry = new TurnRegistry();
    registry.addMany(detectTurns(root));
    const optimizer = new Optimizer(registry, { ...DEFAULT_CONFIG, mode: 'balanced' });
    optimizer.reconcile();
    optimizer.updateConfig({ ...DEFAULT_CONFIG, enabled: false, mode: 'balanced' });
    expect(root.querySelector('[data-cgpt-optimizer-turn]')).toBeNull();
  });
});
