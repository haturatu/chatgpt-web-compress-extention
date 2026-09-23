import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/shared/config';

describe('config', () => {
  it('clamps unsafe or invalid values to supported ranges', () => {
    expect(normalizeConfig({ mode: 'invalid' as never, activeWindow: 9999, batchSize: 0 })).toEqual({
      ...DEFAULT_CONFIG,
      activeWindow: 240,
      batchSize: 5
    });
  });

  it('migrates the former Memory Saver mode to Hibernate and leaves hard memory off by default', () => {
    const config = normalizeConfig({ mode: 'memory-saver' as never });
    expect(config.mode).toBe('hibernate');
    expect(config.hardMemoryEnabled).toBe(false);
    expect(config.networkDiscoveryEnabled).toBe(false);
  });
});
