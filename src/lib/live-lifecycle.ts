export type LiveApi = 'webgl' | 'webgpu';
export type WorkGroup = 'cpu' | 'api' | 'gpu' | 'output';
export interface Milestone { id: string; label: string; group: WorkGroup; state: 'pending' | 'active' | 'done' | 'error'; startMs?: number; endMs?: number }
export interface ApiOperation { name: string; group: WorkGroup; calls: number; cpuMs: number; firstMs: number; lastMs: number }
export interface LiveStats {
  initializationMs: number | null; firstGpuMs: number | null; geometryMs: number | null; copyMs: number | null; moduleMs: number | null; deviceMs: number | null;
  setupMs: number | null; uploadMs: number | null; shaderApiMs: number | null; encodingMs: number | null;
  commandMs: number | null; steadySubmitMs: number | null; submitMs: number | null; gpuMs: number | null; completionMs: number | null; waitMs: number | null;
  fps: number | null; frameMs: number | null; medianMs: number | null; p95Ms: number | null; frames: number;
  calls: number | null; triangles: number | null; vertices: number; indices: number; resolution: string;
}
export interface LiveLane {
  api: LiveApi; run: number; commonStart: number; state: 'idle' | 'initializing' | 'complete' | 'error' | 'unsupported';
  elapsedMs: number; current: string; milestones: Milestone[]; operations: ApiOperation[];
  metrics: LiveStats; error?: string; detectorMs: number;
}
export const PHASES: ReadonlyArray<{ id: string; label: string; group: WorkGroup }> = [
  { id: 'geometry', label: 'Объектын цэгүүдийг бэлдэх', group: 'cpu' },
  { id: 'module', label: 'Зураг зурах код бэлэн болох', group: 'cpu' },
  { id: 'device', label: 'GPU-тэй ажиллах орчин бэлдэх', group: 'api' },
  { id: 'copy', label: 'Өөрийн өгөгдлийн хувийг бэлдэх', group: 'cpu' },
  { id: 'setup', label: 'Шэйдер ба зурах тохиргоо бэлдэх', group: 'api' },
  { id: 'submit', label: 'Эхний зургийг зурах команд өгөх', group: 'api' },
  { id: 'completion', label: 'GPU ажил дууссан дохиог авах', group: 'gpu' },
  { id: 'output', label: 'Эхний зураг бэлэн', group: 'output' },
];
export function newLane(api: LiveApi, run = 0, commonStart = 0): LiveLane {
  return { api, run, commonStart, state: 'idle', elapsedMs: 0, current: 'Эхлүүлэхэд бэлэн', detectorMs: 0,
    milestones: PHASES.map(p => ({ ...p, state: 'pending' })), operations: [],
    metrics: { initializationMs: null, firstGpuMs: null, geometryMs: null, copyMs: null, moduleMs: null, deviceMs: null, setupMs: null, uploadMs: null, shaderApiMs: null, encodingMs: null, commandMs: null, steadySubmitMs: null, submitMs: null, gpuMs: null, completionMs: null, waitMs: null, fps: null, frameMs: null, medianMs: null, p95Ms: null, frames: 0, calls: null, triangles: null, vertices: 0, indices: 0, resolution: '' } };
}
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  return sorted[lower] + (sorted[Math.ceil(pos)] - sorted[lower]) * (pos - lower);
}
export function completionComparison(a: LiveLane, b: LiveLane) {
  if (a.state !== 'complete' || b.state !== 'complete' || a.run !== b.run || a.commonStart !== b.commonStart) return null;
  const gl = a.metrics.completionMs, gpu = b.metrics.completionMs;
  if (gl === null || gpu === null || gl <= 0 || gpu <= 0) return null;
  const differenceMs = Math.abs(gl - gpu);
  const faster = gl < gpu ? 'webgl' : 'webgpu';
  const toleranceMs = Math.max(2, a.detectorMs * 2, b.detectorMs * 2, Math.min(gl, gpu) * .02);
  return { winner: differenceMs > toleranceMs ? faster : null, first: gl === gpu ? null : faster,
    differenceMs, percentLessTime: differenceMs / Math.max(gl, gpu) * 100,
    ratio: Math.max(gl, gpu) / Math.min(gl, gpu), toleranceMs };
}

/** Start both tasks without awaiting a peer; the aggregate never cancels a sibling. */
export function launchBoth<T>(task: (api: LiveApi) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled((['webgpu', 'webgl'] as const).map(api => Promise.resolve().then(() => task(api))));
}
