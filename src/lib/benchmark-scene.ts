import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { WebGPURenderer } from 'three/webgpu';
import type { CaptureResult, LiveMetrics, RendererMode } from './benchmark';

type ActiveRenderer = THREE.WebGLRenderer | WebGPURenderer;

interface FrameSample {
  at: number;
  delta: number;
}

interface CaptureState {
  startedAt: number;
  frames: number;
  calls: number;
  triangles: number;
  points: number;
  hasCalls: boolean;
  hasTriangles: boolean;
  hasPoints: boolean;
  minFps: number;
  maxFps: number;
  windowCount: number;
  width: number;
  height: number;
  resolutionChanged: boolean;
}

function drawCallsForFrame(renderer: ActiveRenderer): number | null {
  const render = renderer.info.render as { calls?: number; drawCalls?: number };
  if (typeof render.drawCalls === 'number') return render.drawCalls;
  return typeof render.calls === 'number' ? render.calls : null;
}

export class BenchmarkScene {
  private renderer: ActiveRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private cubes: THREE.InstancedMesh | null = null;
  private controls: OrbitControls | null = null;
  private animationId = 0;
  private resizeObserver: ResizeObserver;
  private paused = false;
  private lastFrameAt = 0;
  private lastPublishAt = 0;
  private rollingFrames: FrameSample[] = [];
  private capture: CaptureState | null = null;
  private activeMode: RendererMode = 'webgl';
  private activeCount = 500;
  private disposed = false;

  constructor(
    private readonly host: HTMLDivElement,
    private readonly onMetrics: (metrics: LiveMetrics) => void,
  ) {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
  }

  async initialize(mode: RendererMode, count: number): Promise<{ backend: string; resolution: string }> {
    this.disposeRenderer();
    this.disposed = false;
    this.activeMode = mode;
    this.activeCount = count;
    this.paused = false;
    this.createScene(count);

    try {
      if (mode === 'webgpu') {
        const { WebGPURenderer: WebGPURendererImpl } = await import('three/webgpu');
        const webgpuRenderer = new WebGPURendererImpl({
          antialias: true,
          powerPreference: 'high-performance',
        });
        this.renderer = webgpuRenderer;
        await webgpuRenderer.init();
        if (!('isWebGPUBackend' in webgpuRenderer.backend) || webgpuRenderer.backend.isWebGPUBackend !== true) {
          throw new Error('Three.js initialized a WebGL fallback instead of a WebGPU backend.');
        }
      } else {
        this.renderer = new THREE.WebGLRenderer({
          antialias: true,
          powerPreference: 'high-performance',
        });
      }

      this.renderer.info.autoReset = false;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
      this.renderer.domElement.setAttribute('aria-label', `${mode === 'webgl' ? 'WebGL' : 'WebGPU'} rendered instanced cube scene`);
      this.host.appendChild(this.renderer.domElement);
      this.resize();
      this.rollingFrames = [];
      this.lastFrameAt = performance.now();
      this.lastPublishAt = this.lastFrameAt;
      this.animationId = requestAnimationFrame(this.animate);

      return {
        backend: mode === 'webgpu' ? 'WebGPU' : 'WebGL 2',
        resolution: `${this.renderer.domElement.width} × ${this.renderer.domElement.height}`,
      };
    } catch (error) {
      this.disposeRenderer();
      this.disposeScene();
      throw error;
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.lastFrameAt = performance.now();
    if (!paused && this.renderer) this.animationId = requestAnimationFrame(this.animate);
    if (paused) cancelAnimationFrame(this.animationId);
  }

  resetCamera() {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(0, 13, 24);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setCameraLocked(locked: boolean) {
    if (this.controls) this.controls.enabled = !locked;
  }

  resetSession() {
    this.disposeRenderer();
    this.disposeScene();
    this.paused = false;
    this.rollingFrames = [];
    this.lastFrameAt = 0;
  }

  beginCapture() {
    const width = this.renderer?.domElement.width ?? 0;
    const height = this.renderer?.domElement.height ?? 0;
    this.capture = {
      startedAt: performance.now(),
      frames: 0,
      calls: 0,
      triangles: 0,
      points: 0,
      hasCalls: false,
      hasTriangles: false,
      hasPoints: false,
      minFps: Infinity,
      maxFps: 0,
      windowCount: 0,
      width,
      height,
      resolutionChanged: false,
    };
    this.setCameraLocked(true);
  }

  finishCapture(): CaptureResult | null {
    const capture = this.capture;
    this.capture = null;
    this.setCameraLocked(false);
    if (!capture || capture.frames === 0) return null;
    const durationMs = performance.now() - capture.startedAt;
    if (durationMs <= 0) return null;

    return {
      avgFps: capture.frames * 1000 / durationMs,
      minFps: capture.windowCount ? capture.minFps : null,
      maxFps: capture.windowCount ? capture.maxFps : null,
      frameMs: durationMs / capture.frames,
      calls: capture.hasCalls ? capture.calls / capture.frames : null,
      triangles: capture.hasTriangles ? capture.triangles / capture.frames : null,
      points: capture.hasPoints ? capture.points / capture.frames : null,
      frames: capture.frames,
      durationMs,
      resolution: `${capture.width} × ${capture.height}`,
      resolutionChanged: capture.resolutionChanged,
    };
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.disposeRenderer();
    this.disposeScene();
  }

  private createScene(count: number) {
    this.disposeScene();
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1018');

    const camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 500);
    camera.position.set(0, 13, 24);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xb9d3ff, 0x18243a, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(8, 15, 11);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(0x7565ff, 38, 50, 2);
    rimLight.position.set(-11, 6, -7);
    scene.add(rimLight);

    const geometry = new THREE.BoxGeometry(0.72, 0.72, 0.72);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.36,
      metalness: 0.14,
    });
    const cubes = new THREE.InstancedMesh(geometry, material, count);
    cubes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const dummy = new THREE.Object3D();
    const colors = [0x70a7ff, 0x9a85ff, 0x55d6c2, 0xc3b9ff];
    const color = new THREE.Color();
    const side = Math.ceil(Math.sqrt(count));

    for (let index = 0; index < count; index += 1) {
      const column = index % side;
      const row = Math.floor(index / side);
      dummy.position.set((column - side / 2) * 1.15, 0, (row - side / 2) * 1.15);
      dummy.rotation.set((index % 7) * 0.04, (index % 11) * 0.05, (index % 5) * 0.03);
      dummy.updateMatrix();
      cubes.setMatrixAt(index, dummy.matrix);
      color.setHex(colors[index % colors.length]);
      cubes.setColorAt(index, color);
    }
    cubes.instanceMatrix.needsUpdate = true;
    if (cubes.instanceColor) cubes.instanceColor.needsUpdate = true;
    scene.add(cubes);

    const gridSize = Math.max(side * 1.3, 20);
    const grid = new THREE.GridHelper(gridSize, Math.max(side, 20), 0x36435a, 0x202c3d);
    grid.position.y = -0.42;
    scene.add(grid);

    this.scene = scene;
    this.camera = camera;
    this.cubes = cubes;
    this.controls = new OrbitControls(camera, this.host);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 70;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private disposeScene() {
    this.controls?.dispose();
    this.controls = null;
    if (this.scene) {
      this.scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
          if (object instanceof THREE.InstancedMesh) object.dispose();
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
    }
    this.scene = null;
    this.camera = null;
    this.cubes = null;
  }

  private disposeRenderer() {
    cancelAnimationFrame(this.animationId);
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.capture = null;
  }

  private resize() {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    if (this.capture && (this.renderer.domElement.width !== this.capture.width || this.renderer.domElement.height !== this.capture.height)) {
      this.capture.resolutionChanged = true;
    }
  }

  private animate = (now: number) => {
    if (this.disposed || this.paused || !this.renderer || !this.scene || !this.camera || !this.cubes) return;
    this.animationId = requestAnimationFrame(this.animate);
    const delta = now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (delta > 0) this.rollingFrames.push({ at: now, delta });
    while (this.rollingFrames.length && now - this.rollingFrames[0].at > 1200) this.rollingFrames.shift();

    this.cubes.rotation.y += Math.min(delta, 50) * 0.00022;
    this.cubes.rotation.x = Math.sin(now * 0.00025) * 0.08;
    this.controls?.update();
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);

    if (this.capture && delta > 0) {
      const capture = this.capture;
      const renderInfo = this.renderer.info.render;
      capture.frames += 1;
      const drawCalls = drawCallsForFrame(this.renderer);
      if (drawCalls !== null) {
        capture.calls += drawCalls;
        capture.hasCalls = true;
      }
      if (typeof renderInfo.triangles === 'number') {
        capture.triangles += renderInfo.triangles;
        capture.hasTriangles = true;
      }
      if (typeof renderInfo.points === 'number') {
        capture.points += renderInfo.points;
        capture.hasPoints = true;
      }
    }

    if (now - this.lastPublishAt < 500) return;
    this.lastPublishAt = now;
    const elapsed = this.rollingFrames.reduce((total, frame) => total + frame.delta, 0);
    const fps = elapsed > 0 ? this.rollingFrames.length * 1000 / elapsed : 0;
    const frameMs = this.rollingFrames.length ? elapsed / this.rollingFrames.length : 0;
    if (this.capture && this.rollingFrames.length > 1) {
      this.capture.minFps = Math.min(this.capture.minFps, fps);
      this.capture.maxFps = Math.max(this.capture.maxFps, fps);
      this.capture.windowCount += 1;
    }
    const renderInfo = this.renderer.info.render;
    const captureElapsed = this.capture ? now - this.capture.startedAt : 0;
    this.onMetrics({
      fps,
      avgFps: this.capture && captureElapsed > 0
        ? this.capture.frames * 1000 / captureElapsed
        : fps,
      minFps: this.capture?.windowCount ? this.capture.minFps : null,
      maxFps: this.capture?.windowCount ? this.capture.maxFps : null,
      frameMs,
      calls: drawCallsForFrame(this.renderer),
      triangles: typeof renderInfo.triangles === 'number' ? renderInfo.triangles : null,
      points: typeof renderInfo.points === 'number' ? renderInfo.points : null,
      count: this.activeCount,
      backend: this.activeMode === 'webgl' ? 'WebGL 2' : 'WebGPU',
      mode: this.activeMode,
    });
  };
}
