import type { OptimizerConfig, OptimizationMode } from './types';

export const DEFAULT_CONFIG: OptimizerConfig = {
  enabled: true,
  mode: 'safe',
  activeWindow: 80,
  batchSize: 25,
  pinnedTail: 20,
  preloadMargin: 800,
  autoLoad: true,
  showStats: false
};

export const CONFIG_LIMITS = {
  activeWindow: { min: 20, max: 240 },
  batchSize: { min: 5, max: 100 },
  pinnedTail: { min: 5, max: 50 },
  preloadMargin: { min: 200, max: 2000 }
} as const;

const isMode = (value: unknown): value is OptimizationMode =>
  value === 'safe' || value === 'balanced' || value === 'aggressive' || value === 'memory-saver';

const numberInRange = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
};

export function normalizeConfig(value: Partial<OptimizerConfig> | null | undefined): OptimizerConfig {
  const source = value ?? {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CONFIG.enabled,
    mode: isMode(source.mode) ? source.mode : DEFAULT_CONFIG.mode,
    activeWindow: numberInRange(
      source.activeWindow,
      CONFIG_LIMITS.activeWindow.min,
      CONFIG_LIMITS.activeWindow.max,
      DEFAULT_CONFIG.activeWindow
    ),
    batchSize: numberInRange(
      source.batchSize,
      CONFIG_LIMITS.batchSize.min,
      CONFIG_LIMITS.batchSize.max,
      DEFAULT_CONFIG.batchSize
    ),
    pinnedTail: numberInRange(
      source.pinnedTail,
      CONFIG_LIMITS.pinnedTail.min,
      CONFIG_LIMITS.pinnedTail.max,
      DEFAULT_CONFIG.pinnedTail
    ),
    preloadMargin: numberInRange(
      source.preloadMargin,
      CONFIG_LIMITS.preloadMargin.min,
      CONFIG_LIMITS.preloadMargin.max,
      DEFAULT_CONFIG.preloadMargin
    ),
    autoLoad: typeof source.autoLoad === 'boolean' ? source.autoLoad : DEFAULT_CONFIG.autoLoad,
    showStats: typeof source.showStats === 'boolean' ? source.showStats : DEFAULT_CONFIG.showStats
  };
}

export async function loadConfig(): Promise<OptimizerConfig> {
  try {
    const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
    return normalizeConfig(stored as Partial<OptimizerConfig>);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: Partial<OptimizerConfig>): Promise<OptimizerConfig> {
  const next = normalizeConfig(config);
  await chrome.storage.local.set(next);
  return next;
}
