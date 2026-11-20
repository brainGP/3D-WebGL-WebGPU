import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  Cpu,
  Download,
  Expand,
  ExternalLink,
  Gauge,
  Info,
  Layers3,
  Menu,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Share2,
  Triangle,
  Waves,
  X,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Progress,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Slider,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui';
import { PipelineLab } from './components/lab/PipelineLab';
import { BenchmarkScene } from './lib/benchmark-scene';
import {
  DEFAULT_DURATION_SECONDS,
  OBJECT_COUNTS,
  WARMUP_MS,
  type BenchmarkResult,
  type CaptureResult,
  type LiveMetrics,
  type RendererMode,
} from './lib/benchmark';

type TestPhase = 'idle' | 'initializing' | 'warmup' | 'measuring' | 'complete';
type WebGpuAvailability = 'checking' | 'available' | 'unavailable';
type PendingResult = {
  capture: CaptureResult;
  mode: RendererMode;
  backend: string;
  count: number;
  requestedDurationMs: number;
  resolution: string;
};

const HISTORY_KEY = 'web-graphics-lab:benchmark-history:v1';
const EMPTY_METRICS: LiveMetrics = {
  fps: 0,
  avgFps: 0,
  minFps: null,
  maxFps: null,
  frameMs: 0,
  calls: null,
  triangles: null,
  points: null,
  count: 500,
  backend: 'Not running',
  mode: 'webgl',
};
const colors = { webgl: '#71a9ff', webgpu: '#a78bfa' };
const chartTooltipStyle = {
  backgroundColor: '#111722',
  border: '1px solid #293345',
  borderRadius: '9px',
  color: '#edf2fa',
  fontSize: 12,
};

function isBenchmarkResult(value: unknown): value is BenchmarkResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<BenchmarkResult>;
  return typeof result.id === 'string'
    && (result.mode === 'webgl' || result.mode === 'webgpu')
    && typeof result.backend === 'string'
    && typeof result.count === 'number'
    && typeof result.avgFps === 'number'
    && typeof result.frameMs === 'number'
    && typeof result.durationMs === 'number'
    && typeof result.requestedDurationMs === 'number'
    && typeof result.resolution === 'string'
    && typeof result.recordedAt === 'string';
}

function readHistory(): { rows: BenchmarkResult[]; error: string | null } {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return { rows: [], error: null };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { rows: [], error: 'Saved benchmark history has an unexpected format.' };
    const rows = parsed.filter(isBenchmarkResult);
    return {
      rows,
      error: rows.length === parsed.length ? null : 'Some saved history entries were invalid and were skipped.',
    };
  } catch (error) {
    return {
      rows: [],
      error: `Could not read saved results: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function conditionKey(result: Pick<BenchmarkResult, 'count' | 'requestedDurationMs' | 'resolution'>) {
  return `${result.count}:${result.requestedDurationMs}:${result.resolution}`;
}

function conditionsMatch(a: BenchmarkResult, b: BenchmarkResult) {
  const durationTolerance = Math.max(250, a.requestedDurationMs * 0.05);
  return conditionKey(a) === conditionKey(b)
    && Math.abs(a.durationMs - b.durationMs) <= durationTolerance;
}

function formatValue(value: number | null | undefined, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : 'N/A';
}

function formatInteger(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : 'N/A';
}

function MetricCard({
  label,
  value,
  unit,
  icon: Icon,
  accent = 'blue',
  detail,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: typeof Activity;
  accent?: 'blue' | 'violet' | 'teal' | 'neutral';
  detail?: string;
}) {
  return (
    <Card className={`metric-card metric-${accent}`}>
      <CardContent className="metric-card-content">
        <div className="metric-label-row">
          <span>{label}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="icon-hint" aria-label={`About ${label}`}><CircleHelp size={13} /></button>
            </TooltipTrigger>
            <TooltipContent>{detail || label}</TooltipContent>
          </Tooltip>
        </div>
        <div className="metric-value-row">
          <div className="metric-value">{value}</div>
          {unit && <span className="metric-unit">{unit}</span>}
        </div>
        <div className="metric-icon"><Icon size={16} strokeWidth={1.8} /></div>
      </CardContent>
    </Card>
  );
}

function ChartEmpty({ text = 'Run a benchmark to populate this chart.' }: { text?: string }) {
  return <div className="chart-empty"><BarChart3 size={20} /><span>{text}</span></div>;
}

function ChartPanel({
  title,
  subtitle,
  children,
  className = '',
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={`chart-panel ${className}`}>
      <CardHeader className="chart-panel-header">
        <div><CardTitle>{title}</CardTitle><CardDescription>{subtitle}</CardDescription></div>
      </CardHeader>
      <CardContent className="chart-panel-content">{children}</CardContent>
    </Card>
  );
}

function App() {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BenchmarkScene | null>(null);
  const metricsHandlerRef = useRef<(metrics: LiveMetrics) => void>(() => undefined);
  const timersRef = useRef<number[]>([]);
  const activeBackendRef = useRef('Not running');
  const chartAtRef = useRef(0);
  const [historyState] = useState(readHistory);
  const [rows, setRows] = useState(historyState.rows);
  const [historyError, setHistoryError] = useState(historyState.error);
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [liveData, setLiveData] = useState<{ time: string; fps: number; frameMs: number }[]>([]);
  const [mode, setMode] = useState<RendererMode>('webgl');
  const [count, setCount] = useState<number>(500);
  const [durationSeconds, setDurationSeconds] = useState(DEFAULT_DURATION_SECONDS);
  const [phase, setPhase] = useState<TestPhase>('idle');
  const [paused, setPaused] = useState(false);
  const [showFpsOverlay, setShowFpsOverlay] = useState(true);
  const [availability, setAvailability] = useState<WebGpuAvailability>('checking');
  const [availabilityDetail, setAvailabilityDetail] = useState('');
  const [activeBackend, setActiveBackend] = useState('Not running');
  const [actualResolution, setActualResolution] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('Choose a renderer and run a benchmark.');
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState<PendingResult | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [chartTab, setChartTab] = useState('live');
  const [selectedStage, setSelectedStage] = useState(0);
  const [labBusy, setLabBusy] = useState(false);
  const handleLabBenchmark = useCallback((active: boolean) => {
    setLabBusy(active);
    if (active) { sceneRef.current?.setPaused(true); setPaused(true); }
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    });
    timersRef.current = [];
  }, []);

  const handleMetrics = useCallback((next: LiveMetrics) => {
    setMetrics(next);
    const now = performance.now();
    if (now - chartAtRef.current >= 500) {
      chartAtRef.current = now;
      setLiveData((current) => [
        ...current.slice(-39),
        { time: new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }), fps: next.fps, frameMs: next.frameMs },
      ]);
    }
  }, []);

  useEffect(() => {
    metricsHandlerRef.current = handleMetrics;
  }, [handleMetrics]);

  useEffect(() => {
    if (!canvasHostRef.current) return;
    const scene = new BenchmarkScene(canvasHostRef.current, (next) => metricsHandlerRef.current(next));
    sceneRef.current = scene;
    return () => {
      clearTimers();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [clearTimers]);

  useEffect(() => {
    if (phase !== 'warmup' && phase !== 'measuring') return;
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return;
      clearTimers();
      sceneRef.current?.finishCapture();
      setPending(null);
      setPhase('idle');
      setProgress(0);
      setStatusMessage('Capture canceled because this tab went into the background. Keep the tab visible and run the test again.');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [clearTimers, phase]);

  useEffect(() => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) {
      setAvailability('unavailable');
      setAvailabilityDetail('This browser does not expose the WebGPU API.');
      return;
    }
    let active = true;
    gpu.requestAdapter().then((adapter) => {
      if (!active) return;
      if (adapter) {
        setAvailability('available');
        setAvailabilityDetail('A WebGPU adapter is available to this browser.');
      } else {
        setAvailability('unavailable');
        setAvailabilityDetail('The browser exposes WebGPU, but no compatible GPU adapter was found.');
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setAvailability('unavailable');
      setAvailabilityDetail(`WebGPU adapter check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(rows));
      setHistoryError(null);
    } catch (error) {
      setHistoryError(`Could not save benchmark history: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [rows]);

  const pairedResults = useMemo(() => {
    const groups = new Map<string, { webgl: BenchmarkResult[]; webgpu: BenchmarkResult[] }>();
    for (const result of rows) {
      const key = conditionKey(result);
      const pair = groups.get(key) || { webgl: [], webgpu: [] };
      pair[result.mode].push(result);
      groups.set(key, pair);
    }
    return [...groups.values()].flatMap((group) => {
      const webglRuns = group.webgl.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      const webgpuRuns = group.webgpu.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      for (const webgl of webglRuns) {
        const webgpu = webgpuRuns.find((candidate) => conditionsMatch(webgl, candidate));
        if (webgpu) return [{ webgl, webgpu }];
      }
      return [];
    })
      .sort((a, b) => b.webgl.recordedAt.localeCompare(a.webgl.recordedAt));
  }, [rows]);

  const comparisonRows = useMemo(() => pairedResults.slice(0, 5).map(({ webgl, webgpu }) => ({
    count: webgl.count,
    label: `${webgl.count.toLocaleString()} · ${webgl.resolution}`,
    webgl: webgl.avgFps,
    webgpu: webgpu.avgFps,
  })), [pairedResults]);

  const selectedResults = useMemo(
    () => selection.map((id) => rows.find((row) => row.id === id)).filter((row): row is BenchmarkResult => !!row),
    [rows, selection],
  );
  const selectedConditionsMatch = selectedResults.length === 2
    && selectedResults[0].mode !== selectedResults[1].mode
    && conditionsMatch(selectedResults[0], selectedResults[1]);
  const selectedWebGL = selectedResults.find((result) => result.mode === 'webgl');
  const selectedWebGPU = selectedResults.find((result) => result.mode === 'webgpu');
  const latestWebGL = [...rows].reverse().find((result) => result.mode === 'webgl');
  const latestWebGPU = [...rows].reverse().find((result) => result.mode === 'webgpu');
  const latestPair = pairedResults[0];
  const isBusy = labBusy || phase === 'initializing' || phase === 'warmup' || phase === 'measuring';

  const endTest = useCallback((stopped = false) => {
    clearTimers();
    const capture = sceneRef.current?.finishCapture() || null;
    if (capture && capture.frames > 0) {
      if (capture.resolutionChanged) {
        setPending(null);
        setPhase('idle');
        setProgress(0);
        setStatusMessage('The drawing-buffer resolution changed during capture. This run was discarded; keep the viewport size fixed and try again.');
        return;
      }
      const nextPending: PendingResult = {
        capture,
        mode,
        backend: activeBackendRef.current,
        count,
        requestedDurationMs: durationSeconds * 1000,
        resolution: capture.resolution,
      };
      setPending(nextPending);
      setPhase('complete');
      setProgress(100);
      setStatusMessage(stopped
        ? `Capture stopped at ${formatValue(capture.durationMs / 1000)} s. Review the measured values before saving.`
        : 'Capture complete. Review the measurements, then record this result.');
    } else {
      setPending(null);
      setPhase('idle');
      setProgress(0);
      setStatusMessage(stopped ? 'Test stopped before the measurement window; no result was recorded.' : 'No frames were captured. Run the test again.');
    }
  }, [clearTimers, count, durationSeconds, mode]);

  const startBenchmark = async () => {
    if (!sceneRef.current) return;
    if (document.visibilityState === 'hidden') {
      const message = 'Bring this tab to the foreground before benchmarking so browser frame throttling does not distort the results.';
      setErrorMessage(message);
      setStatusMessage(message);
      return;
    }
    clearTimers();
    sceneRef.current.resetSession();
    setErrorMessage('');
    setPending(null);
    setLiveData([]);
    setProgress(0);
    setPaused(false);
    setMetrics({ ...EMPTY_METRICS, count, mode, backend: 'Initializing' });
    setPhase('initializing');
    setStatusMessage('Preparing a fresh scene and renderer…');
    activeBackendRef.current = 'Initializing';
    setActiveBackend('Initializing');

    try {
      if (mode === 'webgpu') {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
        if (!gpu) throw new Error('WebGPU is not available in this browser. You can still run the WebGL 2 benchmark.');
        const adapter = await gpu.requestAdapter();
        if (!adapter) throw new Error('No compatible WebGPU adapter was found. WebGL 2 remains available.');
      }
      const initialized = await sceneRef.current.initialize(mode, count);
      sceneRef.current.setCameraLocked(true);
      activeBackendRef.current = initialized.backend;
      setActiveBackend(initialized.backend);
      setActualResolution(initialized.resolution);
      setMetrics({ ...EMPTY_METRICS, count, mode, backend: initialized.backend });
      setPhase('warmup');
      setStatusMessage('Warm-up in progress. Frames are not included in the benchmark yet.');
      const warmupTimer = window.setTimeout(() => {
        sceneRef.current?.beginCapture();
        const captureStartedAt = performance.now();
        setPhase('measuring');
        setStatusMessage(`Measuring ${initialized.backend} for ${durationSeconds} seconds…`);
        const progressTimer = window.setInterval(() => {
          setProgress(Math.min(99, (performance.now() - captureStartedAt) / (durationSeconds * 1000) * 100));
        }, 500);
        const finishTimer = window.setTimeout(() => endTest(false), durationSeconds * 1000);
        timersRef.current.push(progressTimer, finishTimer);
      }, WARMUP_MS);
      timersRef.current.push(warmupTimer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      setStatusMessage('Renderer initialization failed. WebGL 2 remains available.');
      activeBackendRef.current = 'Unavailable';
      setActiveBackend('Unavailable');
      setPhase('idle');
      setPending(null);
    }
  };

  const stopBenchmark = () => {
    if (phase === 'warmup') {
      clearTimers();
      sceneRef.current?.finishCapture();
      setPhase('idle');
      setProgress(0);
      setStatusMessage('Stopped during warm-up; no measurement was recorded.');
      return;
    }
    if (phase === 'measuring') endTest(true);
  };

  const resetBenchmark = () => {
    clearTimers();
    sceneRef.current?.resetSession();
    setPhase('idle');
    setPaused(false);
    setPending(null);
    setProgress(0);
    setLiveData([]);
    activeBackendRef.current = 'Not running';
    setActiveBackend('Not running');
    setActualResolution('');
    setMetrics({ ...EMPTY_METRICS, count, mode });
    setStatusMessage('Benchmark reset. Recorded history was kept.');
  };

  const recordResult = () => {
    if (!pending) return;
    const { capture } = pending;
    const result: BenchmarkResult = {
      id: crypto.randomUUID(),
      mode: pending.mode,
      backend: pending.backend,
      count: pending.count,
      fps: capture.avgFps,
      avgFps: capture.avgFps,
      minFps: capture.minFps,
      maxFps: capture.maxFps,
      frameMs: capture.frameMs,
      calls: capture.calls,
      triangles: capture.triangles,
      points: capture.points,
      durationMs: capture.durationMs,
      requestedDurationMs: pending.requestedDurationMs,
      resolution: pending.resolution,
      recordedAt: new Date().toISOString(),
    };
    setRows((current) => [...current, result]);
    setPending(null);
    setPhase('idle');
    setStatusMessage(`${result.backend} result recorded from ${capture.frames.toLocaleString()} measured frames.`);
  };

  const toggleSelection = (id: string) => {
    setSelection((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : current.length < 2 ? [...current, id] : [current[1], id]);
  };

  const exportCsv = () => {
    const headers = [
      'renderer', 'actual_backend', 'object_count', 'average_fps', 'minimum_fps', 'maximum_fps',
      'average_frame_time_ms', 'draw_calls_per_frame', 'triangles_per_frame', 'points_per_frame',
      'actual_duration_ms', 'requested_duration_ms', 'drawing_buffer_resolution', 'recorded_at',
    ];
    const escapeCsv = (value: string | number | null) => {
      const text = value === null ? '' : String(value);
      return `"${text.replaceAll('"', '""')}"`;
    };
    const lines = [
      headers.map(escapeCsv).join(','),
      ...rows.map((row) => [
        row.mode, row.backend, row.count, row.avgFps, row.minFps, row.maxFps, row.frameMs,
        row.calls, row.triangles, row.points, row.durationMs, row.requestedDurationMs,
        row.resolution, row.recordedAt,
      ].map(escapeCsv).join(',')),
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'web-graphics-lab-benchmark.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleFullscreen = async () => {
    const host = canvasHostRef.current?.parentElement;
    if (!host) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await host.requestFullscreen();
    } catch (error) {
      setErrorMessage(`Could not change fullscreen mode: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const comparisonSummary = latestPair
    ? `At ${latestPair.webgl.count.toLocaleString()} instances, WebGL measured ${formatValue(latestPair.webgl.avgFps)} FPS and WebGPU measured ${formatValue(latestPair.webgpu.avgFps)} FPS.`
    : 'Record WebGL and WebGPU runs under matching conditions to see a measured comparison.';

  const stageDetails = [
    { title: 'JavaScript / Three.js', body: 'Your application describes a scene, camera, geometry, and materials through Three.js objects.' },
    { title: 'Renderer', body: 'The selected Three.js renderer translates scene data into commands for its graphics backend.' },
    { title: 'Graphics API', body: 'WebGL 2 or WebGPU provides the browser-facing interface used to communicate with the graphics device.' },
    { title: 'GPU', body: 'The graphics processor executes work submitted through the API. Hardware, drivers, and power state influence performance.' },
    { title: 'Framebuffer', body: 'The renderer writes pixels into a drawing buffer. This lab records its actual pixel dimensions for comparison.' },
    { title: 'Browser screen', body: 'The browser composites the rendered image with the rest of the page and presents it on the display.' },
  ];

  return (
    <TooltipProvider delayDuration={250}>
      <div className="app-shell">
        <header className="topbar">
          <nav className="main-nav" aria-label="Main navigation">
            <a className="nav-active" href="#laboratory">Laboratory</a>
            <a href="#benchmark">Benchmark</a>
            <a href="#technology">Technology</a>
            <a href="#results">Results</a>
            <a href="#about">About</a>
          </nav>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="icon" className="mobile-menu-trigger" aria-label="Open navigation menu"><Menu size={15} /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild><a href="#benchmark">Benchmark</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="#technology">Technology</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="#results">Results</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="#about">About</a></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="topbar-right">
            <a className="github-link" href="https://threejs.org/" target="_blank" rel="noreferrer" aria-label="Three.js documentation">
              <ExternalLink size={16} />
            </a>
          </div>
        </header>

        <main id="top" className="page-content">
          <PipelineLab suspended={phase === 'initializing' || phase === 'warmup' || phase === 'measuring'} onBenchmarkActive={handleLabBenchmark} />
          <section className="intro" id="benchmark">
            <div className="intro-copy">
              <div className="eyebrow"><span className="eyebrow-line" /> INTERACTIVE PERFORMANCE STUDY</div>
              <p>WebGL vs WebGPU — Interactive Performance Benchmark</p>
            </div>
            <div className="intro-meta">

              <span className="intro-separator" />
              <span>Three.js · Instanced geometry</span>
            </div>
          </section>

          {(errorMessage || historyError) && (
            <Alert variant={errorMessage ? 'destructive' : 'warning'} className="notice-alert">
              <Info size={16} />
              <div>
                <AlertTitle>{errorMessage ? 'Renderer or benchmark notice' : 'History storage notice'}</AlertTitle>
                <AlertDescription>{errorMessage || historyError}</AlertDescription>
              </div>
              {errorMessage && <Button variant="ghost" size="icon" className="notice-close" onClick={() => setErrorMessage('')} aria-label="Dismiss error"><X size={15} /></Button>}
            </Alert>
          )}
          {mode === 'webgpu' && availability === 'unavailable' && !errorMessage && (
            <Alert variant="warning" className="notice-alert">
              <Info size={16} />
              <div>
                <AlertTitle>WebGPU is not ready on this device</AlertTitle>
                <AlertDescription>{availabilityDetail} Switch to WebGL 2 to run the benchmark on this device.</AlertDescription>
              </div>
            </Alert>
          )}

          <section className="metric-grid" aria-label="Live performance metrics">
            <MetricCard label="Current FPS" value={metrics.fps ? formatValue(metrics.fps) : '—'} unit="fps" icon={Gauge} accent="blue" detail="Frames per second over the recent rolling window." />
            <MetricCard label="Average FPS" value={metrics.avgFps ? formatValue(metrics.avgFps) : '—'} unit="fps" icon={Activity} accent="violet" detail="Average frame rate during the current capture. Outside a capture this follows the rolling FPS." />
            <MetricCard label="Frame time" value={metrics.frameMs ? formatValue(metrics.frameMs, 2) : '—'} unit="ms" icon={Waves} accent="teal" detail="Average time between rendered frames in the rolling sample window." />
            <MetricCard label="Draw calls" value={formatValue(metrics.calls, 0)} unit="/ frame" icon={Share2} detail="Renderer-reported draw submissions for the latest rendered frame." />
            <MetricCard label="Triangles" value={formatInteger(metrics.triangles)} unit="/ frame" icon={Triangle} accent="violet" detail="Renderer-reported triangle primitives in the latest rendered frame." />
            <MetricCard label="Instances" value={metrics.count.toLocaleString()} unit="cubes" icon={Box} accent="teal" detail="Instanced cubes in the current scene; instances share geometry and material." />
            <MetricCard label="Min / max FPS" value={metrics.minFps === null ? '—' : `${formatValue(metrics.minFps)} / ${formatValue(metrics.maxFps)}`} unit="fps" icon={ArrowUpRight} detail="Lowest and highest recent one-second rolling FPS values during capture." />
            <MetricCard label="Active backend" value={activeBackend} icon={Cpu} accent={activeBackend === 'WebGPU' ? 'violet' : 'blue'} detail="Actual initialized backend. A WebGL fallback is never labeled as WebGPU." />
          </section>

          <section className="meaning-strip" aria-labelledby="meaning-title">
            <div className="meaning-heading"><span className="meaning-icon"><Info size={15} /></span><strong id="meaning-title">What does this mean?</strong></div>
            <div className="meaning-items">
              <span><b>FPS</b> frames shown each second</span><span><b>Frame time</b> time to render a frame</span>
              <span><b>Draw calls</b> graphics submissions per frame</span><span><b>Triangles</b> geometry sent to the GPU</span>
            </div>
          </section>

          <section className="workspace-grid">
            <Card className="viewport-card">
              <div className="viewport-toolbar">
                <div className="viewport-title">
                  <span className={`backend-swatch ${mode}`} />
                  <div><strong>Live scene</strong><span>{activeBackend} · {count.toLocaleString()} instanced cubes</span></div>
                </div>
                <div className="viewport-actions">
                  <Badge variant={phase === 'measuring' ? 'default' : 'outline'} className="phase-badge">
                    <span className={`status-dot ${phase === 'measuring' ? 'available' : ''}`} />
                    {phase === 'measuring' ? 'MEASURING' : phase === 'warmup' ? 'WARM-UP' : phase === 'complete' ? 'CAPTURED' : phase === 'initializing' ? 'STARTING' : paused ? 'PAUSED' : 'READY'}
                  </Badge>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => { const next = !paused; setPaused(next); sceneRef.current?.setPaused(next); setStatusMessage(next ? 'Rendering paused. Live metrics stop updating until resumed.' : 'Rendering resumed.'); }} disabled={isBusy || activeBackend === 'Not running' || activeBackend === 'Unavailable'} aria-label={paused ? 'Resume scene' : 'Pause scene'}>{paused ? <Play size={15} /> : <Pause size={15} />}</Button></TooltipTrigger><TooltipContent>{paused ? 'Resume rendering' : 'Pause rendering'}</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => { sceneRef.current?.resetCamera(); }} disabled={isBusy} aria-label="Reset camera"><RotateCcw size={15} /></Button></TooltipTrigger><TooltipContent>Reset camera</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => void toggleFullscreen()} disabled={isBusy} aria-label="Toggle fullscreen"><Maximize2 size={15} /></Button></TooltipTrigger><TooltipContent>Toggle fullscreen</TooltipContent></Tooltip>
                </div>
              </div>
              <div className="viewport-stage">
                <div ref={canvasHostRef} className="canvas-host" />
                <div className="scene-vignette" />
                {showFpsOverlay && metrics.fps > 0 && (
                  <div className="canvas-hud"><span className="hud-dot" />{formatValue(metrics.fps)} FPS <span>·</span> {activeBackend}</div>
                )}
                <div className="canvas-help">Drag to orbit <span>·</span> Scroll to zoom <span>·</span> Right-drag to pan</div>
                {phase === 'warmup' && <div className="warmup-overlay"><span className="spinner" /><strong>Warming up renderer</strong><span>Discarding startup frames for a fairer measurement</span></div>}
              </div>
              <div className="viewport-footer">
                <div className="viewport-footer-left">
                  <span><span className="legend-dot webgl-dot" /> WebGL 2</span>
                  <span><span className="legend-dot webgpu-dot" /> WebGPU</span>
                  <span className="viewport-resolution">{actualResolution || 'Resolution will be measured on start'}</span>
                </div>
                <label className="switch-label" htmlFor="fps-overlay">FPS overlay <Switch id="fps-overlay" checked={showFpsOverlay} onCheckedChange={setShowFpsOverlay} /></label>
              </div>
            </Card>

            <Card className="control-card">
              <CardHeader className="control-card-header">
                <div className="section-kicker">EXPERIMENT SETUP</div>
                <CardTitle>Benchmark controls</CardTitle>
                <CardDescription>Run one backend at a time. Repeat with the same conditions to compare.</CardDescription>
              </CardHeader>
              <CardContent className="control-content">
                <label className="field-label" htmlFor="renderer-select">Renderer</label>
                <Select value={mode} onValueChange={(value) => setMode(value as RendererMode)} disabled={isBusy}>
                  <SelectTrigger id="renderer-select"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webgl"><span className="select-renderer"><span className="legend-dot webgl-dot" />WebGLRenderer <small>WebGL 2</small></span></SelectItem>
                    <SelectItem value="webgpu"><span className="select-renderer"><span className="legend-dot webgpu-dot" />WebGPURenderer <small>WebGPU</small></span></SelectItem>
                  </SelectContent>
                </Select>

                <div className="field-row field-row-between">
                  <label className="field-label" htmlFor="instance-count">Instance count</label>
                  <Badge variant="secondary">{count.toLocaleString()} cubes</Badge>
                </div>
                <Select value={String(count)} onValueChange={(value) => setCount(Number(value))} disabled={isBusy}>
                  <SelectTrigger id="instance-count"><SelectValue /></SelectTrigger>
                  <SelectContent>{OBJECT_COUNTS.map((value) => <SelectItem key={value} value={String(value)}>{value.toLocaleString()} instances</SelectItem>)}</SelectContent>
                </Select>

                <div className="field-row field-row-between duration-label">
                  <label className="field-label">Measurement duration</label>
                  <span className="duration-value">{durationSeconds} sec</span>
                </div>
                <Slider value={[durationSeconds]} min={5} max={20} step={5} onValueChange={(value) => setDurationSeconds(value[0] ?? DEFAULT_DURATION_SECONDS)} disabled={isBusy} aria-label="Measurement duration in seconds" />
                <div className="slider-marks"><span>5 s</span><span>10 s</span><span>15 s</span><span>20 s</span></div>

                <div className="condition-note"><Info size={14} /><span>Every run rebuilds the same camera, geometry, animation, and scene. Match resolution and duration when comparing.</span></div>
                <Separator className="control-separator" />

                <div className="run-controls">
                  <Button className="run-button" onClick={() => void startBenchmark()} disabled={isBusy || !!pending}>
                    {phase === 'initializing' ? <span className="spinner spinner-small" /> : <Play size={15} fill="currentColor" />}
                    {phase === 'initializing' ? 'Initializing…' : 'Run benchmark'}
                    {!isBusy && <ChevronRight size={16} />}
                  </Button>
                  <Button variant="secondary" onClick={stopBenchmark} disabled={phase !== 'warmup' && phase !== 'measuring'}><X size={15} /> Stop</Button>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={resetBenchmark} disabled={phase === 'initializing' || !!pending} aria-label="Reset benchmark"><RotateCcw size={14} /></Button></TooltipTrigger><TooltipContent>Reset benchmark · recorded history is kept</TooltipContent></Tooltip>
                </div>
                {(phase === 'warmup' || phase === 'measuring') && (
                  <div className="progress-block">
                    <div className="progress-label"><span>{phase === 'warmup' ? 'Warm-up · 2 seconds' : 'Measured capture'}</span><span>{Math.round(progress)}%</span></div>
                    <Progress value={progress} />
                  </div>
                )}
                <div className="benchmark-status" aria-live="polite">
                  <span className={`status-dot ${phase === 'measuring' ? 'available' : ''}`} />{statusMessage}
                </div>
                {phase === 'complete' && pending && (
                  <div className="pending-result">
                    <div><Check size={15} /><strong>Capture ready</strong><span>{formatValue(pending.capture.avgFps)} avg FPS · {pending.capture.frames.toLocaleString()} frames</span></div>
                    <Button size="sm" onClick={recordResult}><Check size={13} /> Record result</Button>
                  </div>
                )}
                {phase !== 'complete' && pending && <Button variant="secondary" className="record-button" onClick={recordResult}>Record result</Button>}
                <div className="fairness-footnote">Browser, GPU, power mode, temperature, and background apps can affect results.</div>
              </CardContent>
            </Card>
          </section>

          <section className="comparison-section" aria-labelledby="comparison-heading">
            <div className="section-heading">
              <div><div className="section-kicker">MEASURED SIDE BY SIDE</div><h2 id="comparison-heading">Compare results</h2></div>
              <Badge variant="outline"><Layers3 size={13} /> Matched runs only</Badge>
            </div>
            <div className="comparison-grid">
              {[{ label: 'WebGL 2', result: latestWebGL, mode: 'webgl' as const }, { label: 'WebGPU', result: latestWebGPU, mode: 'webgpu' as const }].map(({ label, result, mode: resultMode }) => (
                <Card key={label} className={`result-snapshot ${resultMode}`}>
                  <div className="snapshot-head"><span className={`legend-dot ${resultMode}-dot`} />{label}<span className="snapshot-latest">LATEST RECORDED</span></div>
                  {result ? (
                    <>
                      <div className="snapshot-fps">{formatValue(result.avgFps)}<small> FPS</small></div>
                      <div className="snapshot-meta">{result.count.toLocaleString()} instances <span>·</span> {result.resolution} <span>·</span> {formatValue(result.durationMs / 1000)} s measured</div>
                    </>
                  ) : <div className="snapshot-empty">No recorded measurement yet</div>}
                </Card>
              ))}
            </div>
            <div className={`comparison-summary ${latestPair ? 'matched' : ''}`}>
              <span className="summary-icon"><BarChart3 size={17} /></span>
              <span>{comparisonSummary}</span>
              {latestPair && <Badge variant="secondary">{latestPair.webgl.avgFps >= latestPair.webgpu.avgFps ? 'WebGL 2' : 'WebGPU'} higher in this run</Badge>}
            </div>
            {rows.length > 0 && !latestPair && (
              <p className="comparison-caveat">The latest runs do not share the same object count, requested duration, drawing-buffer resolution, and a close measured duration. They are shown individually, not ranked against each other.</p>
            )}
          </section>

          <section className="charts-section" aria-labelledby="charts-heading">
            <div className="section-heading charts-heading">
              <div><div className="section-kicker">FRAME-BY-FRAME TELEMETRY</div><h2 id="charts-heading">Performance charts</h2></div>
              <Tabs value={chartTab} onValueChange={setChartTab} className="chart-tabs">
                <TabsList><TabsTrigger value="live"><Activity size={13} />Live</TabsTrigger><TabsTrigger value="compare"><BarChart3 size={13} />Comparison</TabsTrigger><TabsTrigger value="history"><Layers3 size={13} />History</TabsTrigger></TabsList>
                <TabsContent value="live" className="chart-tab-placeholder" />
                <TabsContent value="compare" className="chart-tab-placeholder" />
                <TabsContent value="history" className="chart-tab-placeholder" />
              </Tabs>
            </div>
            <Tabs value={chartTab} onValueChange={setChartTab} className="charts-tabs-content">
              <TabsContent value="live">
                <ChartPanel title="Live frame rate" subtitle="Recent rolling samples · refreshed twice per second" className="wide-chart">
                  {liveData.length > 1 ? <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={liveData} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                      <CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} />
                      <XAxis dataKey="time" tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={32} />
                      <YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
                      <ChartTooltip contentStyle={chartTooltipStyle} formatter={(value) => [`${formatValue(Number(value))} fps`, 'FPS']} />
                      <Line type="monotone" dataKey="fps" stroke={colors[mode]} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer> : <ChartEmpty text="Start a renderer to see live FPS samples." />}
                </ChartPanel>
                <div className="chart-pair-grid">
                  <ChartPanel title="Frame time" subtitle="Live milliseconds per frame">
                    {liveData.length > 1 ? <ResponsiveContainer width="100%" height={160}><LineChart data={liveData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}><CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" hide /><YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={48} /><ChartTooltip contentStyle={chartTooltipStyle} formatter={(value) => [`${formatValue(Number(value), 2)} ms`, 'Frame time']} /><Line type="monotone" dataKey="frameMs" stroke="#55d6c2" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <ChartEmpty text="Live frame-time samples appear here." />}
                  </ChartPanel>
                  <ChartPanel title="FPS by renderer" subtitle="Latest matching condition pairs only">
                    {comparisonRows.length ? <ResponsiveContainer width="100%" height={160}><BarChart data={comparisonRows} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}><CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="count" tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={48} /><ChartTooltip contentStyle={chartTooltipStyle} formatter={(value) => [`${formatValue(Number(value))} fps`]} /><Legend wrapperStyle={{ fontSize: 10, color: '#aab4c3' }} /><Bar dataKey="webgl" name="WebGL 2" fill={colors.webgl} radius={[3, 3, 0, 0]} /><Bar dataKey="webgpu" name="WebGPU" fill={colors.webgpu} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer> : <ChartEmpty text="Matching WebGL and WebGPU runs are needed." />}
                  </ChartPanel>
                </div>
              </TabsContent>
              <TabsContent value="compare">
                <div className="chart-pair-grid comparison-charts">
                  <ChartPanel title="Average FPS comparison" subtitle="Matched count, duration, and resolution">
                    {comparisonRows.length ? <ResponsiveContainer width="100%" height={230}><BarChart data={comparisonRows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}><CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="count" tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={48} /><ChartTooltip contentStyle={chartTooltipStyle} formatter={(value) => [`${formatValue(Number(value))} fps`]} /><Legend wrapperStyle={{ fontSize: 11, color: '#aab4c3' }} /><Bar dataKey="webgl" name="WebGL 2" fill={colors.webgl} radius={[4, 4, 0, 0]} /><Bar dataKey="webgpu" name="WebGPU" fill={colors.webgpu} radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer> : <ChartEmpty text="Matching pairs will populate this chart." />}
                  </ChartPanel>
                  <ChartPanel title="Frame time comparison" subtitle="Lower frame time can mean smoother rendering">
                    {pairedResults.length ? <ResponsiveContainer width="100%" height={230}><BarChart data={pairedResults.slice(0, 5).map(({ webgl, webgpu }) => ({ count: webgl.count, webgl: webgl.frameMs, webgpu: webgpu.frameMs }))} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}><CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="count" tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={48} /><ChartTooltip contentStyle={chartTooltipStyle} formatter={(value) => [`${formatValue(Number(value), 2)} ms`]} /><Legend wrapperStyle={{ fontSize: 11, color: '#aab4c3' }} /><Bar dataKey="webgl" name="WebGL 2" fill={colors.webgl} radius={[4, 4, 0, 0]} /><Bar dataKey="webgpu" name="WebGPU" fill={colors.webgpu} radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer> : <ChartEmpty text="Matching pairs will populate this chart." />}
                  </ChartPanel>
                  <ChartPanel title="Draw calls per frame" subtitle="Renderer-reported calls, averaged across capture">
                    {pairedResults.some(({ webgl, webgpu }) => webgl.calls !== null && webgpu.calls !== null) ? <ResponsiveContainer width="100%" height={230}><BarChart data={pairedResults.filter(({ webgl, webgpu }) => webgl.calls !== null && webgpu.calls !== null).slice(0, 5).map(({ webgl, webgpu }) => ({ count: webgl.count, webgl: webgl.calls, webgpu: webgpu.calls }))} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}><CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="count" tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={48} /><ChartTooltip contentStyle={chartTooltipStyle} formatter={(value) => [`${formatValue(Number(value), 0)} calls`]} /><Legend wrapperStyle={{ fontSize: 11, color: '#aab4c3' }} /><Bar dataKey="webgl" name="WebGL 2" fill={colors.webgl} radius={[4, 4, 0, 0]} /><Bar dataKey="webgpu" name="WebGPU" fill={colors.webgpu} radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer> : <ChartEmpty text="Draw-call metrics are unavailable or no matched pair exists." />}
                  </ChartPanel>
                  <ChartPanel title="Performance vs. object count" subtitle="FPS at each matched test condition">
                    {comparisonRows.length ? <ResponsiveContainer width="100%" height={230}><LineChart data={[...comparisonRows].reverse()} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}><CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="count" tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} /><YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={48} /><ChartTooltip contentStyle={chartTooltipStyle} formatter={(value) => [`${formatValue(Number(value))} fps`]} /><Legend wrapperStyle={{ fontSize: 11, color: '#aab4c3' }} /><Line type="monotone" dataKey="webgl" name="WebGL 2" stroke={colors.webgl} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} /><Line type="monotone" dataKey="webgpu" name="WebGPU" stroke={colors.webgpu} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <ChartEmpty text="Matched runs at different object counts will appear here." />}
                  </ChartPanel>
                </div>
              </TabsContent>
              <TabsContent value="history">
                <ChartPanel title="Benchmark history" subtitle="Recorded average FPS · points are not cross-condition comparisons" className="wide-chart">
                  {rows.length ? <ResponsiveContainer width="100%" height={270}><LineChart data={rows.map((row, index) => ({ index: index + 1, fps: row.avgFps, mode: row.mode, count: row.count, timestamp: row.recordedAt }))} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}><CartesianGrid stroke="#202a39" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="index" tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} label={{ value: 'Recorded run', position: 'insideBottom', offset: -3, fill: '#8793a7', fontSize: 10 }} /><YAxis tick={{ fill: '#8793a7', fontSize: 10 }} tickLine={false} axisLine={false} width={48} /><ChartTooltip contentStyle={chartTooltipStyle} labelFormatter={(label) => `Run ${label}`} formatter={(value, _name, item) => [`${formatValue(Number(value))} fps · ${(item.payload as { count: number }).count.toLocaleString()} objects`, ((item.payload as { mode: RendererMode }).mode === 'webgpu' ? 'WebGPU' : 'WebGL 2')]} /><Line type="monotone" dataKey="fps" stroke="#80a6ff" strokeWidth={2} dot={(props) => <circle cx={props.cx} cy={props.cy} r={4} fill={props.payload.mode === 'webgpu' ? colors.webgpu : colors.webgl} stroke="#111722" strokeWidth={2} />} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <ChartEmpty />}
                </ChartPanel>
              </TabsContent>
            </Tabs>
          </section>

          <section className="results-section" id="results" aria-labelledby="results-heading">
            <div className="section-heading results-heading">
              <div><div className="section-kicker">YOUR EXPERIMENTS</div><h2 id="results-heading">Benchmark history <Badge variant="secondary">{rows.length}</Badge></h2></div>
              <div className="results-actions">
                <span className="selection-hint">{selection.length}/2 selected</span>
                <Button variant="secondary" size="sm" disabled={selection.length !== 2} onClick={() => setCompareOpen(true)}><BarChart3 size={14} />Compare selected</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Expand size={14} /> Actions</Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={exportCsv} disabled={!rows.length}><Download size={14} />Export CSV</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="destructive-item" onSelect={() => setClearOpen(true)} disabled={!rows.length}><X size={14} />Clear history</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <Card className="history-card">
              {rows.length ? (
                <ScrollArea className="history-scroll">
                  <Table>
                    <TableHeader><TableRow><TableHead className="select-col">Compare</TableHead><TableHead>Renderer</TableHead><TableHead>Backend</TableHead><TableHead>Instances</TableHead><TableHead>Avg FPS</TableHead><TableHead>Frame time</TableHead><TableHead>Draw calls</TableHead><TableHead>Triangles</TableHead><TableHead>Duration</TableHead><TableHead>Recorded</TableHead></TableRow></TableHeader>
                    <TableBody>{[...rows].reverse().map((row) => (
                      <TableRow key={row.id} data-selected={selection.includes(row.id)}>
                        <TableCell className="select-col"><button className={`row-check ${selection.includes(row.id) ? 'checked' : ''}`} onClick={() => toggleSelection(row.id)} aria-label={`${selection.includes(row.id) ? 'Remove' : 'Add'} ${row.backend} result from comparison`}>{selection.includes(row.id) && <Check size={12} />}</button></TableCell>
                        <TableCell><Badge variant={row.mode === 'webgpu' ? 'webgpu' : 'default'}><span className={`legend-dot ${row.mode}-dot`} />{row.mode === 'webgpu' ? 'WebGPU' : 'WebGL 2'}</Badge></TableCell>
                        <TableCell className="muted-cell">{row.backend}</TableCell><TableCell>{row.count.toLocaleString()}</TableCell>
                        <TableCell className="table-fps">{formatValue(row.avgFps)}</TableCell><TableCell>{formatValue(row.frameMs, 2)} ms</TableCell>
                        <TableCell>{formatValue(row.calls, 1)}</TableCell><TableCell>{formatValue(row.triangles, 0)}</TableCell>
                        <TableCell>{formatValue(row.durationMs / 1000)} s</TableCell><TableCell className="muted-cell">{new Date(row.recordedAt).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </ScrollArea>
              ) : (
                <div className="history-empty"><span className="empty-icon"><Layers3 size={18} /></span><strong>No benchmark runs yet</strong><p>Complete a measured run and record it to start your experiment history.</p><Button variant="secondary" size="sm" onClick={() => document.getElementById('benchmark')?.scrollIntoView({ behavior: 'smooth' })}>Go to benchmark <ArrowRight size={14} /></Button></div>
              )}
            </Card>
            <p className="history-note"><Info size={13} /> Results are saved in this browser. Export CSV to keep a copy or analyze measurements elsewhere.</p>
          </section>

          <section className="technology-section" id="technology" aria-labelledby="technology-heading">
            <div className="section-heading">
              <div><div className="section-kicker">THE APIS BEHIND THE PIXELS</div><h2 id="technology-heading">Two ways to talk to a GPU</h2></div>
              <p className="section-lead">Both renderers draw the same Three.js scene. They differ in the browser graphics API and renderer implementation beneath it.</p>
            </div>
            <div className="technology-cards">
              <Card className="technology-card webgl">
                <CardHeader><Badge><span className="legend-dot webgl-dot" /> ESTABLISHED STANDARD</Badge><CardTitle>WebGL 2</CardTitle><CardDescription>Dependable, broadly available browser graphics.</CardDescription></CardHeader>
                <CardContent><ul><li>Built on OpenGL ES 3.0 concepts and commands.</li><li>Three.js <code>WebGLRenderer</code> uses WebGL 2 in current Three.js releases.</li><li>Graphics work is driven by shaders, buffers, textures, and draw calls.</li><li>Does not expose a general-purpose compute pipeline.</li></ul></CardContent>
              </Card>
              <Card className="technology-card webgpu">
                <CardHeader><Badge variant="webgpu"><span className="legend-dot webgpu-dot" /> MODERN GRAPHICS API</Badge><CardTitle>WebGPU</CardTitle><CardDescription>Newer API with explicit resources and compute support.</CardDescription></CardHeader>
                <CardContent><ul><li>Designed around explicit devices, pipelines, bind groups, and command encoding.</li><li>Supports graphics and general-purpose compute workloads.</li><li>Three.js <code>WebGPURenderer</code> can use WebGPU or a WebGL fallback.</li><li>Availability depends on browser, operating system, and GPU support.</li></ul></CardContent>
              </Card>
            </div>

            <Card className="comparison-table-card">
              <CardHeader><CardTitle>At a glance</CardTitle><CardDescription>A practical overview—not a claim that one API is always faster.</CardDescription></CardHeader>
              <CardContent className="table-card-content">
                <Table>
                  <TableHeader><TableRow><TableHead>Topic</TableHead><TableHead><span className="table-heading-color webgl-text">WebGL 2</span></TableHead><TableHead><span className="table-heading-color webgpu-text">WebGPU</span></TableHead></TableRow></TableHeader>
                  <TableBody>
                    <TableRow><TableCell className="topic-cell">Architecture</TableCell><TableCell>Established browser API influenced by OpenGL ES.</TableCell><TableCell>Modern API with explicit devices, resources, and command submission.</TableCell></TableRow>
                    <TableRow><TableCell className="topic-cell">Rendering pipeline</TableCell><TableCell>Shaders, GPU state, and draw calls.</TableCell><TableCell>Pipeline objects, bind groups, and encoded command buffers.</TableCell></TableRow>
                    <TableRow><TableCell className="topic-cell">GPU resources</TableCell><TableCell>Resource bindings are managed through WebGL state.</TableCell><TableCell>Resource usage and binding are described more explicitly.</TableCell></TableRow>
                    <TableRow><TableCell className="topic-cell">Compute</TableCell><TableCell>No general-purpose compute shader pipeline.</TableCell><TableCell>Compute pipelines are part of the API.</TableCell></TableRow>
                    <TableRow><TableCell className="topic-cell">Browser support</TableCell><TableCell>Widely available across modern browsers and devices.</TableCell><TableCell>Growing, but depends on browser, OS, and adapter support.</TableCell></TableRow>
                    <TableRow><TableCell className="topic-cell">Developer complexity</TableCell><TableCell>Lower-level than many frameworks; common tooling and examples.</TableCell><TableCell>More explicit resource and pipeline setup; robust validation model.</TableCell></TableRow>
                    <TableRow><TableCell className="topic-cell">Typical use cases</TableCell><TableCell>Interactive 3D, visualization, games, and broad reach.</TableCell><TableCell>Modern 3D, compute workloads, and explicit GPU control.</TableCell></TableRow>
                    <TableRow><TableCell className="topic-cell">Limitations</TableCell><TableCell>Older API model; no native compute pipeline.</TableCell><TableCell>Availability varies; ecosystem and browser support continue to mature.</TableCell></TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Accordion type="single" collapsible className="technical-accordion">
              <AccordionItem value="details">
                <AccordionTrigger><span><Cpu size={15} /> Technical details</span></AccordionTrigger>
                <AccordionContent>
                  <p>These are APIs, not GPU vendors or isolated performance tiers. A browser implementation translates API commands through its driver stack; the same GPU may execute both paths. Three.js also uses different renderer implementations, and its WebGPU renderer may select a WebGL backend when WebGPU is unavailable. This lab checks the actual backend and refuses to record a fallback run as WebGPU.</p>
                  <p>The measured values describe this particular instanced-cube workload, browser, device, and moment. They do not predict every application. WebGPU's compute facilities are not exercised by this rendering benchmark.</p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>

          <section className="pipeline-section" id="about" aria-labelledby="pipeline-heading">
            <div className="section-heading">
              <div><div className="section-kicker">FROM SCENE TO SCREEN</div><h2 id="pipeline-heading">How rendering works</h2></div>
              <p className="section-lead">Select or hover a stage to see its role in the path from application code to displayed pixels.</p>
            </div>
            <Card className="pipeline-card">
              <CardContent className="pipeline-content">
                <div className="pipeline-shared">
                  <div className="pipeline-node app-node"><span className="pipeline-icon"><Box size={17} /></span><strong>JavaScript</strong><small>Three.js scene</small></div>
                  <ArrowRight className="pipeline-arrow" size={18} />
                  <div className="pipeline-branches">
                    <div><span className="branch-label webgl-text"><i /> WebGL path</span><span className="pipeline-step">WebGLRenderer</span><ArrowRight size={15} className="pipeline-arrow" /><span className="pipeline-step webgl-step">WebGL 2</span></div>
                    <div><span className="branch-label webgpu-text"><i /> WebGPU path</span><span className="pipeline-step">WebGPURenderer</span><ArrowRight size={15} className="pipeline-arrow" /><span className="pipeline-step webgpu-step">WebGPU</span></div>
                  </div>
                  <ArrowRight className="pipeline-arrow" size={18} />
                  <div className="pipeline-node gpu-node"><span className="pipeline-icon"><Cpu size={17} /></span><strong>GPU</strong><small>Execute commands</small></div>
                  <ArrowRight className="pipeline-arrow" size={18} />
                  <div className="pipeline-node output-node"><span className="pipeline-icon"><Expand size={17} /></span><strong>Framebuffer</strong><small>Rendered pixels</small></div>
                  <ArrowRight className="pipeline-arrow" size={18} />
                  <div className="pipeline-node output-node"><span className="pipeline-icon"><Waves size={17} /></span><strong>Screen</strong><small>Browser display</small></div>
                </div>
                <Separator />
                <div className="pipeline-explainer"><span className="pipeline-explainer-icon"><Info size={16} /></span><div><strong>{stageDetails[selectedStage].title}</strong><p>{stageDetails[selectedStage].body}</p></div></div>
                <div className="pipeline-stage-buttons">
                  {stageDetails.map((stage, index) => (
                    <Tooltip key={stage.title}>
                      <TooltipTrigger asChild><button onClick={() => setSelectedStage(index)} className={`pipeline-stage-button ${selectedStage === index ? 'selected' : ''}`}><span>{String(index + 1).padStart(2, '0')}</span>{stage.title}</button></TooltipTrigger>
                      <TooltipContent>{stage.body}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </CardContent>
            </Card>
            <p className="pipeline-caption"><span className="webgl-text">WebGLRenderer → WebGL 2</span><span>and</span><span className="webgpu-text">WebGPURenderer → WebGPU</span><span>both end at the same browser display.</span></p>
          </section>

          <section className="presentation-note">
            <div className="presentation-icon"><Info size={17} /></div>
            <div><strong>For a fair classroom demonstration</strong><p>Use one browser and device, keep the same object count and resolution, let each run warm up, then record multiple WebGL and WebGPU runs. Close GPU-heavy apps and report the conditions alongside your results.</p></div>
            <Button variant="outline" size="sm" onClick={() => document.getElementById('benchmark')?.scrollIntoView({ behavior: 'smooth' })}>Run an experiment <ArrowUpRight size={14} /></Button>
          </section>

          <footer className="site-footer">
            <a className="footer-brand" href="#top"><span className="brand-mark"><Waves size={16} /></span> WEB GRAPHICS LAB</a>
            <span>Educational benchmark · Three.js · Results are device- and browser-specific</span>
            <a href="#technology">Learn about the APIs <ArrowUpRight size={13} /></a>
          </footer>
        </main>

        <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Compare selected runs</DialogTitle><DialogDescription>Results are only interpreted side by side when backend and conditions match exactly.</DialogDescription></DialogHeader>
            {selectedConditionsMatch && selectedWebGL && selectedWebGPU ? (
              <div className="dialog-comparison">
                <div className="dialog-condition"><Layers3 size={15} />{selectedWebGL.count.toLocaleString()} instances · {selectedWebGL.requestedDurationMs / 1000} sec requested · measured {formatValue(selectedWebGL.durationMs / 1000)} / {formatValue(selectedWebGPU.durationMs / 1000)} sec · {selectedWebGL.resolution}</div>
                <div className="dialog-result-grid">
                  {[selectedWebGL, selectedWebGPU].map((result) => <div key={result.id} className={`dialog-result ${result.mode}`}><Badge variant={result.mode === 'webgpu' ? 'webgpu' : 'default'}>{result.backend}</Badge><strong>{formatValue(result.avgFps)} <small>FPS</small></strong><span>{formatValue(result.frameMs, 2)} ms / frame</span><span>{formatValue(result.calls, 1)} draw calls</span><span>{formatValue(result.triangles, 0)} triangles</span></div>)}
                </div>
                <p className="dialog-summary">At this object count, WebGL measured {formatValue(selectedWebGL.avgFps)} FPS and WebGPU measured {formatValue(selectedWebGPU.avgFps)} FPS.</p>
              </div>
            ) : (
              <Alert variant="warning"><Info size={15} /><div><AlertTitle>Conditions do not match</AlertTitle><AlertDescription>The selected runs must contain one WebGL and one WebGPU result with the same object count, requested duration, drawing-buffer resolution, and measured durations within 5% (or 250 ms). These measurements are not presented as an equivalent comparison.</AlertDescription></div></Alert>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={clearOpen} onOpenChange={setClearOpen}>
          <DialogContent className="clear-dialog">
            <DialogHeader><DialogTitle>Clear benchmark history?</DialogTitle><DialogDescription>This removes all saved results from this browser. Export a CSV first if you need a copy.</DialogDescription></DialogHeader>
            <div className="dialog-actions"><Button variant="secondary" onClick={() => setClearOpen(false)}>Cancel</Button><Button variant="destructive" onClick={() => { setRows([]); setSelection([]); setClearOpen(false); }}>Clear history</Button></div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

export default App;
