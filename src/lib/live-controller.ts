import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { WebGPURenderer } from 'three/webgpu';
import { FrameMeter } from './frame-meter';
import { makeGeometry, setCameraConvention } from './pipeline';
import type { ObjectKind } from './pipeline';
import { launchBoth, newLane, quantile } from './live-lifecycle';
import type { LiveApi, LiveLane, WorkGroup } from './live-lifecycle';

type Renderer = THREE.WebGLRenderer | WebGPURenderer;
export interface LiveInput { kind: ObjectKind; count: number; color: string; roughness: number; metalness: number; width: number; height: number }
interface Owned {
  renderer: Renderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry; controls: OrbitControls; cleanups: (() => void)[];
  raf: number; meter: FrameMeter; intervals: number[]; started: number; lastPublish: number;
  glQuery?: WebGLQuery; queryAt: number; timerPending: boolean;
  timerExt?: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
}
const apis: LiveApi[] = ['webgl', 'webgpu'];
const stale = new Error('Superseded start');

/** The controller shares a read-only source. Each path copies it into owned scene/GPU resources.
 * Promises overlap asynchronous API work; JS callbacks still share the browser main thread.
 */
export class LiveController {
  private run = 0;
  private disposed = false;
  private owned: Partial<Record<LiveApi, Owned>> = {};
  private lanes = { webgl: newLane('webgl'), webgpu: newLane('webgpu') };
  private source: THREE.BufferGeometry | null = null;
  private input: LiveInput | null = null;
  private epoch = 0;
  private clockRaf = 0;
  private lastClock = 0;
  private observer: ResizeObserver;
  private visible = true;
  private pausedView = false;
  // Preload code without creating a GPU device/context. Remaining module wait is recorded.
  private gpuModule = import('three/webgpu');

  constructor(private hosts: Record<LiveApi, HTMLDivElement>, private publish: (lane: LiveLane) => void) {
    // A rejected optional import is handled again in the independent WebGPU lane.
    void this.gpuModule.catch(() => undefined);
    this.observer = new ResizeObserver(() => this.resize());
    apis.forEach(api => this.observer.observe(hosts[api]));
    document.addEventListener('visibilitychange', this.visibility);
    this.clockRaf = requestAnimationFrame(this.clock);
    apis.forEach(api => this.emit(api));
  }
  private guard(run: number) { if (this.disposed || run !== this.run) throw stale; }
  private emit(api: LiveApi) {
    if (this.disposed || this.pausedView) return;
    const lane = this.lanes[api];
    this.publish({ ...lane, metrics: { ...lane.metrics }, milestones: lane.milestones.map(p => ({ ...p })), operations: lane.operations.map(p => ({ ...p })) });
  }
  setViewPaused(value: boolean) { this.pausedView = value; if (!value) apis.forEach(api => this.emit(api)); }
  setVisible(value: boolean) { this.visible = value; apis.forEach(api => this.owned[api]?.meter.reset()); }
  private visibility = () => {
    apis.forEach(api => {
      this.owned[api]?.meter.reset();
      if (document.hidden && this.lanes[api].state === 'initializing') this.fail(api, new Error('Эхлэх үед хуудас далд болсон тул энэ хэмжилтийг ашиглахгүй. Дахин эхлүүлнэ үү.'));
    });
  };
  private clock = (now: number) => {
    if (this.disposed) return;
    this.clockRaf = requestAnimationFrame(this.clock);
    if (now - this.lastClock < 100) return;
    this.lastClock = now;
    apis.forEach(api => {
      const lane = this.lanes[api];
      if (lane.state === 'initializing') { lane.elapsedMs = now - this.epoch; this.emit(api); }
    });
  };
  private phase(api: LiveApi, id: string, done = false, at?: number) {
    const lane = this.lanes[api];
    const phase = lane.milestones.find(p => p.id === id)!;
    const elapsed = (at ?? performance.now()) - this.epoch;
    if (phase.startMs === undefined) phase.startMs = elapsed;
    phase.state = done ? 'done' : 'active';
    if (done) phase.endMs = elapsed;
    lane.current = phase.label;
    lane.elapsedMs = elapsed;
    this.emit(api);
  }
  private fail(api: LiveApi, error: unknown, unsupported = false) {
    const lane = this.lanes[api];
    if (lane.state === 'error' || lane.state === 'unsupported') return;
    lane.state = unsupported ? 'unsupported' : 'error';
    lane.error = error instanceof Error ? error.message : String(error);
    lane.current = lane.error;
    lane.elapsedMs = performance.now() - this.epoch;
    lane.milestones.forEach(p => { if (p.state === 'active') p.state = 'error'; });
    const owned = this.owned[api];
    if (owned) { cancelAnimationFrame(owned.raf); owned.controls.enabled = false; }
    this.emit(api);
  }

  async start(input: LiveInput) {
    const run = ++this.run;
    apis.forEach(api => this.release(api));
    this.source?.dispose(); this.source = null;
    this.input = { ...input };
    this.epoch = performance.now();
    this.lanes = { webgl: newLane('webgl', run, this.epoch), webgpu: newLane('webgpu', run, this.epoch) };
    apis.forEach(api => { this.lanes[api].state = 'initializing'; this.phase(api, 'geometry'); });
    try {
      const prep = performance.now();
      this.source = makeGeometry(input.count ? 'sphere' : input.kind, input.count || undefined);
      const ms = performance.now() - prep;
      apis.forEach(api => {
        const lane = this.lanes[api];
        lane.metrics.geometryMs = ms; // One shared preparation, not two independent fabricated times.
        lane.metrics.vertices = this.source!.getAttribute('position').count;
        lane.metrics.indices = this.source!.index?.count ?? 0;
        lane.metrics.resolution = `${input.width} × ${input.height}`;
        this.phase(api, 'geometry', true);
      });
    } catch (error) { apis.forEach(api => this.fail(api, error)); return; }
    // Both paths are armed before either initializer runs. GPU-first starts async device
    // acquisition; WebGL does not await it. allSettled only collects final outcomes.
    return launchBoth(api => this.initialize(api, run));
  }

  private async initialize(api: LiveApi, run: number) {
    let renderer: Renderer | undefined;
    let attached = false;
    try {
      this.guard(run);
      const lane = this.lanes[api];
      this.phase(api, 'module');
      const moduleStart = performance.now();
      const gpuModule = api === 'webgpu' ? await this.gpuModule : null;
      this.guard(run);
      lane.metrics.moduleMs = performance.now() - moduleStart;
      this.phase(api, 'module', true);
      this.phase(api, 'device');
      const deviceStart = performance.now();
      if (api === 'webgpu') {
        if (!navigator.gpu) { this.fail(api, new Error('Браузер WebGPU-г дэмжихгүй эсвэл идэвхжүүлээгүй байна. HTTPS/localhost болон тохирох GPU, браузер шаардлагатай.'), true); return; }
        const impl = new gpuModule!.WebGPURenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', trackTimestamp: true });
        renderer = impl;
        await impl.init();
        this.guard(run);
        if (!(impl.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('Жинхэнэ WebGPU эхэлсэнгүй. Орлуулсан WebGL-ийг WebGPU гэж харуулахгүй.');
      } else {
        const impl = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
        renderer = impl;
        impl.debug.onShaderError = (gl, program, vertex, fragment) => {
          throw new Error([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].filter(Boolean).join('\n') || 'GLSL шэйдерийг хөрвүүлэх, холбоход алдаа гарлаа.');
        };
      }
      lane.metrics.deviceMs = performance.now() - deviceStart;
      this.phase(api, 'device', true);
      renderer.info.autoReset = false;
      renderer.setPixelRatio(1);
      renderer.setSize(this.input!.width, this.input!.height, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.domElement.setAttribute('aria-label', `${api} live output`);
      this.phase(api, 'copy');
      const copyStart = performance.now();
      const scene = new THREE.Scene(); scene.background = new THREE.Color('#0b1019');
      const camera = new THREE.PerspectiveCamera(42, this.input!.width / this.input!.height, .1, 100);
      camera.position.set(4.5, 3, 6.5); camera.lookAt(0, 0, 0);
      setCameraConvention(camera, renderer.coordinateSystem);
      // clone() makes independent typed arrays, attributes, index and GPU upload lifetimes.
      const geometry = this.source!.clone();
      const material = new THREE.MeshStandardMaterial({ color: this.input!.color, roughness: this.input!.roughness, metalness: this.input!.metalness, side: THREE.DoubleSide });
      let mesh: THREE.Mesh;
      if (!this.input!.count && this.input!.kind === 'particles') {
        const instances = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(.014), material, geometry.getAttribute('position').count);
        const matrix = new THREE.Matrix4(), positions = geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) { matrix.makeTranslation(positions.getX(i), positions.getY(i), positions.getZ(i)); instances.setMatrixAt(i, matrix); }
        instances.instanceMatrix.needsUpdate = true; mesh = instances;
      } else mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.set(.12, 0, 0); scene.add(mesh);
      scene.add(new THREE.HemisphereLight(0xc6dcff, 0x20203d, 2));
      const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(4, 6, 7); scene.add(key);
      const rim = new THREE.DirectionalLight(0x9280ff, 2); rim.position.set(-4, 1, -3); scene.add(rim);
      const controls = new OrbitControls(camera, this.hosts[api]); controls.minDistance = 4; controls.maxDistance = 16; controls.enablePan = false;
      controls.addEventListener('change', () => {
        const peerApi = api === 'webgl' ? 'webgpu' : 'webgl';
        const peer = this.owned[peerApi];
        if (peer && this.lanes[api].state === 'complete' && this.lanes[peerApi].state === 'complete') {
          peer.camera.position.copy(camera.position); peer.camera.quaternion.copy(camera.quaternion); peer.controls.target.copy(controls.target);
        }
      });
      controls.enabled = false;
      const owned: Owned = { renderer, scene, camera, mesh, geometry, controls, cleanups: [], raf: 0, meter: new FrameMeter(), intervals: [], started: 0, lastPublish: 0, queryAt: 0, timerPending: false };
      this.owned[api] = owned; attached = true;
      this.hosts[api].append(renderer.domElement);
      lane.metrics.copyMs = performance.now() - copyStart;
      this.phase(api, 'copy', true);
      this.observeNative(api, owned, run);
      if (api === 'webgl') {
        const lost = (event: Event) => { event.preventDefault(); if (run === this.run) this.fail(api, new Error('WebGL-ийн зурах орчин тасарлаа. Хоёуланг дахин эхлүүлнэ үү.')); };
        renderer.domElement.addEventListener('webglcontextlost', lost);
        owned.cleanups.push(() => renderer!.domElement.removeEventListener('webglcontextlost', lost));
      } else {
        const device = this.device(owned);
        if (device) {
          void device.lost.then(info => { if (!this.disposed && run === this.run && info.reason !== 'destroyed') this.fail(api, new Error(`GPU-тэй холболт тасарлаа: ${info.message}`)); });
          device.pushErrorScope('validation');
        }
      }
      this.phase(api, 'setup');
      const setupStart = performance.now();
      await renderer.compileAsync(scene, camera);
      this.guard(run);
      if (this.lanes[api].state !== 'initializing') throw stale;
      lane.metrics.setupMs = performance.now() - setupStart;
      this.phase(api, 'setup', true);
      lane.metrics.initializationMs = performance.now() - this.epoch;
      this.phase(api, 'submit');
      renderer.info.reset();
      const firstGl = api === 'webgl' ? (renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext : null;
      const firstQuery = firstGl && owned.timerExt && !firstGl.getParameter(owned.timerExt.GPU_DISJOINT_EXT) ? firstGl.createQuery() : null;
      if (firstQuery && firstGl && owned.timerExt) firstGl.beginQuery(owned.timerExt.TIME_ELAPSED_EXT, firstQuery);
      const submitStart = performance.now();
      try { renderer.render(scene, camera); }
      finally { if (firstQuery && firstGl && owned.timerExt) { firstGl.endQuery(owned.timerExt.TIME_ELAPSED_EXT); owned.glQuery = firstQuery; } }
      lane.metrics.submitMs = performance.now() - submitStart;
      this.phase(api, 'submit', true);
      this.phase(api, 'completion');
      const waitStart = performance.now();
      await this.complete(owned, api, run);
      this.guard(run);
      const completedAt = performance.now();
      lane.metrics.waitMs = completedAt - waitStart;
      lane.metrics.completionMs = completedAt - this.epoch;
      if (api === 'webgpu') {
        const error = await this.device(owned)?.popErrorScope();
        this.guard(run);
        if (error) throw new Error(error.message);
      }
      if (this.lanes[api].state !== 'initializing') throw stale;
      if (firstQuery && firstGl && owned.timerExt) {
        if (!firstGl.getParameter(owned.timerExt.GPU_DISJOINT_EXT) && firstGl.getQueryParameter(firstQuery, firstGl.QUERY_RESULT_AVAILABLE)) lane.metrics.firstGpuMs = Number(firstGl.getQueryParameter(firstQuery, firstGl.QUERY_RESULT)) / 1e6;
        firstGl.deleteQuery(firstQuery); owned.glQuery = undefined;
      } else if (api === 'webgpu' && ((renderer as WebGPURenderer).backend as unknown as { trackTimestamp?: boolean }).trackTimestamp) {
        owned.timerPending = true;
        void (renderer as WebGPURenderer).resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(value => {
          if (run === this.run && !this.disposed && typeof value === 'number' && Number.isFinite(value)) { lane.metrics.firstGpuMs = value; this.emit(api); }
        }).catch(() => { /* Optional hardware metric remains unavailable. */ }).finally(() => { owned.timerPending = false; });
      }
      this.phase(api, 'completion', true, completedAt);
      this.phase(api, 'output', true, completedAt);
      lane.state = 'complete'; lane.current = 'Эхний зураг бэлэн · GPU дууссан дохио ирсэн';
      lane.elapsedMs = lane.metrics.completionMs;
      this.counts(api, owned);
      // Native API tracing ends at startup to avoid adding per-draw hook overhead to FPS.
      owned.cleanups.splice(0, owned.cleanups.length).forEach(cleanup => cleanup());
      // Reinstall context-loss listener for sustained rendering.
      const lost = (event: Event) => { event.preventDefault(); if (run === this.run) this.fail(api, new Error('WebGL-ийн зурах орчин тасарлаа. Хоёуланг дахин эхлүүлнэ үү.')); };
      if (api === 'webgl') { renderer.domElement.addEventListener('webglcontextlost', lost); owned.cleanups.push(() => renderer!.domElement.removeEventListener('webglcontextlost', lost)); }
      if (api === 'webgpu') {
        const device = this.device(owned);
        const errorListener = (event: Event) => { if (run === this.run) this.fail(api, new Error((event as GPUUncapturedErrorEvent).error.message)); };
        device?.addEventListener('uncapturederror', errorListener);
        owned.cleanups.push(() => device?.removeEventListener('uncapturederror', errorListener));
      }
      owned.controls.enabled = true;
      owned.started = performance.now();
      this.emit(api);
      owned.raf = requestAnimationFrame(now => this.frame(api, run, now));
    } catch (error) {
      if (!this.disposed && run === this.run && error !== stale) this.fail(api, error);
      if (!attached && renderer) this.disposeRenderer(renderer);
      else if (run === this.run && !this.disposed) this.release(api);
    }
  }

  private device(owned: Owned) { return (owned.renderer as WebGPURenderer).backend ? ((owned.renderer as WebGPURenderer).backend as unknown as { device?: GPUDevice }).device : undefined; }
  private async complete(owned: Owned, api: LiveApi, run: number) {
    if (api === 'webgpu') {
      const device = this.device(owned);
      if (!device) throw new Error('WebGPU-ийн ажил дууссан дохиог авах боломжгүй.');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([device.queue.onSubmittedWorkDone(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('WebGPU-ээс ажил дууссан дохио хугацаандаа ирсэнгүй.')), 30000); })]);
      } finally { clearTimeout(timeout); }
      this.guard(run); return;
    }
    const gl = (owned.renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext;
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) throw new Error('WebGL-ийн ажил дууссаныг шалгах дохио үүссэнгүй.');
    gl.flush();
    let previous = performance.now();
    try {
      while (true) {
        this.guard(run);
        if (this.lanes[api].state !== 'initializing') throw stale;
        const result = gl.clientWaitSync(fence, 0, 0);
        if (result === gl.WAIT_FAILED) throw new Error('WebGL-ийн ажил дууссаныг шалгахад алдаа гарлаа.');
        if (result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED) return;
        if (performance.now() - this.epoch > 30000) throw new Error('GPU-ээс ажил дууссан дохио хугацаандаа ирсэнгүй.');
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const now = performance.now();
        this.lanes[api].detectorMs = Math.max(this.lanes[api].detectorMs, now - previous);
        previous = now;
      }
    } finally { gl.deleteSync(fence); }
  }

  private observeNative(api: LiveApi, owned: Owned, run: number) {
    const lane = this.lanes[api];
    const wrap = (target: object, name: string, group: WorkGroup, category: 'uploadMs' | 'shaderApiMs' | 'encodingMs' | 'commandMs', after?: (value: unknown) => void) => {
      const object = target as Record<string, unknown>;
      const original = object[name];
      if (typeof original !== 'function') return;
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const controller = this;
      const wrapped = function(...args: unknown[]) {
        const start = performance.now();
        let callEnd: number | undefined;
        try {
          const result = original.apply(target, args);
          callEnd = performance.now();
          after?.(result);
          return result;
        } finally {
          if (run === controller.run && lane.state === 'initializing') {
            const end = callEnd ?? performance.now(), ms = end - start;
            let op = lane.operations.find(p => p.name === name);
            const first = !op;
            if (!op) { op = { name, group, calls: 0, cpuMs: 0, firstMs: start - controller.epoch, lastMs: end - controller.epoch }; lane.operations.push(op); }
            op.calls++; op.cpuMs += ms; op.lastMs = end - controller.epoch;
            lane.metrics[category] = (lane.metrics[category] ?? 0) + ms;
            lane.current = `${name} дуудлага буцлаа · CPU/API дээр ажиглав`;
            if (first) controller.emit(api);
          }
        }
      };
      try {
        object[name] = wrapped;
        if (object[name] === wrapped) owned.cleanups.push(() => { if (descriptor) Object.defineProperty(target, name, descriptor); else delete object[name]; });
      } catch { /* Native methods may be non-writable; absence remains Not available. */ }
    };
    if (api === 'webgl') {
      const gl = (owned.renderer as THREE.WebGLRenderer).getContext();
      for (const name of ['createBuffer', 'bindBuffer', 'bufferData', 'bufferSubData', 'vertexAttribPointer', 'vertexAttribIPointer', 'enableVertexAttribArray']) wrap(gl, name, 'api', 'uploadMs');
      for (const name of ['createShader', 'shaderSource', 'compileShader', 'createProgram', 'attachShader', 'linkProgram']) wrap(gl, name, 'api', 'shaderApiMs');
      for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) wrap(gl, name, 'api', 'commandMs');
      owned.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    } else {
      const device = this.device(owned);
      if (!device) return;
      for (const name of ['createBuffer']) wrap(device, name, 'api', 'uploadMs');
      wrap(device.queue, 'writeBuffer', 'api', 'uploadMs');
      for (const name of ['createShaderModule', 'createRenderPipeline', 'createRenderPipelineAsync', 'createPipelineLayout', 'createBindGroupLayout', 'createBindGroup']) wrap(device, name, 'api', 'shaderApiMs');
      wrap(device.queue, 'submit', 'api', 'commandMs');
      wrap(device, 'createCommandEncoder', 'api', 'encodingMs', encoder => {
        if (!encoder) return;
        const target = encoder as object;
        wrap(target, 'finish', 'api', 'encodingMs');
        wrap(target, 'beginRenderPass', 'api', 'encodingMs', pass => {
          if (!pass) return;
          for (const name of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'draw', 'drawIndexed', 'end']) wrap(pass as object, name, 'api', 'encodingMs');
        });
      });
    }
  }

  private counts(api: LiveApi, owned: Owned) {
    const render = owned.renderer.info.render as { calls?: number; drawCalls?: number; triangles?: number };
    this.lanes[api].metrics.calls = (api === 'webgl' ? render.calls : render.drawCalls) ?? null;
    this.lanes[api].metrics.triangles = render.triangles ?? null;
  }
  private frame(api: LiveApi, run: number, now: number) {
    if (this.disposed || run !== this.run) return;
    const owned = this.owned[api], lane = this.lanes[api];
    if (!owned || lane.state !== 'complete') return;
    owned.raf = requestAnimationFrame(next => this.frame(api, run, next));
    if (!this.visible || document.hidden) { owned.meter.reset(); return; }
    try {
      owned.mesh.rotation.set(.12, Math.max(0, now - this.epoch) * .0001, 0);
      const gl = api === 'webgl' ? (owned.renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext : null;
      let query: WebGLQuery | null = null;
      if (gl && owned.timerExt) {
        const ext = owned.timerExt;
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          if (owned.glQuery) gl.deleteQuery(owned.glQuery);
          owned.glQuery = undefined; lane.metrics.gpuMs = null;
        } else {
          if (owned.glQuery && gl.getQueryParameter(owned.glQuery, gl.QUERY_RESULT_AVAILABLE)) {
            lane.metrics.gpuMs = Number(gl.getQueryParameter(owned.glQuery, gl.QUERY_RESULT)) / 1e6;
            gl.deleteQuery(owned.glQuery); owned.glQuery = undefined;
          }
          if (!owned.glQuery && now - owned.queryAt > 250) { query = gl.createQuery(); if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query); owned.queryAt = now; }
        }
      }
      owned.renderer.info.reset();
      const start = performance.now();
      try { owned.renderer.render(owned.scene, owned.camera); }
      finally { if (gl && query && owned.timerExt) { gl.endQuery(owned.timerExt.TIME_ELAPSED_EXT); owned.glQuery = query; } }
      const submitMs = performance.now() - start;
      if (api === 'webgpu' && !owned.timerPending && now - owned.queryAt > 250 && ((owned.renderer as WebGPURenderer).backend as unknown as { trackTimestamp?: boolean }).trackTimestamp) {
        owned.timerPending = true; owned.queryAt = now;
        void (owned.renderer as WebGPURenderer).resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(ms => {
          if (run === this.run && typeof ms === 'number' && Number.isFinite(ms)) lane.metrics.gpuMs = ms;
        }).catch(() => { lane.metrics.gpuMs = null; }).finally(() => { owned.timerPending = false; });
      }
      if (performance.now() - owned.started >= 1500) {
        const previous = owned.meter.previous;
        owned.meter.record(now, submitMs);
        if (previous !== null && now > previous) { owned.intervals.push(now - previous); if (owned.intervals.length > 240) owned.intervals.shift(); lane.metrics.frames++; }
      }
      if (now - owned.lastPublish < 500) return;
      owned.lastPublish = now;
      const stats = owned.meter.read();
      if (stats) { lane.metrics.fps = stats.fps; lane.metrics.frameMs = stats.frameMs; /* Startup submitMs is retained; rolling CPU is separate. */ lane.metrics.steadySubmitMs = stats.submitMs; }
      lane.metrics.medianMs = quantile(owned.intervals, .5); lane.metrics.p95Ms = quantile(owned.intervals, .95);
      owned.meter.clearWindow(); lane.current = `Үргэлжлүүлэн зурж байна · ${lane.metrics.frames} кадрын хоорондох хугацааг хэмжив`; this.counts(api, owned); this.emit(api);
    } catch (error) { this.fail(api, error); }
  }
  private resize() {
    if (!this.input) return;
    // Explicit dimensions are fixed and equal; CSS scales both canvases responsively.
    apis.forEach(api => {
      const owned = this.owned[api]; if (!owned) return;
      owned.renderer.setSize(this.input!.width, this.input!.height, false);
      owned.camera.aspect = this.input!.width / this.input!.height; owned.camera.updateProjectionMatrix();
      owned.meter.reset();
    });
  }
  private release(api: LiveApi) {
    const owned = this.owned[api]; if (!owned) return;
    delete this.owned[api]; cancelAnimationFrame(owned.raf);
    owned.cleanups.forEach(cleanup => cleanup()); owned.controls.dispose();
    if (owned.glQuery) ((owned.renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext).deleteQuery(owned.glQuery);
    if (owned.mesh instanceof THREE.InstancedMesh) owned.mesh.dispose();
    if (owned.mesh.geometry !== owned.geometry) owned.mesh.geometry.dispose();
    owned.geometry.dispose();
    const material = owned.mesh.material;
    (Array.isArray(material) ? material : [material]).forEach(m => m.dispose());
    this.disposeRenderer(owned.renderer); owned.renderer.domElement.remove(); owned.scene.clear();
  }
  private disposeRenderer(renderer: Renderer) {
    try {
      const result = renderer.dispose();
      if (result instanceof Promise) void result.catch(() => {
        ((renderer as WebGPURenderer).backend as unknown as { device?: GPUDevice })?.device?.destroy();
      });
      if (renderer instanceof THREE.WebGLRenderer) renderer.forceContextLoss();
    } catch { /* A lost context/device can reject disposal; loops and observers are already removed. */ }
  }
  dispose() {
    this.disposed = true; this.run++;
    cancelAnimationFrame(this.clockRaf); this.observer.disconnect();
    document.removeEventListener('visibilitychange', this.visibility);
    apis.forEach(api => this.release(api)); this.source?.dispose(); this.source = null;
  }
}
