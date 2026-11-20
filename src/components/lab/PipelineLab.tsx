import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Cpu, Expand, Pause, Play, RotateCcw, SkipBack, SkipForward, SlidersHorizontal } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PipelineEngine } from '../../lib/pipeline-engine';
import type { ApiStatus, BenchmarkProtocol, Experience, LabMetric, LabResult, VertexInspection } from '../../lib/pipeline-engine';
import { STAGES } from '../../lib/pipeline-content';
import { STAGE_SECONDS, TOTAL_SECONDS, stageAt } from '../../lib/pipeline';
import type { DisplayMode, Layout, ObjectKind, RasterImage } from '../../lib/pipeline';
import type { RendererMode } from '../../lib/benchmark';
import './pipeline-lab.css';
import { LiveComparison } from './LiveComparison';

const initial: ApiStatus = { state: 'initializing', detail: 'API бэлтгэж байна…' };
const names: Record<ObjectKind, string> = { cube: 'Cube', sphere: 'Sphere', torus: 'Torus', knot: 'Torus knot · complex mesh', particles: '100,000 particles' };
const chartStyle = { background: '#121a28', border: '1px solid #33425b', borderRadius: 8, color: '#e6edff' };
const format = (value: number | undefined | null, digits = 1) => value == null || !Number.isFinite(value) ? 'N/A' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const coords = (values: number[]) => values.map(x => x.toFixed(3)).join(', ');

function RasterView({ image, stage, progress }: { image: RasterImage | null; stage: number; progress: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !image) return;
    const output = new ImageData(new Uint8ClampedArray(image.colors), image.width, image.height);
    for (let pixel = 0; pixel < image.width * image.height; pixel++) {
      if (stage === 3 && pixel / (image.width * image.height) > progress) output.data[pixel * 4 + 3] = 0;
      else if (stage === 3 && output.data[pixel * 4 + 3]) output.data.set([112, 167, 255, 255], pixel * 4);
      else if (stage === 4 && pixel / (image.width * image.height) > progress && output.data[pixel * 4 + 3]) output.data.set([112, 167, 255, 255], pixel * 4);
    }
    context.clearRect(0, 0, image.width, image.height);
    context.putImageData(output, 0, 0);
  }, [image, stage, progress]);
  if (!image) return null;
  return <div className="lab-raster"><canvas ref={canvas} width={64} height={64} aria-label="CPU barycentric rasterization demonstration" /><div><strong>64 × 64 · CPU pixel lab</strong><span>{image.covered} / 4096 samples covered</span><small>Ижил геометрийн проекц · GPU capture биш</small></div></div>;
}

export function PipelineLab({ suspended, onBenchmarkActive }: { suspended: boolean; onBenchmarkActive: (active: boolean) => void }) {
  const root = useRef<HTMLElement>(null);
  const glHost = useRef<HTMLDivElement>(null);
  const gpuHost = useRef<HTMLDivElement>(null);
  const differenceCanvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<PipelineEngine | null>(null);
  const [status, setStatus] = useState<Record<RendererMode, ApiStatus>>({ webgl: initial, webgpu: initial });
  const [experience, setExperience] = useState<Experience>('performance');
  const [protocol, setProtocol] = useState<BenchmarkProtocol>('isolated');
  const [repeats, setRepeats] = useState(2);
  const [include500k, setInclude500k] = useState(false);
  const [benchmarkGraph, setBenchmarkGraph] = useState<'fps' | 'frameMs' | 'gpuMs' | 'submitMs'>('gpuMs');
  const [layout, setLayout] = useState<Layout>('split');
  const [kind, setKind] = useState<ObjectKind>('cube');
  const [display, setDisplay] = useState<DisplayMode>('pipeline');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [inspection, setInspection] = useState<VertexInspection | null>(null);
  const [raster, setRaster] = useState<RasterImage | null>(null);
  const [metrics, setMetrics] = useState<LabMetric[]>([]);
  const [series, setSeries] = useState<{ at: string; webgl?: number; webgpu?: number; webglMs?: number; webgpuMs?: number }[]>([]);
  const [graph, setGraph] = useState<'fps' | 'ms'>('fps');
  const [color, setColor] = useState('#7faeff');
  const [roughness, setRoughness] = useState(.35);
  const [metalness, setMetalness] = useState(.2);
  const [liveStarting, setLiveStarting] = useState(false);
  const handleLiveBusy = useCallback((active: boolean) => { setLiveStarting(active); onBenchmarkActive(active); }, [onBenchmarkActive]);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkMessage, setBenchmarkMessage] = useState('Ижил 640 × 480 resolution · backend бүрийг тусад нь хэмжинэ.');
  const [results, setResults] = useState<LabResult[]>([]);
  const [difference, setDifference] = useState('Хоёр API-ийн нэг агшны бодит canvas pixel-үүдийг харьцуулна.');
  const [error, setError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const { stage, progress } = stageAt(time);
  const content = STAGES[stage];
  const locked = suspended || benchmarking || capturing || liveStarting;

  useEffect(() => {
    if (experience !== 'education' || !glHost.current || !gpuHost.current) return;
    let active = true;
    const lab = new PipelineEngine({ webgl: glHost.current, webgpu: gpuHost.current }, {
      status: (api, value) => { if (active) setStatus(previous => ({ ...previous, [api]: value })); },
      tick: (value, running) => { if (active) { setTime(value); setPlaying(running); } },
      inspect: (data, image) => { if (active) { setInspection(data); setRaster(image); } },
      metrics: values => {
        if (!active) return;
        setMetrics(values);
        setSeries(previous => [...previous.slice(-39), { at: new Date().toLocaleTimeString(), ...Object.fromEntries(values.flatMap(m => [[m.mode, m.fps], [`${m.mode}Ms`, m.frameMs]])) }]);
      },
      benchmark: (message, rows) => { if (active) { setBenchmarkMessage(message); if (rows) setResults(rows); } },
    });
    lab.setExperience('education');
    lab.setObject(kind);
    lab.setMaterial(color, roughness, metalness);
    lab.setLayout(layout);
    lab.speed = speed;
    if (time > 0) lab.seek(time);
    lab.pause();
    engine.current = lab;
    return () => { active = false; lab.dispose(); engine.current = null; };
  }, [experience]);
  useEffect(() => { engine.current?.setSuspended(suspended); }, [suspended]);
  useEffect(() => { engine.current?.setLayout(layout); }, [layout]);
  useEffect(() => { engine.current?.setMaterial(color, roughness, metalness); }, [color, roughness, metalness, kind]);

  function selectObject(value: ObjectKind) {
    setKind(value); engine.current?.setObject(value);
    setSeries([]); setMetrics([]); setRaster(null);
  }
  function seek(value: number) { engine.current?.pause(); engine.current?.seek(value); }
  function selectLayout(value: Layout) { setLayout(value); setSeries([]); setMetrics([]); }
  async function benchmark() {
    if (!engine.current) return;
    setBenchmarking(true); onBenchmarkActive(true); setSeries([]); setResults([]);
    try { await engine.current.benchmark({ protocol, repeats, include500k }); }
    finally { setBenchmarking(false); onBenchmarkActive(false); }
  }
  async function captureDifference() {
    if (!differenceCanvas.current || !engine.current) return;
    setCapturing(true);
    try { setDifference(await engine.current.difference(differenceCanvas.current)); }
    catch (e) { setDifference(e instanceof Error ? e.message : String(e)); }
    finally { setCapturing(false); }
  }
  function exportResults() {
    const blob = new Blob([JSON.stringify({ protocols: [...new Set(results.map(r => r.protocol))], conditions: 'Indexed sphere; 640x480; DPR=1; AA off; opaque; 1.5s warmup; >=3s independent frame intervals; camera=(4.5,3,6.5), FOV=42, near=0.1, far=100; material=#7faeff, roughness=0.35, metalness=0.2; GPU time from optional hardware queries; alternating trial order', userAgent: navigator.userAgent, status, results }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'pipeline-benchmark.json'; anchor.click(); URL.revokeObjectURL(url);
  }
  const comparison = [1000, 10000, 50000, 100000, ...(results.some(r => r.vertices === 500000) ? [500000] : [])].map(vertices => {
    const mean = (mode: RendererMode) => {
      const values = results.filter(r => r.mode === mode && r.vertices === vertices && r.protocol === (results[0]?.protocol ?? protocol)).map(r => r[benchmarkGraph]).filter((v): v is number => v !== null && Number.isFinite(v));
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
    };
    return { vertices: vertices.toLocaleString(), webgl: mean('webgl'), webgpu: mean('webgpu') };
  });
  const benchmarkUnit = benchmarkGraph === 'fps' ? 'FPS' : 'ms';
  function selectExperience(value: Experience) {
    setExperience(value); engine.current?.setExperience(value); setMetrics([]); setSeries([]);
  }


  const objectControls = <aside className="lab-sidebar"><h2><SlidersHorizontal size={16} /> Object explorer</h2><label>Объект<select value={kind} disabled={locked} onChange={e => selectObject(e.target.value as ObjectKind)}>{Object.entries(names).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Дүрслэх горим<select value={experience === 'performance' ? 'solid' : display} disabled={locked || experience === 'performance'} onChange={e => { setDisplay(e.target.value as DisplayMode); engine.current?.setDisplay(e.target.value as DisplayMode); }}>{([['pipeline', 'Pipeline · үе шатаар'], ['vertices', 'Vertices · оройн цэг'], ['wireframe', 'Wireframe · ирмэг'], ['solid', 'Solid · материал'], ['triangles', 'Triangles · нүүр'], ['normals', 'Normals · нормаль']] as const).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <div className="lab-complexity"><span>Geometry complexity</span><strong>{format(metrics[0]?.vertices, 0)} <small>source vertices</small></strong><small>{kind === 'particles' ? '100K instances · no connected surface' : 'Indexed mesh · attributes + indices'}</small></div>
        <h3>Материал <span>Both APIs</span></h3><label className="lab-color">Albedo<input type="color" aria-label="Material color" value={color} disabled={locked} onChange={e => setColor(e.target.value)} /></label><label>Roughness <output>{roughness.toFixed(2)}</output><input type="range" aria-label="Material roughness" disabled={locked} min="0" max="1" step=".01" value={roughness} onChange={e => setRoughness(Number(e.target.value))} /></label><label>Metalness <output>{metalness.toFixed(2)}</output><input type="range" aria-label="Material metalness" disabled={locked} min="0" max="1" step=".01" value={metalness} onChange={e => setMetalness(Number(e.target.value))} /></label>
        <button disabled={locked} onClick={() => engine.current?.resetCamera()}><RotateCcw size={14} /> Reset shared camera</button>
        <p className="lab-sidebar-note">Ижил геометр, камер, материал, resolution. Renderer бүр өөр canvas, API context, callback ба FPS тоолууртай. Хамт ажиллах үеийн FPS нь browser refresh rate болон shared CPU/GPU-ээр хязгаарлагдаж болно.</p>
      </aside>;

  return <section className="pipeline-lab" id="laboratory" ref={root} aria-labelledby="lab-title">
    <div className="lab-heading"><div><h1 id="lab-title">Өгөгдлөөс <span>дүрс хүртэл.</span></h1><p>Гурван хэмжээст объект хэрхэн бүтдэгийг алхам бүрээр судлаарай.</p></div><button className="lab-icon-button" aria-label="Fullscreen laboratory" onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(e => setError(String(e))); }}><Expand size={18} /></button></div>
    <div className="lab-mode-switch"><div className="lab-segmented" aria-label="Laboratory mode"><button disabled={locked} aria-pressed={experience === 'performance'} onClick={() => selectExperience('performance')}>Live comparison</button><button disabled={locked} aria-pressed={experience === 'education'} onClick={() => selectExperience('education')}>Educational pipeline</button></div><p>{experience === 'education' ? '36 s сургалтын дүрслэл · GPU execution time биш.' : 'Ижил объект, тусдаа renderer ба хэмжилт. Хоёр API нэг төхөөрөмжийн нөөцийг хуваалцана.'}</p></div>
    {error && <p role="alert" className="lab-error">{error}</p>}
    {suspended && <p className="lab-error" role="status">Өмнөх cube benchmark ажиллаж байна. Хэмжилтэд нөлөөлөхгүйн тулд лаборатори түр зогссон.</p>}
    {experience === 'performance' && <LiveComparison kind={kind} color={color} roughness={roughness} metalness={metalness} suspended={suspended} controls={objectControls} onBusy={handleLiveBusy} />}
    <div className="lab-workspace" hidden={experience === 'performance'}>
      <div className="lab-main">
        <div className="lab-view-toolbar"><span><Box size={16} /> {names[kind]}</span><div className="lab-segmented" aria-label="Comparison layout">{([['split', 'Side by side'], ['webgl', 'WebGL'], ['webgpu', 'WebGPU'], ['difference', 'Difference']] as const).map(([value, label]) => <button key={value} disabled={locked} aria-pressed={layout === value} onClick={() => selectLayout(value)}>{label}</button>)}</div></div>
        <div className={`lab-viewports lab-layout-${layout}`}>
          {(['webgl', 'webgpu'] as const).map(api => <div key={api} className={`lab-viewport lab-${api}`} hidden={layout !== 'split' && layout !== 'difference' && layout !== api}>
            <div className="lab-api-label"><strong>{api === 'webgl' ? 'WebGL 2' : 'WebGPU'}</strong><div className="lab-render-timing" title="GPU: asynchronous draw-pass timer, when supported. CPU: render submission duration. Neither measures individual pipeline stages."><span>{format(metrics.find(m => m.mode === api)?.fps)} FPS</span><small>GPU {format(metrics.find(m => m.mode === api)?.gpuMs, 3)} ms</small><small>CPU {format(metrics.find(m => m.mode === api)?.submitMs, 3)} ms</small></div></div>
            <div ref={api === 'webgl' ? glHost : gpuHost} className="lab-canvas-host" />
            {!benchmarking && experience === 'education' && stage === 3 && display === 'pipeline' && kind !== 'particles' && <div className="lab-screen-plane"><RasterView image={raster} stage={stage} progress={progress} /></div>}
            {status[api].state !== 'ready' && <div className="lab-api-message"><Cpu size={25} /><strong>{status[api].state === 'initializing' ? 'Renderer эхэлж байна' : `${api.toUpperCase()} боломжгүй`}</strong><p>{status[api].detail}</p></div>}
            <span className="lab-viewport-foot">{benchmarking ? 'Benchmark · ' + protocol : experience === 'education' ? `${stage + 1} / 6 · ${content.en}` : 'Independent render loop'} <span>Drag to orbit · Scroll to zoom</span></span>
          </div>)}
        </div>
        {layout === 'difference' && <div className="lab-difference"><div><button disabled={locked || capturing || status.webgl.state !== 'ready' || status.webgpu.state !== 'ready'} onClick={() => void captureDifference()}>{capturing ? 'Уншиж байна…' : 'Capture pixel difference'}</button><p>{difference}</p><small>AA, shader compiler, color precision-оос ялгаа гарч болно. Энэ нь ижил pipeline implementation гэсэн баталгаа биш.</small></div><canvas ref={differenceCanvas} aria-label="Actual canvas RGB difference" /></div>}
        {experience === 'education' && !benchmarking && <div className="lab-transport"><div className="lab-playback">
          <button className="lab-primary" disabled={locked} onClick={() => { if (playing) engine.current?.pause(); else { setDisplay('pipeline'); engine.current?.setDisplay('pipeline'); engine.current?.play(); } }}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? 'Pause' : time === 0 ? 'Start Rendering' : 'Play'}</button>
          <button className="lab-icon-button" disabled={locked} aria-label="Restart pipeline" onClick={() => seek(0)}><RotateCcw size={16} /></button>
          <button className="lab-icon-button" disabled={locked || stage === 0} aria-label="Previous stage" onClick={() => seek(Math.max(0, stage - 1) * STAGE_SECONDS)}><SkipBack size={16} /></button>
          <button className="lab-icon-button" disabled={locked || stage === 5} aria-label="Next stage" onClick={() => seek((stage + 1) * STAGE_SECONDS)}><SkipForward size={16} /></button>
          <label className="lab-speed">Speed<select aria-label="Animation speed" disabled={locked} value={speed} onChange={e => { setSpeed(Number(e.target.value)); if (engine.current) engine.current.speed = Number(e.target.value); }}>{[.1, .25, .5, 1, 2].map(value => <option key={value} value={value}>{value}× {value < 1 ? 'Slow' : value === 1 ? 'Normal' : 'Fast'}</option>)}</select></label>
          <span className="lab-time" title="Сургалтын timeline · GPU execution time биш">Timeline {time.toFixed(2)} / {TOTAL_SECONDS.toFixed(2)} s</span>
        </div><input className="lab-timeline" type="range" aria-label="Pipeline timeline" disabled={locked} min="0" max={TOTAL_SECONDS} step="0.01" value={time} onChange={e => seek(Number(e.target.value))} />
        <div className="lab-stages">{STAGES.map((item, index) => <button key={item.en} disabled={locked} aria-current={index === stage ? 'step' : undefined} onClick={() => { setDisplay('pipeline'); engine.current?.setDisplay('pipeline'); seek(index * STAGE_SECONDS); }}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item.en}</strong><small>{index * STAGE_SECONDS}–{(index + 1) * STAGE_SECONDS} s</small></button>)}</div></div>}
      </div>
      {objectControls}
    </div>
    {experience === 'education' && <p className="lab-current-explanation"><strong>{content.name}</strong> {content.what}</p>}
    {experience === 'education' && <details className="lab-reference"><summary>Тайлбар ба өгөгдөл</summary>
    <div className="lab-learning"><article className="lab-explanation"><span className="lab-eyebrow">STAGE {stage + 1} / 6 · {content.en}</span><h2>{content.name}</h2><p>{content.what}</p><dl><div><dt>Яагаад хэрэгтэй вэ?</dt><dd>{content.why}</dd></div><div><dt>GPU юу хийдэг вэ?</dt><dd>{content.gpu}</dd></div></dl><code className="lab-formula">{content.formula}</code><details><summary>Дэлгэрэнгүй · Learn more</summary><p>{content.detail}</p><div className="lab-api-explanation"><p><b>WebGL / GLSL</b>{content.gl}</p><p><b>WebGPU / WGSL</b>{content.wgpu}</p></div><p>Албан эх сурвалж: <a href="https://gpuweb.github.io/gpuweb/" target="_blank" rel="noreferrer">WebGPU specification</a> · <a href="https://threejs.org/docs/#WebGPURenderer" target="_blank" rel="noreferrer">Three.js renderer</a> · <a href="https://registry.khronos.org/webgl/specs/latest/2.0/" target="_blank" rel="noreferrer">WebGL 2 specification</a></p></details></article>
      <aside className="lab-inspector"><h3>Live data inspector <span>COMPUTED</span></h3>{inspection && <><p>Vertex [{inspection.index}] · position buffer</p><div className="lab-coordinate"><span>Model</span><code>{coords(inspection.model)}</code><span>World · M</span><code>{coords(inspection.world)}</code><span>View · V</span><code>{coords(inspection.view)}</code><span>Clip · P</span><code>{coords(inspection.clip)}</code></div><details><summary>Model / View / Projection matrices</summary><small>Column-major storage · row-wise display. Projection below uses WebGL depth convention.</small>{inspection.matrices.map((matrix, i) => <div key={i} className="lab-matrix"><b>{['Model M', 'View V', 'Projection P'][i]}</b><div>{Array.from({ length: 16 }, (_, n) => <code key={n}>{matrix[n % 4 * 4 + Math.floor(n / 4)].toFixed(2)}</code>)}</div></div>)}</details></>}
        <RasterView image={raster} stage={stage} progress={progress} />
        {kind === 'particles' && <p>Point cloud нь холбогдсон гадаргуугүй. Жижиг tetrahedron тэмдэглэгээг instanced draw-аар харуулна. Mesh pipeline үзэхдээ Cube, Sphere эсвэл Torus сонгоно уу.</p>}
      </aside>
    </div>
    </details>}
    {experience === 'education' && <details className="lab-reference" id="performance"><summary>Гүйцэтгэлийн хэмжилт</summary>
    <div className="lab-monitor"><div className="lab-section-heading"><div><span className="lab-eyebrow">LIVE TELEMETRY</span><h2>Хэмжсэн үзүүлэлтүүд</h2></div><span>500 ms sampling · N/A = unavailable</span></div><div className="lab-metric-grid">{(['webgl', 'webgpu'] as const).map(api => { const m = suspended ? undefined : metrics.find(row => row.mode === api); return <div key={api} className={`lab-metric-api lab-${api}`}><h3>{api.toUpperCase()} <span>{status[api].detail}</span></h3><dl>{[['FPS', format(m?.fps)], ['Own frame interval', `${format(m?.frameMs, 2)} ms`], ['CPU render submission', `${format(m?.submitMs, 3)} ms`], ['GPU draw pass', `${format(m?.gpuMs, 3)} ms`], ['Draw calls', format(m?.calls, 0)], ['Triangles / frame', format(m?.triangles, 0)], ['Source vertices', format(m?.vertices, 0)], ['Initialization', `${format(status[api].initMs, 2)} ms`], ['Drawing buffer', m?.resolution ?? 'N/A']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>GPU: {status[api].gpu ?? 'N/A · browser мэдээлэл өгөөгүй'}</p></div>; })}</div><div className="lab-graph-select"><label>Live graph <select aria-label="Performance graph metric" value={graph} onChange={e => setGraph(e.target.value as 'fps' | 'ms')}><option value="fps">FPS</option><option value="ms">Frame interval (ms)</option></select></label></div><div className="lab-chart" aria-label="Measured live performance graph"><ResponsiveContainer width="100%" height={170}><LineChart data={series}><CartesianGrid stroke="#253044" vertical={false} /><XAxis dataKey="at" hide /><YAxis width={40} tick={{ fill: '#889bb8', fontSize: 12 }} /><Tooltip contentStyle={chartStyle} /><Legend /><Line dataKey={graph === 'fps' ? 'webgl' : 'webglMs'} name={`WebGL ${graph === 'fps' ? 'FPS' : 'ms'}`} stroke="#7faeff" dot={false} isAnimationActive={false} connectNulls={false} /><Line dataKey={graph === 'fps' ? 'webgpu' : 'webgpuMs'} name={`WebGPU ${graph === 'fps' ? 'FPS' : 'ms'}`} stroke="#b19aff" dot={false} isAnimationActive={false} connectNulls={false} /></LineChart></ResponsiveContainer></div><p className="lab-measure-note">FPS ба frame interval нь renderer бүрийн өөрийн callback-д амжилттай render хийсэн frame-үүдийн хэмжилт. Browser refresh rate-аас шалтгаалж FPS ижил байж болно; энэ нь GPU хугацаа ижил гэсэн үг биш. CPU render submission нь CPU дуудлагын хугацаа; GPU гүйцэтгэлийн хугацаа биш. GPU draw pass нь hardware timer дэмжсэн үед хэмжигдэнэ; дэмжихгүй бол N/A. GPU utilization ба VRAM: N/A. Refresh-rate cap, browser, power mode нь үр дүнд нөлөөлнө.</p></div>
    </details>}
    {experience === 'education' && <details className="lab-reference"><summary>Vertex benchmark</summary>
    <section id="lab-benchmark" className="lab-benchmark"><div className="lab-section-heading"><div><span className="lab-eyebrow">CONTROLLED EXPERIMENT</span><h2>Complexity benchmark</h2></div><div className="lab-benchmark-actions"><button disabled={suspended || capturing || status.webgl.state === 'initializing' || status.webgpu.state === 'initializing' || (status.webgl.state !== 'ready' && status.webgpu.state !== 'ready')} className={benchmarking ? '' : 'lab-primary'} onClick={() => benchmarking ? engine.current?.cancelBenchmark() : void benchmark()}>{benchmarking ? 'Cancel benchmark' : 'Run vertex benchmark'}</button><button disabled={!results.length || benchmarking} onClick={exportResults}>Export JSON</button></div></div><div className="lab-benchmark-options"><label>Protocol<select disabled={locked} value={protocol} onChange={e => setProtocol(e.target.value as BenchmarkProtocol)}><option value="isolated">Isolated · one API at a time</option><option value="concurrent">Simultaneous · shared CPU/GPU</option></select></label><label>Trials<select disabled={locked} value={repeats} onChange={e => setRepeats(Number(e.target.value))}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select></label><label className="lab-checkbox"><input type="checkbox" disabled={locked} checked={include500k} onChange={e => setInclude500k(e.target.checked)} /> Include 500,000 vertices (optional)</label></div><p role="status">{benchmarkMessage}</p><details><summary>Хэмжилтийн нөхцөл</summary><p>1K / 10K / 50K / 100K, сонголтоор 500K position бичлэгтэй indexed sphere. Ижил geometry/index buffer, PBR материал, гэрэл, camera pose/FOV, animation function. 640 × 480, DPR 1, alpha off, antialias off. API бүр 1.5 s warm-up, ≥3 s capture. Isolated нь бусад renderer-ийн draw-г зогсооно; simultaneous нь нэг эхлэлтэй боловч CPU/GPU нөөц хуваалцсан хэмжилт. Давтан trial бүр API-ийн дарааллыг солино. 500K нь opt-in; allocation, context/device failure гарвал хэмжилт цуцлагдаж дууссан үр дүн үлдэнэ. Hidden tab нь run-ийг цуцална. Startup CPU хугацаа нь module download-ийг агуулахгүй; GPU completion биш. FPS нь refresh-limited байж болно. GPU ms нь hardware timer-ийн sample mean, дэмжихгүй үед N/A. Shader/compiler, backend precision-оос pixel ялгаа гарч болно. WebGPU үргэлж хурдан гэж дүгнэхгүй.</p></details>
      {results.length > 0 ? <><div className="lab-graph-select"><label>Trial mean · {results[0]?.protocol}<select aria-label="Benchmark chart metric" value={benchmarkGraph} onChange={e => setBenchmarkGraph(e.target.value as typeof benchmarkGraph)}><option value="gpuMs">GPU draw pass (ms)</option><option value="submitMs">CPU submission (ms)</option><option value="fps">FPS</option><option value="frameMs">Frame interval (ms)</option></select></label></div><div className="lab-chart"><ResponsiveContainer width="100%" height={220}><BarChart data={comparison}><CartesianGrid stroke="#253044" vertical={false} /><XAxis dataKey="vertices" tick={{ fill: '#889bb8', fontSize: 12 }} /><YAxis width={40} tick={{ fill: '#889bb8', fontSize: 12 }} /><Tooltip contentStyle={chartStyle} /><Legend /><Bar dataKey="webgl" name={`WebGL ${benchmarkUnit}`} fill="#7faeff" radius={[3, 3, 0, 0]} isAnimationActive={false} /><Bar dataKey="webgpu" name={`WebGPU ${benchmarkUnit}`} fill="#b19aff" radius={[3, 3, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div><div className="lab-results-scroll"><table><thead><tr>{['API', 'Trial / protocol', 'Vertices', 'FPS', 'Frame ms', 'CPU ms', 'GPU ms / samples', 'Draws', 'Triangles', 'Intervals', 'Capture ms', 'Resolution'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{results.map(row => <tr key={`${row.mode}-${row.vertices}-${row.protocol}-${row.trial}`}><td>{row.mode}</td><td>{row.trial} / {row.protocol}</td><td>{format(row.vertices, 0)}</td><td>{format(row.fps)}</td><td>{format(row.frameMs, 2)}</td><td>{format(row.submitMs, 3)}</td><td>{format(row.gpuMs, 3)} / {row.gpuSamples}</td><td>{format(row.calls, 0)}</td><td>{format(row.triangles, 0)}</td><td>{row.frames}</td><td>{format(row.durationMs, 0)}</td><td>{row.resolution}</td></tr>)}</tbody></table></div></> : <div className="lab-benchmark-empty">Үр дүн хараахан хэмжээгүй. Run vertex benchmark дарж энэ төхөөрөмж дээр бодит өгөгдөл цуглуулна.</div>}
    </section>
    </details>}
  </section>;
}
