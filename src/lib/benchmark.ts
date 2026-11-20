export type RendererMode = 'webgl' | 'webgpu';

export interface LiveMetrics {
  fps: number;
  avgFps: number;
  minFps: number | null;
  maxFps: number | null;
  frameMs: number;
  calls: number | null;
  triangles: number | null;
  points: number | null;
  count: number;
  backend: string;
  mode: RendererMode;
}

export interface BenchmarkResult extends LiveMetrics {
  id: string;
  durationMs: number;
  requestedDurationMs: number;
  resolution: string;
  recordedAt: string;
}

export interface CaptureResult {
  avgFps: number;
  minFps: number | null;
  maxFps: number | null;
  frameMs: number;
  calls: number | null;
  triangles: number | null;
  points: number | null;
  frames: number;
  durationMs: number;
  resolution: string;
  resolutionChanged: boolean;
}

export const OBJECT_COUNTS = [100, 500, 1000, 2500, 5000] as const;
export const DEFAULT_DURATION_SECONDS = 10;
export const WARMUP_MS = 2000;
