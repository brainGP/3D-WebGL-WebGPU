import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LiveController } from '../../lib/live-controller';
import { completionComparison, newLane } from '../../lib/live-lifecycle';
import type { LiveApi, LiveLane, LiveStats } from '../../lib/live-lifecycle';
import type { ObjectKind } from '../../lib/pipeline';
import { STAGES } from '../../lib/pipeline-content';

const apis: LiveApi[] = ['webgl', 'webgpu'];
const number = (value: number | null | undefined, digits = 2) => value == null ? 'Not available' : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
const ms = (value: number | null | undefined) => value == null ? 'Not available' : `${number(value)} ms`;
const metricRows: [string, keyof LiveStats][] = [
  ['Common geometry preparation · once', 'geometryMs'], ['Owned CPU scene/data copy', 'copyMs'],
  ['Remaining module wait', 'moduleMs'], ['Context/device initialization', 'deviceMs'], ['Start → initialized pipeline', 'initializationMs'],
  ['Shader/pipeline readiness · wall', 'setupMs'], ['Shader/pipeline API calls · CPU', 'shaderApiMs'],
  ['Buffer/attribute API calls · CPU', 'uploadMs'], ['Command encoding API calls · CPU', 'encodingMs'],
  ['Native draw / queue.submit calls · CPU', 'commandMs'], ['First render() submission · CPU', 'submitMs'],
  ['Completion wait · observed wall', 'waitMs'], ['Total start → available frame', 'completionMs'],
  ['Steady CPU render()', 'steadySubmitMs'], ['First-frame GPU draw pass', 'firstGpuMs'], ['Steady GPU draw-pass sample', 'gpuMs'],
  ['Steady mean frame interval', 'frameMs'], ['Steady median frame interval', 'medianMs'], ['Steady p95 frame interval', 'p95Ms'],
];
interface Props { kind: ObjectKind; color: string; roughness: number; metalness: number; suspended: boolean; controls: ReactNode; onBusy: (busy: boolean) => void }

export function LiveComparison(props: Props) {
  const gl = useRef<HTMLDivElement>(null), gpu = useRef<HTMLDivElement>(null);
  const controller = useRef<LiveController | null>(null);
  const busyCallback = useRef(props.onBusy); busyCallback.current = props.onBusy;
  const [lanes, setLanes] = useState({ webgl: newLane('webgl'), webgpu: newLane('webgpu') });
  const [started, setStarted] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [count, setCount] = useState(0);
  const [resolution, setResolution] = useState('640x480');
  const [stage, setStage] = useState(0);
  const [runRequest, setRunRequest] = useState(0);
  const previousKind = useRef(props.kind);
  const [width, height] = resolution.split('x').map(Number);
  const active = apis.some(api => lanes[api].state === 'initializing');
  const comparison = completionComparison(lanes.webgl, lanes.webgpu);

  useEffect(() => {
    if (!gl.current || !gpu.current) return;
    const live = new LiveController({ webgl: gl.current, webgpu: gpu.current }, lane => setLanes(previous => ({ ...previous, [lane.api]: lane })));
    controller.current = live;
    return () => { live.dispose(); controller.current = null; busyCallback.current(false); };
  }, []);
  useEffect(() => { controller.current?.setVisible(!props.suspended); }, [props.suspended]);
  useEffect(() => {
    if (!started || props.suspended) return;
    // A changed workload becomes a new common-start experiment for both APIs.
    const nativeChanged = previousKind.current !== props.kind;
    previousKind.current = props.kind;
    if (nativeChanged && count !== 0) { setCount(0); return; }
    busyCallback.current(true);
    controller.current?.setViewPaused(false); setFrozen(false);
    let current = true;
    void controller.current?.start({ kind: props.kind, count, color: props.color, roughness: props.roughness, metalness: props.metalness, width, height }).finally(() => { if (current) busyCallback.current(false); });
    return () => { current = false; };
  }, [started, runRequest, props.kind, props.color, props.roughness, props.metalness, count, width, height, props.suspended]);

  function exportRun() {
    const blob = new Blob([JSON.stringify({ conditions: { kind: props.kind, presetCount: count, resolution, color: props.color, roughness: props.roughness, metalness: props.metalness, alpha: false, antialias: false, dpr: 1 }, userAgent: navigator.userAgent, boundary: 'common start to observed GL fence / WebGPU queue completion, not browser presentation', lanes, comparison }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'first-frame-comparison.json'; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="live-comparison">
    <div className="live-start-controls">
      <button className="lab-primary" disabled={props.suspended} onClick={() => { setStarted(true); setRunRequest(n => n + 1); }}>{started ? 'Restart both' : 'Start both'}</button>
      <button disabled={!started} onClick={() => { const next = !frozen; setFrozen(next); controller.current?.setViewPaused(next); }}>{frozen ? 'Resume event view' : 'Freeze event view'}</button>
      <button disabled={!started || active} onClick={exportRun}>Export run JSON</button>
      <label>Workload<select value={count} disabled={active || props.suspended} onChange={e => setCount(Number(e.target.value))}><option value={0}>Selected object</option>{[1000, 10000, 50000, 100000, 500000].map(n => <option key={n} value={n}>Sphere · {n.toLocaleString()} vertices</option>)}</select></label>
      <label>Resolution<select value={resolution} disabled={active || props.suspended} onChange={e => setResolution(e.target.value)}>{['640x480', '960x720', '1280x960'].map(size => <option key={size} value={size}>{size.replace('x', ' × ')}</option>)}</select></label>
    </div>
    <div className="live-verdict" aria-live="polite" data-testid="completion-verdict">
      {comparison ? <><strong>{comparison.winner ? `${comparison.winner === 'webgl' ? 'WebGL' : 'WebGPU'} finished first` : 'Comparable within observation tolerance'}</strong><div><b>{number(comparison.differenceMs)} ms</b> difference <span>·</span> {number(comparison.percentLessTime)}% less observed time <span>·</span> {number(comparison.ratio)}× completion-time ratio</div><small>Common start → GPU completion observed. Tolerance {ms(comparison.toleranceMs)}; one contended startup run, not a statistical or universal winner.</small></> : <><strong>{active ? 'Independent startup in progress' : apis.some(api => lanes[api].state === 'error' || lanes[api].state === 'unsupported') ? 'No valid two-API completion comparison' : 'Which API makes the first frame available sooner?'}</strong><span>{active ? 'The finished lane is not held at a matching stage.' : 'Start both to measure. No preset times or predetermined winner.'}</span></>}
    </div>
    <div className="lab-workspace live-workspace"><div className="lab-main"><div className="lab-viewports">
      {apis.map(api => { const lane = lanes[api]; return <div key={api} className={`lab-viewport lab-${api}`}>
        <div className="lab-api-label"><strong>{api === 'webgl' ? 'WebGL 2' : 'WebGPU'}</strong><div className="lab-render-timing"><span>{lane.state === 'idle' ? 'Not started' : lane.state === 'complete' ? `${number(lane.metrics.completionMs)} ms to first frame` : `${number(lane.elapsedMs)} ms elapsed`}</span><small>{number(lane.metrics.fps, 1)} FPS after warm-up</small></div></div>
        <div className="lab-canvas-host" ref={api === 'webgl' ? gl : gpu} />
        {(lane.state === 'idle' || lane.state === 'error' || lane.state === 'unsupported') && <div className="lab-api-message"><strong>{lane.state === 'idle' ? 'Ready to start' : lane.state === 'unsupported' ? 'Unsupported' : 'Renderer error'}</strong><p>{lane.error ?? 'Same object · own API, buffers, shaders, scene and camera'}</p></div>}
        <span className="lab-viewport-foot">{lane.state === 'complete' ? 'Frame available · independently rendering' : lane.current}</span>
      </div>; })}
    </div><div className="live-lanes">
      {apis.map(api => <PipelineLane key={api} lane={lanes[api]} />)}
    </div></div>{props.controls}</div>
    <p className="lab-measure-note">“Frame available” means a WebGL fence or WebGPU queue completion was observed. It is not browser presentation time. JavaScript shares one main thread; asynchronous API/GPU work can overlap, but physical GPU parallelism is not guaranteed. Freezing the event view does not pause rendering or alter measurements.</p>
    <details className="lab-reference" open><summary>Measured comparison</summary><div className="lab-results-scroll"><table><thead><tr><th>Metric</th><th>WebGL</th><th>WebGPU</th><th>Observed difference</th></tr></thead><tbody>
      {metricRows.map(([label, key]) => { const a = lanes.webgl.metrics[key], b = lanes.webgpu.metrics[key]; const valid = typeof a === 'number' && typeof b === 'number' && key !== 'geometryMs' && lanes.webgl.run === lanes.webgpu.run && lanes.webgl.state === 'complete' && lanes.webgpu.state === 'complete'; return <tr key={key}><td>{label}</td><td>{typeof a === 'number' ? ms(a) : 'Not available'}</td><td>{typeof b === 'number' ? ms(b) : 'Not available'}</td><td>{valid ? `${number(Math.abs(a - b))} ms · single observation` : '—'}</td></tr>; })}
      <tr><td>Steady FPS · own submitted frames</td>{apis.map(api => <td key={api}>{number(lanes[api].metrics.fps, 1)}</td>)}<td>No significance claim</td></tr>
      {(['frames', 'vertices', 'indices', 'triangles', 'calls'] as const).map(key => <tr key={key}><td>{key}</td>{apis.map(api => <td key={api}>{number(lanes[api].metrics[key], 0)}</td>)}<td>—</td></tr>)}
      <tr><td>Render status</td>{apis.map(api => <td key={api}>{lanes[api].state}</td>)}<td>{comparison?.winner ?? 'No winner'}</td></tr>
    </tbody></table></div></details>
    <details className="lab-reference"><summary>Six GPU concepts · not measurable internal stage events</summary><div className="lab-stages">{STAGES.map((item, i) => <button key={item.en} aria-current={stage === i ? 'step' : undefined} onClick={() => setStage(i)}><strong>{item.en}</strong><small>Conceptual</small></button>)}</div><div className="live-concept"><h3>{STAGES[stage].name}</h3><p>{STAGES[stage].what}</p><p><b>Inputs / outputs:</b> {STAGES[stage].formula}</p><div className="lab-api-explanation"><p><b>WebGL CPU / API</b>{STAGES[stage].gl}</p><p><b>WebGPU CPU / API</b>{STAGES[stage].wgpu}</p></div><p><b>GPU:</b> {STAGES[stage].gpu}</p><small>Vertex processing, assembly, rasterization and fragment shading are explained here. Browser APIs do not emit per-stage hardware start/finish events; the live lanes above never assign them invented durations.</small></div></details>
    <details className="lab-reference"><summary>Measurement methodology and limits</summary><p className="lab-measure-note">One canonical geometry is prepared once, then copied into two owned scenes and buffers. Both tasks have the same logical start timestamp and are launched without awaiting the peer. Live native-method hooks record CPU time and actual call counts; buffer, shader, encoding and submission measurements overlap their enclosing setup/render wall time and must not be added together. Hooks can add overhead and may be unavailable if a browser prevents wrapping native methods. WebGL compileAsync and WebGPU compileAsync have different completion mechanisms. First-frame availability uses a nonblocking GL fence poll or queue.onSubmittedWorkDone; notification delay, browser timer resolution, module cache and shared CPU/GPU contention affect the result. GPU pass time is sampled separately only with supported hardware queries. After an independent 1.5 s warm-up, steady FPS and frame intervals come from each renderer's own successful submissions; median/p95 use the latest 240 intervals. No GPU utilization, display latency or internal stage timing is invented. Nearly equal totals have no declared winner; the tolerance is the larger of 2 ms, twice observed fence-poll delay and 2% of the smaller total. This is a conservative observation threshold, not a significance test.</p></details>
  </div>;
}

function PipelineLane({ lane }: { lane: LiveLane }) {
  const done = lane.milestones.filter(p => p.state === 'done').length;
  return <section className={`live-lane live-lane-${lane.api}`} data-testid={`lane-${lane.api}`} data-run={lane.run} data-start={lane.commonStart} data-state={lane.state}>
    <header><strong>{lane.api.toUpperCase()}</strong><span>{done} / {lane.milestones.length} observed milestones</span></header><p className="live-current">{lane.current}</p>
    <ol>{lane.milestones.map(p => <li key={p.id} data-state={p.state} data-group={p.group}><i /><div><strong>{p.label}</strong><small>{p.group.toUpperCase()} · {p.state}{p.endMs !== undefined ? ` · +${number(p.endMs)} ms` : p.startMs !== undefined ? ` · started +${number(p.startMs)} ms` : ''}</small></div></li>)}</ol>
    <details><summary>Observed native API calls ({lane.operations.reduce((sum, op) => sum + op.calls, 0)})</summary><div className="live-native-log">{lane.operations.length ? lane.operations.map(op => <div key={op.name}><code>{op.name} × {op.calls}</code><small>{ms(op.cpuMs)} CPU · first +{number(op.firstMs)} ms</small></div>) : <p>Not yet observed / not exposed.</p>}</div></details>
  </section>;
}
