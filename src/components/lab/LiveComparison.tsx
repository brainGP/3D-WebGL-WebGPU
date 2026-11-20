import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LiveController } from '../../lib/live-controller';
import { completionComparison, newLane } from '../../lib/live-lifecycle';
import type { LiveApi, LiveLane, LiveStats } from '../../lib/live-lifecycle';
import type { ObjectKind } from '../../lib/pipeline';
import { StartupExplanation } from './StartupExplanation';
import { CALL_HELP, GLOSSARY, GROUP_LABELS, PHASE_HELP, STATE_LABELS } from '../../lib/live-explanations';
import { STAGES } from '../../lib/pipeline-content';

const apis: LiveApi[] = ['webgl', 'webgpu'];
const number = (value: number | null | undefined, digits = 2) => value == null ? 'Хэмжих боломжгүй' : value.toLocaleString('mn-MN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const ms = (value: number | null | undefined) => value == null ? 'Хэмжих боломжгүй' : `${number(value)} мс`;
const metricRows: [string, keyof LiveStats][] = [
  ['Объектын цэгүүдийг бэлдэх · нэг удаа', 'geometryMs'], ['API бүр өөрийн өгөгдлийг бэлдэх · CPU', 'copyMs'],
  ['Зураг зурах код бэлэн болох хүлээлт', 'moduleMs'], ['GPU-тэй ажиллах орчин бэлдэх', 'deviceMs'], ['Эхэлснээс зурах тохиргоо бэлэн болох хүртэл', 'initializationMs'],
  ['Шэйдер, зурах тохиргоог хүлээсэн хугацаа', 'setupMs'], ['Шэйдер, тохиргооны API дуудлага · CPU', 'shaderApiMs'],
  ['Буфер, өгөгдлийн API дуудлага · CPU', 'uploadMs'], ['Команд бичих API дуудлага · CPU', 'encodingMs'],
  ['Зурах команд илгээх дуудлага · CPU', 'commandMs'], ['Эхний render() дуудлага · CPU', 'submitMs'],
  ['GPU дууссан дохиог хүлээх', 'waitMs'], ['Эхэлснээс эхний зураг бэлэн болох нийт хугацаа', 'completionMs'],
  ['Бэлтгэлийн дараах render() · CPU', 'steadySubmitMs'], ['Эхний зургийн GPU тооцоолол', 'firstGpuMs'], ['Дараагийн зуралтын GPU тооцоолол', 'gpuMs'],
  ['Кадруудын хоорондох дундаж хугацаа', 'frameMs'], ['Кадрын хугацааны голын утга · медиан', 'medianMs'], ['Кадрын хугацааны 95%-ийн босго · p95', 'p95Ms'],
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
      <button className="lab-primary" disabled={props.suspended} onClick={() => { setStarted(true); setRunRequest(n => n + 1); }}>{started ? 'Хоёуланг дахин эхлүүлэх' : 'Хоёуланг эхлүүлэх'}</button>
      <button disabled={!started} onClick={() => { const next = !frozen; setFrozen(next); controller.current?.setViewPaused(next); }}>{frozen ? 'Явцыг дахин харуулах' : 'Явцын харагдацыг түр царцаах'}</button>
      <button disabled={!started || active} onClick={exportRun}>Хэмжилт татах · JSON</button>
      <label>Ачаалал<select value={count} disabled={active || props.suspended} onChange={e => setCount(Number(e.target.value))}><option value={0}>Сонгосон объект</option>{[1000, 10000, 50000, 100000, 500000].map(n => <option key={n} value={n}>Бөмбөрцөг · {n.toLocaleString()} цэг</option>)}</select></label>
      <label>Зургийн хэмжээ<select value={resolution} disabled={active || props.suspended} onChange={e => setResolution(e.target.value)}>{['640x480', '960x720', '1280x960'].map(size => <option key={size} value={size}>{size.replace('x', ' × ')}</option>)}</select></label>
    </div>
    <div className="lab-workspace live-workspace"><div className="lab-main"><div className="lab-viewports">
      {apis.map(api => { const lane = lanes[api]; return <div key={api} className={`lab-viewport lab-${api}`}>
        <div className="lab-api-label"><strong>{api === 'webgl' ? 'WebGL 2' : 'WebGPU'}</strong><div className="lab-render-timing"><span>{lane.state === 'idle' ? 'Эхлээгүй' : lane.state === 'complete' ? `${number(lane.metrics.completionMs)} мс эхний зураг хүртэл` : `${number(lane.elapsedMs)} мс өнгөрсөн`}</span><small>{number(lane.metrics.fps, 1)} FPS · бэлтгэлийн дараа</small></div></div>
        <div className="lab-canvas-host" ref={api === 'webgl' ? gl : gpu} />
        {(lane.state === 'idle' || lane.state === 'error' || lane.state === 'unsupported') && <div className="lab-api-message"><strong>{lane.state === 'idle' ? 'Эхлүүлэхэд бэлэн' : lane.state === 'unsupported' ? 'Дэмжихгүй' : 'Зурахад алдаа гарлаа'}</strong><p>{lane.error ?? 'Ижил объект · өөрийн API, өгөгдөл, шэйдер ба камертай'}</p></div>}
        <span className="lab-viewport-foot">{lane.state === 'complete' ? 'Эхний зураг бэлэн · үргэлжлүүлэн зурж байна' : lane.current}</span>
      </div>; })}
    </div><div className="live-lanes">
      {apis.map(api => <PipelineLane key={api} lane={lanes[api]} />)}
    </div></div>{props.controls}</div>
    <p className="lab-measure-note">CPU өгөгдөл, команд бэлдэнэ. GPU дүрсний тооцоог хийнэ. API нь браузерээр дамжуулан GPU-д ажил өгөх функцууд юм. “Зураг бэлэн” гэдэг нь GPU ажил дууссаны дохиог авсан үе; дэлгэц дээр харагдсан яг тэр мөчийг хэмжээгүй. Харагдацыг царцаахад бодит ажил ба хэмжилт үргэлжилнэ.</p>
    <details className="lab-reference" open><summary>Хэмжсэн үр дүнгийн харьцуулалт</summary><div className="lab-results-scroll"><table><thead><tr><th>Юуг хэмжсэн бэ?</th><th>WebGL</th><th>WebGPU</th><th>Хэмжсэн зөрүү</th></tr></thead><tbody>
      {metricRows.map(([label, key]) => { const a = lanes.webgl.metrics[key], b = lanes.webgpu.metrics[key]; const valid = typeof a === 'number' && typeof b === 'number' && key !== 'geometryMs' && lanes.webgl.run === lanes.webgpu.run && lanes.webgl.state === 'complete' && lanes.webgpu.state === 'complete'; return <tr key={key}><td>{label}</td><td>{typeof a === 'number' ? ms(a) : 'Хэмжих боломжгүй'}</td><td>{typeof b === 'number' ? ms(b) : 'Хэмжих боломжгүй'}</td><td>{valid ? `${number(Math.abs(a - b))} мс · энэ удаагийн хэмжилт` : '—'}</td></tr>; })}
      <tr><td>Секундэд зурсан кадрын тоо · FPS</td>{apis.map(api => <td key={api}>{number(lanes[api].metrics.fps, 1)}</td>)}<td>Зөвхөн ажигласан утга</td></tr>
      {(['frames', 'vertices', 'indices', 'triangles', 'calls'] as const).map(key => <tr key={key}><td>{{ frames: 'Хэмжсэн кадрын тоо', vertices: 'Оройн цэгийн тоо', indices: 'Цэг холбох индексийн тоо', triangles: 'Зурсан гурвалжны тоо', calls: 'Зурах дуудлагын тоо' }[key]}</td>{apis.map(api => <td key={api}>{number(lanes[api].metrics[key], 0)}</td>)}<td>—</td></tr>)}
      <tr><td>Дүрслэлийн төлөв</td>{apis.map(api => <td key={api}>{STATE_LABELS[lanes[api].state]}</td>)}<td>{comparison?.winner ?? 'Түрүүлсэн API тодорхойгүй'}</td></tr>
    </tbody></table></div></details>
    <StartupExplanation gl={lanes.webgl} gpu={lanes.webgpu} />
     </div>;
}

function PipelineLane({ lane }: { lane: LiveLane }) {
  const done = lane.milestones.filter(p => p.state === 'done').length;
  return <section className={`live-lane live-lane-${lane.api}`} data-testid={`lane-${lane.api}`} data-run={lane.run} data-start={lane.commonStart} data-state={lane.state}>
    <header><strong>{lane.api.toUpperCase()}</strong><span>{done} / {lane.milestones.length} ажиглагдсан алхам</span></header><p className="live-current">{lane.current}</p>
    <ol>{lane.milestones.map(p => <li key={p.id} data-state={p.state} data-group={p.group}><i /><div><strong title={PHASE_HELP[p.id]}>{p.label}</strong><small>{GROUP_LABELS[p.group]} · {{ pending: 'Хүлээж байна', active: 'Ажиллаж байна', done: 'Дууссан', error: 'Алдаа' }[p.state]}{p.endMs !== undefined ? ` · +${number(p.endMs)} мс` : p.startMs !== undefined ? ` · эхэлсэн +${number(p.startMs)} мс` : ''}</small></div></li>)}</ol>
    <details><summary>Бодитоор ажигласан API дуудлагууд ({lane.operations.reduce((sum, op) => sum + op.calls, 0)})</summary><p className="lab-measure-note">Бид Three.js-ийн render()-ийг дуудна. Three.js доорх функцуудыг ашиглан GPU-д ажил өгнө. Нэрийг нь хэвээр үлдээж, хийх ажлыг нь тайлбарлав.</p><div className="live-native-log">{lane.operations.length ? lane.operations.map(op => <div key={op.name}><code>{op.name} × {op.calls}</code><p>{CALL_HELP[op.name] ?? 'GPU-тай ажиллах API дуудлага.'}</p><small>{ms(op.cpuMs)} CPU · анх +{number(op.firstMs)} мс</small></div>) : <p>Одоогоор ажиглаагүй эсвэл браузер харуулаагүй.</p>}</div></details>
  </section>;
}
