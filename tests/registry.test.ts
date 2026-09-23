import { describe, expect, it } from 'vitest';
import { TurnRegistry } from '../src/content/registry';

describe('TurnRegistry', () => {
  it('keeps DOM order and removes disconnected turns', () => {
    const root = document.createElement('main');
    const first = document.createElement('article');
    const second = document.createElement('article');
    root.append(second, first);
    document.body.append(root);

    const registry = new TurnRegistry();
    registry.addMany([first, second]);
    expect(registry.elements()).toEqual([second, first]);
    expect(registry.indexOf(second)).toBe(0);
    expect(registry.indexOf(first)).toBe(1);

    first.remove();
    registry.cleanupDisconnected();
    expect(registry.count()).toBe(1);
    expect(registry.elementAt(0)).toBe(second);
  });
});
