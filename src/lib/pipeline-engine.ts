import * as THREE from 'three';
import { FrameMeter } from './frame-meter';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import type { WebGPURenderer } from 'three/webgpu';
import { makeGeometry, rasterize, setCameraConvention, stageAt, TOTAL_SECONDS, VERTEX_LEVELS } from './pipeline';
import type { DisplayMode, Layout, ObjectKind, RasterImage } from './pipeline';
import type { RendererMode } from './benchmark';

type Renderer = THREE.WebGLRenderer | WebGPURenderer;
export interface ApiStatus { state: 'initializing' | 'ready' | 'unavailable'; detail: string; initMs?: number; gpu?: string }
export interface LabMetric { mode: RendererMode; fps: number; frameMs: number; submitMs: number; gpuMs: number | null; calls: number | null; triangles: number | null; vertices: number; resolution: string }
export interface VertexInspection { index: number; model: number[]; world: number[]; view: number[]; clip: number[]; matrices: number[][] }
export type Experience = 'education' | 'performance';
export type BenchmarkProtocol = 'isolated' | 'concurrent';
export interface BenchmarkOptions { protocol: BenchmarkProtocol; repeats: number; include500k: boolean }
export interface LabResult extends LabMetric { durationMs: number; frames: number; recordedAt: string; initMs: number | null; protocol: BenchmarkProtocol; trial: number; gpuSamples: number; geometryId: string; expectedTriangles: number }

interface Callbacks { status: (mode: RendererMode, status: ApiStatus) => void; tick: (time: number, playing: boolean) => void; metrics: (metrics: LabMetric[]) => void; inspect: (data: VertexInspection, raster: RasterImage | null) => void; benchmark: (message: string, results?: LabResult[]) => void }
interface GlTimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
interface Capture {
  mode: RendererMode; warmup: number; started: number; meter: FrameMeter;
  gpuSamples: number[]; protocol: BenchmarkProtocol; trial: number;
  resolve: (result: LabResult) => void; reject: (error: Error) => void;
}
interface GlQuery { query: WebGLQuery; at: number; capture: Capture | undefined }


export class PipelineEngine {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, .1, 100);
  private group = new THREE.Group();
  private geometry = makeGeometry('cube');
  private mesh!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private points!: THREE.Points;
  private edges!: THREE.LineSegments;
  private triangles!: THREE.Mesh;
  private normals: VertexNormalsHelper | null = null;
  private face!: THREE.Mesh;
  private particles: THREE.InstancedMesh | null = null;
  private hasStarted = false;
  private marker!: THREE.Mesh;
  private renderers: Partial<Record<RendererMode, Renderer>> = {};
  private statuses: Partial<Record<RendererMode, ApiStatus>> = {};
  private controls: OrbitControls[] = [];
  private observer: ResizeObserver;
  private raf = 0;
  private disposed = false;
  private previous = 0;
  private published = 0;
  private apiRafs: Partial<Record<RendererMode, number>> = {};
  private meters = { webgl: new FrameMeter(), webgpu: new FrameMeter() };
  private experience: Experience = 'performance';
  private performanceEpoch = performance.now();
  private educationalTime = 0;
  private snapshotting = false;
  private lastMetricsAt = 0;
  private gpuTimes: Partial<Record<RendererMode, number | null>> = {};
  private glTimer: GlTimerExtension | null = null;
  private glQueries: GlQuery[] = [];
  private timerAt: Partial<Record<RendererMode, number>> = {};
  private gpuTimerPending = false;
  private submissions: Partial<Record<RendererMode, number>> = {};
  private layout: Layout = 'split';
  private kind: ObjectKind = 'cube';
  private display: DisplayMode = 'pipeline';
  private captures: Partial<Record<RendererMode, Capture>> = {};
  private abortBenchmark = false;
  private benchmarking = false;
  private benchmarkModes = new Set<RendererMode>();
  private benchmarkEpoch = 0;
  private suspended = false;
  private inspectDirty = true;
  private width = 480;
  private height = 420;
  private mvp = new THREE.Matrix4();
  private vector = new THREE.Vector3();
  private clip = new THREE.Vector4();
  private normalMatrix = new THREE.Matrix3();
  private albedo = new THREE.Color('#7faeff');
  time = 0;
  playing = false;
  speed = 1;

  constructor(private hosts: Record<RendererMode, HTMLDivElement>, private cb: Callbacks) {
    this.scene.background = new THREE.Color('#0b1019');
    this.camera.position.set(4.5, 3, 6.5);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.group);
    this.scene.add(new THREE.HemisphereLight(0xc6dcff, 0x20203d, 2));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(4, 6, 7);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9280ff, 2);
    rim.position.set(-4, 1, -3);
    this.scene.add(rim);
    this.buildObject();
    for (const mode of ['webgl', 'webgpu'] as const) {
      const control = new OrbitControls(this.camera, hosts[mode]);
      control.minDistance = 4;
      control.maxDistance = 16;
      control.enablePan = false;
      control.enableDamping = false;
      control.addEventListener('change', () => { this.inspectDirty = true; });
      this.controls.push(control);
    }
    this.observer = new ResizeObserver(() => this.resize());
    Object.values(hosts).forEach(host => this.observer.observe(host));
    document.addEventListener('visibilitychange', this.visibility);
    this.raf = requestAnimationFrame(this.animate);
    void this.initialize();
  }

  private status(mode: RendererMode, status: ApiStatus) {
    if (this.disposed) return;
    this.statuses[mode] = status;
    this.cb.status(mode, status);
  }

  private async initialize() {
    for (const mode of ['webgl', 'webgpu'] as const) {
      if (this.disposed) return;
      this.status(mode, { state: 'initializing', detail: 'API болон shader бэлтгэж байна…' });
      let start = performance.now();
      let renderer: Renderer | undefined;
      try {
        let gpuName = 'Browser GPU мэдээлэл өгөөгүй';
        if (mode === 'webgpu') {
          const gpu = navigator.gpu;
          if (!gpu) throw new Error('WebGPU API байхгүй. Secure context (HTTPS/localhost), тохирох browser ба adapter шаардлагатай. WebGL зүүн талд ажиллана.');
          const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
          if (!adapter) throw new Error('Тохирох WebGPU adapter олдсонгүй.');
          gpuName = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.device, adapter.info?.description].filter(Boolean).join(' · ') || gpuName;
          const { WebGPURenderer: Impl } = await import('three/webgpu');
          if (this.disposed) return;
          start = performance.now();
          const gpuRenderer = new Impl({ antialias: false, alpha: false, powerPreference: 'high-performance', trackTimestamp: true });
          renderer = gpuRenderer;
          await gpuRenderer.init();
          if (!(gpuRenderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('WebGL fallback илэрсэн; WebGPU гэж бүртгэхгүй.');
          const device = (gpuRenderer.backend as unknown as { device?: GPUDevice }).device;
          if (device) void device.lost.then(info => {
            if (!this.disposed && info.reason !== 'destroyed') {
              this.status(mode, { state: 'unavailable', detail: `GPU device lost: ${info.message}` });
              this.cancelBenchmark();
            }
          });
        } else {
          renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
          const gl = renderer.getContext();
          this.glTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as GlTimerExtension | null;
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) gpuName = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
          renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
        }
        if (this.disposed) { renderer.dispose(); return; }
        renderer.info.autoReset = false;
        renderer.setPixelRatio(1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1;
        renderer.domElement.setAttribute('aria-label', `${mode} graphics pipeline`);
        this.renderers[mode] = renderer;
        this.hosts[mode].append(renderer.domElement);
        this.resize();
        // Startup CPU wall time excludes module download; it is not GPU completion time.
        this.updateScene();
        setCameraConvention(this.camera, renderer.coordinateSystem);
        renderer.render(this.scene, this.camera);
        this.status(mode, { state: 'ready', detail: mode === 'webgl' ? 'WebGL 2 · GLSL' : 'WebGPU backend · WGSL', initMs: performance.now() - start, gpu: gpuName });
        this.apiRafs[mode] = requestAnimationFrame(now => this.renderFrame(mode, now));
      } catch (error) {
        renderer?.dispose();
        renderer?.domElement.remove();
        delete this.renderers[mode];
        this.status(mode, { state: 'unavailable', detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private contextLost = (event: Event) => {
    event.preventDefault();
    this.status('webgl', { state: 'unavailable', detail: 'WebGL context lost. Reload хийж дахин эхлүүлнэ үү.' });
    this.cancelBenchmark();
  };
  private visibility = () => {
    this.previous = 0;
    this.resetMeters();
    if (document.hidden) this.cancelBenchmark();
  };
  setSuspended(value: boolean) {
    this.suspended = value;
    if (value) this.cancelBenchmark();
    this.previous = 0;
    this.resetMeters();
  }
  setLayout(value: Layout) { this.layout = value; this.previous = 0; this.resetMeters(); this.resize(); }
  private resetMeters() { this.meters.webgl.reset(); this.meters.webgpu.reset(); }
  setExperience(value: Experience) {
    if (this.experience === 'education') this.educationalTime = this.time;
    this.experience = value;
    if (value === 'education') { this.time = this.educationalTime; this.cb.tick(this.time, this.playing); }
    this.performanceEpoch = performance.now();
    this.resetMeters();
    this.inspectDirty = true;
  }
  setDisplay(value: DisplayMode) { this.display = value; this.inspectDirty = true; }
  setObject(value: ObjectKind) { this.resetMeters(); this.gpuTimes = {}; this.kind = value; this.buildObject(); this.inspectDirty = true; }
  setMaterial(color: string, roughness: number, metalness: number) {
    this.albedo.set(color);
    this.mesh.material.color.copy(this.albedo);
    this.mesh.material.roughness = roughness;
    this.mesh.material.metalness = metalness;
    if (this.particles) {
      const material = this.particles.material as THREE.MeshStandardMaterial;
      material.color.copy(this.albedo);
      material.roughness = roughness;
      material.metalness = metalness;
    }
  }
  seek(time: number) { this.inspectDirty = true; this.hasStarted = true; this.time = Math.max(0, Math.min(TOTAL_SECONDS, time)); this.cb.tick(this.time, this.playing); }
  play() { this.hasStarted = true; if (this.time >= TOTAL_SECONDS) this.time = 0; this.playing = true; }
  pause() { this.playing = false; this.cb.tick(this.time, false); }
  resetCamera() { this.camera.position.set(4.5, 3, 6.5); this.camera.lookAt(0, 0, 0); this.controls.forEach(c => { c.target.set(0, 0, 0); c.update(); }); }

  private releaseObject() {
    this.normals?.dispose();
    const geometries = new Set<THREE.BufferGeometry>([this.geometry]);
    const materials = new Set<THREE.Material>();
    this.group.traverse(obj => {
      const item = obj as THREE.Mesh;
      if (item instanceof THREE.InstancedMesh) item.dispose();
      if (item.geometry) geometries.add(item.geometry);
      if (item.material) (Array.isArray(item.material) ? item.material : [item.material]).forEach(m => materials.add(m));
    });
    geometries.forEach(g => g.dispose());
    materials.forEach(m => m.dispose());
    this.group.clear();
  }
  private buildObject(vertexCount?: number) {
    this.releaseObject();
    this.particles = null;
    this.geometry = makeGeometry(this.kind, vertexCount);
    this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshStandardMaterial({ color: '#7faeff', roughness: .35, metalness: .2, side: THREE.DoubleSide }));
    if (this.kind === 'particles' && !vertexCount) {
      // 100K tiny tetrahedra share one geometry/material and one instanced draw.
      this.particles = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(.014), new THREE.MeshStandardMaterial({ color: '#7faeff', roughness: .35, metalness: .2 }), 100000);
      const transform = new THREE.Matrix4();
      const positions = this.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        transform.makeTranslation(positions.getX(i), positions.getY(i), positions.getZ(i));
        this.particles.setMatrixAt(i, transform);
      }
      this.particles.instanceMatrix.needsUpdate = true;
      this.group.add(this.particles);
    }
    // Separate draw ranges for point, triangle and edge buffers.
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', this.geometry.getAttribute('position'));
    this.points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({ color: '#8bcaff', size: this.kind === 'particles' ? .018 : .065, sizeAttenuation: true }));
    this.edges = new THREE.LineSegments(this.kind === 'particles' || vertexCount ? new THREE.BufferGeometry() : new THREE.WireframeGeometry(this.geometry), new THREE.LineBasicMaterial({ color: '#608ecc', transparent: true, opacity: .5 }));
    const faceGeometry = this.kind === 'particles' || vertexCount ? new THREE.BufferGeometry() : this.geometry.toNonIndexed();
    const faceColors = new Float32Array((faceGeometry.getAttribute('position')?.count ?? 0) * 3);
    const color = new THREE.Color();
    for (let i = 0; i < faceColors.length / 9; i++) {
      color.setHSL((i * .618) % 1, .65, .6);
      for (let j = 0; j < 3; j++) color.toArray(faceColors, i * 9 + j * 3);
    }
    faceGeometry.setAttribute('color', new THREE.BufferAttribute(faceColors, 3));
    this.triangles = new THREE.Mesh(faceGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.normals = vertexCount ? null : new VertexNormalsHelper(this.mesh, .18, 0x7ee3d0);
    const faceGeometryHighlight = new THREE.BufferGeometry();
    faceGeometryHighlight.setAttribute('position', this.geometry.getAttribute('position'));
    if (this.geometry.index) faceGeometryHighlight.setIndex(this.geometry.index);
    this.face = new THREE.Mesh(faceGeometryHighlight, new THREE.MeshBasicMaterial({ color: '#b5d3ff', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(.09, 10, 8), new THREE.MeshBasicMaterial({ color: '#e5eeff' }));
    this.group.add(this.mesh, this.points, this.edges, this.triangles, this.marker, this.face);
    // Helper emits world-space positions, so keep it outside the transformed group.
    if (this.normalsInScene) this.scene.remove(this.normalsInScene);
    this.normalsInScene = this.normals;
    if (this.normals) this.scene.add(this.normals);
  }
  private normalsInScene: VertexNormalsHelper | null = null;

  private resize() {
    if (this.benchmarking) return;
    const sizes = Object.values(this.hosts).filter(h => h.clientWidth > 0);
    this.width = Math.max(1, Math.floor(Math.min(...sizes.map(h => h.clientWidth), 900)));
    this.height = Math.max(1, Math.floor(Math.min(...sizes.map(h => h.clientHeight), 480)));
    this.applySize();
  }
  private applySize() {
    this.inspectDirty = true;
    Object.values(this.renderers).forEach(r => r.setSize(this.width, this.height, false));
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }
  private updateScene() {
    const { stage, progress } = stageAt(this.time);
    const particle = this.kind === 'particles' && !this.benchmarking;
    const position = this.geometry.getAttribute('position');
    const count = this.geometry.index?.count ?? position.count;
    this.group.rotation.set(.12, this.time * .1, 0);
    if (this.benchmarking || this.experience === 'performance') {
      // No teaching effects or helper updates enter the actual performance workload.
      this.group.scale.setScalar(1);
      this.mesh.visible = !particle;
      this.mesh.material.color.copy(this.albedo);
      this.mesh.material.emissive.setRGB(0, 0, 0);
      this.geometry.setDrawRange(0, count);
      this.points.visible = this.edges.visible = this.triangles.visible = this.marker.visible = this.face.visible = false;
      if (this.normals) this.normals.visible = false;
      if (this.particles) { this.particles.visible = particle; this.particles.count = position.count; }
      this.group.updateMatrixWorld(true);
      return;
    }
    this.group.scale.setScalar(stage === 1 ? .65 + progress * .35 : 1);
    this.group.updateMatrixWorld(true);
    this.points.visible = particle || this.display === 'vertices' || (this.display === 'pipeline' && stage < 3);
    this.points.geometry.setDrawRange(0, this.display === 'pipeline' && stage === 0 ? Math.max(1, Math.ceil(position.count * progress)) : position.count);
    this.edges.visible = !particle && (this.display === 'wireframe' || (this.display === 'pipeline' && stage < 4));
    const edgeCount = this.edges.geometry.getAttribute('position')?.count ?? 0;
    this.edges.geometry.setDrawRange(0, this.display === 'pipeline' && stage === 0 ? Math.floor(edgeCount * Math.max(0, progress * 2 - 1) / 2) * 2 : edgeCount);
    this.mesh.visible = !particle && (this.display === 'solid' || this.display === 'normals' || (this.display === 'pipeline' && stage >= 2));
    this.geometry.setDrawRange(0, this.display === 'pipeline' && stage === 2 ? Math.floor(count / 3 * progress) * 3 : count);
    this.triangles.visible = !particle && this.display === 'triangles';
    if (this.normals) {
      this.normals.visible = this.display === 'normals';
      if (this.normals.visible && (this.inspectDirty || this.playing)) this.normals.update();
    }
    this.face.visible = !particle && this.display === 'pipeline' && stage === 2 && progress > 0;
    this.face.geometry.setDrawRange(Math.min(Math.floor(count / 3) - 1, Math.floor(count / 3 * progress)) * 3, 3);
    this.marker.visible = this.display === 'pipeline' && stage === 1 && !particle;
    const vertex = Math.min(position.count - 1, Math.floor(progress * position.count));
    this.marker.position.fromBufferAttribute(position, vertex);
    if (this.display === 'pipeline' && stage === 3) this.mesh.visible = false;
    this.mesh.material.color.copy(this.albedo);
    if (this.display === 'pipeline' && stage === 4) this.mesh.material.color.multiplyScalar(.15 + .85 * progress);
    if (this.display === 'pipeline' && stage === 4) this.mesh.material.emissive.setRGB(.02 * (1 - progress), .04 * (1 - progress), .1 * (1 - progress));
    else this.mesh.material.emissive.setRGB(0, 0, 0);
    if (!this.hasStarted && !this.benchmarking && this.display === 'pipeline') {
      this.points.geometry.setDrawRange(0, position.count);
      this.edges.geometry.setDrawRange(0, edgeCount);
    }
    if (this.particles) {
      this.points.visible = false;
      this.particles.visible = this.display !== 'normals';
      (this.particles.material as THREE.MeshStandardMaterial).wireframe = this.display === 'wireframe';
      this.particles.count = this.display === 'pipeline' && stage === 0 && this.hasStarted ? Math.max(1, Math.ceil(position.count * progress)) : position.count;
    }

  }

  private inspect() {
    const { progress } = stageAt(this.time);
    const position = this.geometry.getAttribute('position');
    const index = Math.min(position.count - 1, Math.floor(progress * position.count));
    this.vector.fromBufferAttribute(position, index);
    const model = this.vector.toArray();
    const world = this.vector.applyMatrix4(this.group.matrixWorld).toArray();
    setCameraConvention(this.camera, THREE.WebGLCoordinateSystem);
    this.camera.updateMatrixWorld();
    const view = this.vector.applyMatrix4(this.camera.matrixWorldInverse).toArray();
    // Teaching math uses OpenGL clip depth. WebGPURenderer adjusts projection internally.
    this.clip.set(...view as [number, number, number], 1).applyMatrix4(this.camera.projectionMatrix);
    this.mvp.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.group.matrixWorld);
    this.normalMatrix.getNormalMatrix(this.group.matrixWorld);
    const raster = this.kind !== 'particles' && stageAt(this.time).stage >= 3 ? rasterize(this.geometry, this.mvp, this.normalMatrix) : null;
    this.cb.inspect({ index, model, world, view, clip: this.clip.toArray(), matrices: [this.group.matrixWorld.toArray(), this.camera.matrixWorldInverse.toArray(), this.camera.projectionMatrix.toArray()] }, raster);
  }
  private metric(mode: RendererMode, fps: number, frameMs: number, submitMs: number): LabMetric {
    const render = this.renderers[mode]!.info.render as { calls?: number; drawCalls?: number; triangles?: number };
    return { mode, fps, frameMs, submitMs, gpuMs: this.gpuTimes[mode] ?? null, calls: mode === 'webgpu' ? render.drawCalls ?? null : render.calls ?? null, triangles: render.triangles ?? null, vertices: this.geometry.getAttribute('position').count, resolution: `${this.width} × ${this.height}` };
  }
  private render(mode: RendererMode) {
    const renderer = this.renderers[mode];
    if (!renderer || this.statuses[mode]?.state !== 'ready') return;
    const { stage, progress } = stageAt(this.time);
    setCameraConvention(this.camera, renderer.coordinateSystem);
    renderer.setScissorTest(false);
    if (!this.benchmarking && this.experience === 'education' && this.display === 'pipeline' && stage === 5 && progress < 1) {
      renderer.clear();
      renderer.setScissor(0, 0, this.width, Math.floor(this.height * progress));
      renderer.setScissorTest(true);
    }
    renderer.info.reset();
    const now = performance.now();
    const sampleTimer = now - (this.timerAt[mode] ?? 0) >= 250;
    let query: WebGLQuery | null = null;
    const gl = mode === 'webgl' ? (renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext : null;
    if (gl && this.glTimer) {
      if (gl.getParameter(this.glTimer.GPU_DISJOINT_EXT)) {
        this.glQueries.forEach(q => gl.deleteQuery(q.query));
        this.glQueries = [];
        this.gpuTimes.webgl = null;
        if (this.captures.webgl) this.captures.webgl.gpuSamples = [];
      }
      while (this.glQueries.length && gl.getQueryParameter(this.glQueries[0].query, gl.QUERY_RESULT_AVAILABLE)) {
        const completed = this.glQueries.shift()!;
        if (!gl.getParameter(this.glTimer.GPU_DISJOINT_EXT)) this.recordGpu('webgl', Number(gl.getQueryParameter(completed.query, gl.QUERY_RESULT)) / 1e6, completed.at, completed.capture);
        gl.deleteQuery(completed.query);
      }
      if (sampleTimer && !gl.getParameter(this.glTimer.GPU_DISJOINT_EXT) && this.glQueries.length < 2) {
        query = gl.createQuery();
        if (query) { gl.beginQuery(this.glTimer.TIME_ELAPSED_EXT, query); this.timerAt.webgl = now; }
      }
    }
    const start = performance.now();
    try { renderer.render(this.scene, this.camera); }
    finally {
      this.submissions[mode] = performance.now() - start;
      if (query && gl && this.glTimer) { gl.endQuery(this.glTimer.TIME_ELAPSED_EXT); this.glQueries.push({ query, at: now, capture: this.captures.webgl }); }
    }
    if (mode === 'webgpu' && sampleTimer && !this.gpuTimerPending && ((renderer as WebGPURenderer).backend as unknown as { trackTimestamp?: boolean }).trackTimestamp) {
      this.gpuTimerPending = true;
      const capture = this.captures.webgpu;
      this.timerAt.webgpu = now;
      void (renderer as WebGPURenderer).resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(ms => {
        if (typeof ms === 'number') this.recordGpu('webgpu', ms, now, capture);
      }).catch(() => { this.gpuTimes.webgpu = null; }).finally(() => { this.gpuTimerPending = false; });
    }
    renderer.setScissorTest(false);
  }
  private recordGpu(mode: RendererMode, ms: number, sampledAt: number, capture?: Capture) {
    if (this.disposed || !Number.isFinite(ms) || ms < 0) return;
    this.gpuTimes[mode] = ms;
    if (capture && this.captures[mode] === capture && sampledAt >= capture.started) capture.gpuSamples.push(ms);
  }

  /** Separate callbacks and independent interval counters; no copied FPS or speed multiplier. */
  private renderFrame(mode: RendererMode, now: number) {
    if (this.disposed) return;
    this.apiRafs[mode] = requestAnimationFrame(next => this.renderFrame(mode, next));
    const capture = this.captures[mode];
    const visible = this.layout === 'split' || this.layout === 'difference' || this.layout === mode;
    if (document.hidden || this.suspended || this.snapshotting || this.statuses[mode]?.state !== 'ready' || (this.benchmarking ? !this.benchmarkModes.has(mode) : !visible)) {
      this.meters[mode].reset();
      return;
    }
    if (this.benchmarking || this.experience === 'performance') {
      // RAF timestamps share a time origin; poses match at corresponding timestamps.
      // Each isolated capture starts the same deterministic animation from t=0.
      this.time = (now - (this.benchmarking ? this.benchmarkEpoch : this.performanceEpoch)) / 1000;
      this.updateScene();
    }
    try {
      this.render(mode);
      if (capture) {
        const actual = this.renderers[mode]!.info.render.triangles;
        const expected = (this.geometry.index?.count ?? this.geometry.getAttribute('position').count) / 3;
        if (typeof actual === 'number' && actual !== expected) throw new Error(`Triangle workload mismatch: ${mode} reported ${actual}, expected ${expected}. Capture discarded.`);
      }
      this.meters[mode].record(now, this.submissions[mode] ?? 0);
      if (capture && now >= capture.started) {
        capture.meter.record(now, this.submissions[mode] ?? 0);
        const measured = capture.meter.read();
        if (measured && capture.meter.elapsedMs >= 3000) {
          const result: LabResult = {
            ...this.metric(mode, measured.fps, measured.frameMs, measured.submitMs),
            gpuMs: capture.gpuSamples.length ? capture.gpuSamples.reduce((a, b) => a + b, 0) / capture.gpuSamples.length : null,
            geometryId: this.geometry.uuid, expectedTriangles: (this.geometry.index?.count ?? this.geometry.getAttribute('position').count) / 3,
            gpuSamples: capture.gpuSamples.length, protocol: capture.protocol, trial: capture.trial,
            frames: capture.meter.intervals, durationMs: capture.meter.elapsedMs,
            initMs: this.statuses[mode]?.initMs ?? null, recordedAt: new Date().toISOString(),
          };
          delete this.captures[mode];
          capture.resolve(result);
        }
      }
    } catch (error) {
      this.status(mode, { state: 'unavailable', detail: `Render failed: ${String(error)}` });
      this.cancelBenchmark();
    }
  }

  private animate = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    if (document.hidden || this.suspended) { this.previous = 0; return; }
    const delta = this.previous ? now - this.previous : 0;
    this.previous = now;
    if (!this.benchmarking && this.experience === 'education') {
      if (this.playing) {
        this.time = Math.min(TOTAL_SECONDS, this.time + Math.min(delta, 100) / 1000 * this.speed);
        this.inspectDirty = true;
        if (this.time >= TOTAL_SECONDS) this.playing = false;
      }
      this.updateScene();
    }
    if (now - this.published < 100) return;
    this.published = now;
    if (!this.benchmarking && this.experience === 'education' && (this.inspectDirty || this.playing)) {
      this.cb.tick(this.time, this.playing);
      this.inspect();
      this.inspectDirty = false;
    }
    if (now - this.lastMetricsAt >= 500) {
      this.lastMetricsAt = now;
      this.cb.metrics((['webgl', 'webgpu'] as const).flatMap(mode => {
        const sample = this.meters[mode].read();
        const values = sample && this.statuses[mode]?.state === 'ready' ? [this.metric(mode, sample.fps, sample.frameMs, sample.submitMs)] : [];
        this.meters[mode].clearWindow();
        return values;
      }));
    }
  };

  async benchmark(options: BenchmarkOptions = { protocol: 'isolated', repeats: 2, include500k: false }) {
    if (this.benchmarking || this.suspended || document.hidden) return;
    this.benchmarking = true;
    this.abortBenchmark = false;
    const saved = { experience: this.experience, time: this.time, playing: this.playing, camera: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), color: this.albedo.clone(), roughness: this.mesh.material.roughness, metalness: this.mesh.material.metalness };
    this.playing = false;
    this.albedo.set('#7faeff');
    this.controls.forEach(c => { c.enabled = false; });
    this.width = 640; this.height = 480; this.applySize();
    this.resetMeters();
    const results: LabResult[] = [];
    const levels = options.include500k ? [...VERTEX_LEVELS, 500000] : [...VERTEX_LEVELS];
    const available = (['webgl', 'webgpu'] as const).filter(mode => this.statuses[mode]?.state === 'ready');
    try {
      for (const count of levels) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (this.abortBenchmark || this.disposed) throw new Error('Benchmark цуцлагдсан.');
        this.buildObject(count);
        this.mesh.material.color.copy(this.albedo);
        this.camera.position.set(4.5, 3, 6.5); this.camera.lookAt(0, 0, 0);
        for (let trial = 1; trial <= Math.min(3, Math.max(1, options.repeats)); trial++) {
          const order = trial % 2 ? available : [...available].reverse();
          const batches = options.protocol === 'concurrent' ? [order] : order.map(mode => [mode]);
          for (const batch of batches) {
            if (this.abortBenchmark) throw new Error('Benchmark цуцлагдсан. Дууссан хэмжилтүүд үлдэнэ.');
            this.gpuTimes = {};
            this.resetMeters();
            this.cb.benchmark(`${batch.join(' + ').toUpperCase()} · ${count.toLocaleString()} vertices · trial ${trial} · ${options.protocol} · warm-up 1.5 s / capture ≥3 s`, [...results]);
            // A simultaneous batch uses exactly the same start and warm-up boundary.
            const epoch = performance.now();
            this.benchmarkEpoch = epoch;
            this.benchmarkModes = new Set(batch);
            const captures = batch.map(mode => new Promise<LabResult>((resolve, reject) => {
              this.captures[mode] = { mode, warmup: epoch, started: epoch + 1500, meter: new FrameMeter(), gpuSamples: [], protocol: options.protocol, trial, resolve, reject };
            }));
            const completed = await Promise.allSettled(captures);
            this.benchmarkModes.clear();
            for (const entry of completed) if (entry.status === 'fulfilled') results.push(entry.value);
            this.cb.benchmark(`${results.length} хэмжилт дууслаа`, [...results]);
            const failed = completed.find(entry => entry.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
          }
        }
      }
      this.cb.benchmark(results.length ? 'Хэмжилт дууслаа. FPS нь browser cadence; GPU ms нь hardware query sample.' : 'Ажиллах backend алга.', results);
    } catch (error) {
      if (!this.disposed) this.cb.benchmark(String(error instanceof Error ? error.message : error), results);
    } finally {
      this.captures = {};
      this.benchmarkModes.clear();
      this.benchmarking = false;
      if (!this.disposed) {
        this.buildObject();
        this.setMaterial(saved.color.getStyle(), saved.roughness, saved.metalness);
        this.experience = saved.experience;
        this.time = saved.time; this.playing = saved.playing;
        this.performanceEpoch = performance.now() - saved.time * 1000;
        this.camera.position.copy(saved.camera); this.camera.quaternion.copy(saved.quaternion);
        this.controls.forEach(c => { c.enabled = true; });
        this.resetMeters();
        this.resize();
      }
    }
  }
  cancelBenchmark() {
    this.abortBenchmark = true;
    this.benchmarkModes.clear();
    const captures = Object.values(this.captures);
    this.captures = {};
    captures.forEach(capture => capture.reject(new Error('Хэмжилт цуцлагдсан: tab visibility, renderer эсвэл хэрэглэгчийн үйлдэл.')));
  }

  async difference(canvas: HTMLCanvasElement): Promise<string> {
    if (this.benchmarking) throw new Error('Benchmark дууссаны дараа харьцуулна уу.');
    if (!this.renderers.webgl || !this.renderers.webgpu || this.statuses.webgpu?.state !== 'ready' || this.statuses.webgl?.state !== 'ready') throw new Error('Pixel difference-д хоёр API хоёулаа ажиллах шаардлагатай.');
    this.pause();
    this.snapshotting = true;
    this.updateScene();
    const images: ImageData[] = [];
    const captureSize = [this.width, this.height];
    this.controls.forEach(c => { c.enabled = false; });
    try {
    for (const mode of ['webgl', 'webgpu'] as const) {
      this.render(mode);
      const renderer = this.renderers[mode]!;
      if (mode === 'webgpu') {
        const device = ((renderer as WebGPURenderer).backend as unknown as { device?: GPUDevice }).device;
        await device?.queue.onSubmittedWorkDone();
      }
      const copy = document.createElement('canvas');
      copy.width = this.width; copy.height = this.height;
      const context = copy.getContext('2d')!;
      context.drawImage(renderer.domElement, 0, 0);
      images.push(context.getImageData(0, 0, this.width, this.height));
    }
    if (captureSize[0] !== this.width || captureSize[1] !== this.height) throw new Error('Resolution өөрчлөгдсөн. Snapshot дахин авна уу.');
    canvas.width = this.width; canvas.height = this.height;
    const output = new ImageData(this.width, this.height);
    let sum = 0;
    for (let i = 0; i < output.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(images[0].data[i + channel] - images[1].data[i + channel]);
        sum += delta;
        output.data[i + channel] = Math.min(255, delta * 4);
      }
      output.data[i + 3] = 255;
    }
    canvas.getContext('2d')!.putImageData(output, 0, 0);
    return `RGB MAE ${(sum / (this.width * this.height * 3)).toFixed(3)} / 255 · |WebGL − WebGPU| × 4 · frozen snapshot`;
    } finally {
      this.snapshotting = false;
      if (!this.disposed && !this.benchmarking) this.controls.forEach(c => { c.enabled = true; });
    }
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    Object.values(this.apiRafs).forEach(id => cancelAnimationFrame(id));
    this.cancelBenchmark();
    this.observer.disconnect();
    document.removeEventListener('visibilitychange', this.visibility);
    this.controls.forEach(c => c.dispose());
    this.releaseObject();
    const gl = (this.renderers.webgl as THREE.WebGLRenderer | undefined)?.getContext() as WebGL2RenderingContext | undefined;
    this.glQueries.forEach(q => gl?.deleteQuery(q.query));
    this.glQueries = [];
    Object.values(this.renderers).forEach(r => {
      r.domElement.removeEventListener('webglcontextlost', this.contextLost);
      r.dispose(); r.domElement.remove();
    });
    this.scene.clear();
  }
}
