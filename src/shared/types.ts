export type OptimizationMode = 'safe' | 'balanced' | 'aggressive';

export interface OptimizerConfig {
  enabled: boolean;
  mode: OptimizationMode;
  activeWindow: number;
  batchSize: number;
  pinnedTail: number;
  preloadMargin: number;
  autoLoad: boolean;
  showStats: boolean;
}

export interface TurnInfo {
  element: HTMLElement;
  index: number;
}

export interface ViewportState {
  firstVisible: number;
  lastVisible: number;
}

export interface WindowState {
  start: number;
  end: number;
}

export interface LoadingState {
  previous: boolean;
}

export interface OptimizerStats {
  enabled: boolean;
  mode: OptimizationMode;
  turns: number;
  active: number;
  dormant: number;
  firstVisible: number;
  lastVisible: number;
  longTasks: number;
  rootDetected: boolean;
  disabledReason?: string;
}

export interface ContentRequest {
  type: 'get-state' | 'get-stats' | 'disable-for-tab' | 'enable-for-tab';
}

export interface ContentResponse {
  ok: boolean;
  stats?: OptimizerStats;
  error?: string;
}
