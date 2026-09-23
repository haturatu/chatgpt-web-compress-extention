export type OptimizationMode = 'safe' | 'balanced' | 'aggressive' | 'hibernate';

export interface OptimizerConfig {
  enabled: boolean;
  mode: OptimizationMode;
  activeWindow: number;
  batchSize: number;
  pinnedTail: number;
  preloadMargin: number;
  autoLoad: boolean;
  showStats: boolean;
  networkDiscoveryEnabled: boolean;
  hardMemoryEnabled: boolean;
  hardMemoryRetainedTurns: number;
  hardMemoryPayloadPath: string;
}

export interface ArchivedMedia {
  kind: 'image' | 'video' | 'audio';
  source: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface ArchivedTurn {
  index: number;
  role: string;
  text: string;
  height: number;
  media: ArchivedMedia[];
}

export interface ArchiveSnapshot {
  sourceUrl: string;
  title: string;
  conversationId: string;
  turns: ArchivedTurn[];
}

export interface ArchiveChunkDescriptor {
  index: number;
  count: number;
  storage: 'opfs' | 'indexeddb';
  fileName?: string;
  compressedBytes: number;
}

export interface ArchiveManifest {
  id: string;
  title: string;
  conversationId: string;
  sourceUrl: string;
  sourceTabId: number | null;
  createdAt: number;
  turnCount: number;
  heights: number[];
  chunks: ArchiveChunkDescriptor[];
  kind: 'dom-snapshot' | 'hard-memory';
}

export interface NetworkDiscoveryRecord {
  path: string;
  method: string;
  contentType: string;
  status: number;
  encodedBytes: number;
  streamed: boolean;
  seenAt: number;
  observations: number;
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
  type: 'get-state' | 'get-stats' | 'disable-for-tab' | 'enable-for-tab' | 'create-archive-snapshot';
}

export interface ContentResponse {
  ok: boolean;
  stats?: OptimizerStats;
  snapshot?: ArchiveSnapshot;
  error?: string;
}
