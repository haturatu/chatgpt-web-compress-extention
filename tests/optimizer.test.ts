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

  it('updates only a new tail turn after the initial window is applied', () => {
    const root = createConversationFixture(document, 100);
    const registry = new TurnRegistry();
    registry.addMany(detectTurns(root));
    const optimizer = new Optimizer(registry, { ...DEFAULT_CONFIG, mode: 'aggressive', activeWindow: 20, pinnedTail: 5 });
    optimizer.updateViewport(40, 45);

    const setAttribute = vi.spyOn(HTMLElement.prototype, 'setAttribute');
    const appended = document.createElement('article');
    appended.dataset.testid = 'conversation-turn-100';
    appended.innerHTML = '<div data-message-author-role="assistant">new</div>';
    root.append(appended);
    registry.add(appended);
    optimizer.reconcile();

    expect(setAttribute.mock.calls.length).toBeLessThan(8);
    expect(appended.dataset.cgptOptimizerState).toBe('active');
  });

  it('restores remote media when Hibernate turns become active', () => {
    const root = createConversationFixture(document, 120);
    const registry = new TurnRegistry();
    const turns = detectTurns(root);
    registry.addMany(turns);
    const image = document.createElement('img');
    image.src = 'https://cdn.example.test/image.png';
    turns[0]!.append(image);
    const optimizer = new Optimizer(registry, { ...DEFAULT_CONFIG, mode: 'hibernate', activeWindow: 20, pinnedTail: 5 });

    optimizer.updateViewport(60, 65);
    expect(image.hasAttribute('src')).toBe(false);
    optimizer.updateViewport(0, 1);
    expect(image.getAttribute('src')).toBe('https://cdn.example.test/image.png');
  });
});
