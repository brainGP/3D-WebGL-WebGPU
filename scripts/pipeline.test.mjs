import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { newLane, completionComparison, quantile, launchBoth } from '../src/lib/live-lifecycle.ts';
import { largestStartupGap } from '../src/lib/live-explanations.ts';
import { FrameMeter } from '../src/lib/frame-meter.ts';
import { makeGeometry, stageAt, rasterize, setCameraConvention, VERTEX_LEVELS, TOTAL_SECONDS } from '../src/lib/pipeline.ts';

test('timeline boundaries and completion are deterministic', () => {
  assert.deepEqual(stageAt(-5), { stage: 0, progress: 0 });
  assert.deepEqual(stageAt(6), { stage: 1, progress: 0 });
  assert.equal(stageAt(17.5).stage, 2);
  assert.ok(Math.abs(stageAt(17.5).progress - 11 / 12) < 1e-12);
  assert.deepEqual(stageAt(TOTAL_SECONDS), { stage: 5, progress: 1 });
});
for (const count of VERTEX_LEVELS) test(`benchmark has exactly ${count} positions and valid triangle indices`, () => {
  const g = makeGeometry('sphere', count);
  assert.equal(g.attributes.position.count, count);
  assert.equal(g.attributes.normal.count, count);
  assert.equal(g.index.count % 3, 0);
  assert.ok(g.index.count > 0);
  assert.ok(Math.max(...g.index.array.slice(-1000)) < count);
  for (const index of g.index.array) assert.ok(index >= 0 && index < count);
  for (const v of g.attributes.position.array) assert.ok(Number.isFinite(v));
  g.dispose();
});
for (const kind of ['cube', 'sphere', 'torus', 'knot', 'particles']) test(`${kind} geometry supports its advertised topology`, () => {
  const g = makeGeometry(kind);
  assert.ok(g.attributes.position.count > 0);
  assert.equal(g.attributes.normal.count, g.attributes.position.count);
  if (kind === 'particles') { assert.equal(g.attributes.position.count, 100000); assert.equal(g.index, null); }
  else assert.ok(g.index.count >= 36);
  g.dispose();
});
function triangle(vertices) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.computeVertexNormals();
  return g;
}
test('rasterizer uses sample-center triangle coverage and barycentric shading', () => {
  const g = triangle([-.5, -.5, 0, .5, -.5, 0, 0, .5, 0]);
  const image = rasterize(g, new THREE.Matrix4(), new THREE.Matrix3(), 8);
  assert.equal(image.covered, 8);
  assert.equal(image.colors[(4 * 8 + 4) * 4 + 3], 255);
  assert.equal(image.colors[3], 0);
  g.dispose();
});
test('z-buffer selects the nearer triangle regardless of submission order', () => {
  const a = [-.5, -.5, -.5, .5, -.5, -.5, 0, .5, -.5];
  const b = [-.5, -.5, .5, 0, .5, .5, .5, -.5, .5];
  const first = triangle([...a, ...b]);
  const second = triangle([...b, ...a]);
  const image1 = rasterize(first, new THREE.Matrix4(), new THREE.Matrix3(), 16);
  const image2 = rasterize(second, new THREE.Matrix4(), new THREE.Matrix3(), 16);
  assert.deepEqual(image1.colors, image2.colors);
  first.dispose(); second.dispose();
});
test('degenerate triangles and triangles outside depth produce no coverage', () => {
  for (const vertices of [[0, 0, 0, 0, 0, 0, 0, 0, 0], [-.5, -.5, 2, .5, -.5, 2, 0, .5, 2]]) {
    const g = triangle(vertices);
    assert.equal(rasterize(g, new THREE.Matrix4(), new THREE.Matrix3()).covered, 0);
    g.dispose();
  }
});

test('WebGL and WebGPU preserve projected X/Y while mapping near depth correctly', () => {
  const camera = new THREE.PerspectiveCamera(42, 4 / 3, .1, 100);
  const point = new THREE.Vector3(.2, .3, -4);
  setCameraConvention(camera, THREE.WebGLCoordinateSystem);
  const gl = point.clone().applyMatrix4(camera.projectionMatrix);
  assert.ok(Math.abs(new THREE.Vector3(0, 0, -.1).applyMatrix4(camera.projectionMatrix).z + 1) < 1e-6);
  const original = camera.projectionMatrix.toArray();
  setCameraConvention(camera, THREE.WebGPUCoordinateSystem);
  const gpu = point.clone().applyMatrix4(camera.projectionMatrix);
  assert.equal(gl.x, gpu.x); assert.equal(gl.y, gpu.y);
  assert.ok(Math.abs(new THREE.Vector3(0, 0, -.1).applyMatrix4(camera.projectionMatrix).z) < 1e-6);
  assert.ok(Math.abs(new THREE.Vector3(0, 0, -100).applyMatrix4(camera.projectionMatrix).z - 1) < 1e-6);
  setCameraConvention(camera, THREE.WebGLCoordinateSystem);
  assert.deepEqual(camera.projectionMatrix.toArray(), original);
});

test('separate renderers measure different actual submission cadences without timeline scaling', () => {
  const gl = new FrameMeter();
  const gpu = new FrameMeter();
  for (const at of [0, 10, 20, 30]) gl.record(at, 2);
  for (const at of [0, 30]) gpu.record(at, .5);
  assert.equal(gl.read().fps, 100);
  assert.ok(Math.abs(gpu.read().fps - 1000 / 30) < 1e-10);
  assert.equal(gl.read().frameMs, 10);
  assert.equal(gpu.read().frameMs, 30);
  assert.equal(gl.read().submitMs, 2);
  assert.equal(gpu.read().submitMs, .5);
});
test('no baseline or paused samples produce fabricated FPS', () => {
  const meter = new FrameMeter();
  assert.equal(meter.read(), null);
  meter.record(1000, 1);
  assert.equal(meter.read(), null);
  meter.record(1020, 1);
  meter.reset();
  meter.record(9000, 1);
  assert.equal(meter.read(), null);
  meter.record(9020, 1);
  assert.equal(meter.read().fps, 50);
});
test('telemetry windows retain the previous real frame boundary', () => {
  const meter = new FrameMeter();
  meter.record(0, 2); meter.record(10, 2);
  meter.clearWindow();
  assert.equal(meter.read(), null);
  meter.record(30, 4);
  assert.equal(meter.read().fps, 50);
  assert.equal(meter.read().submitMs, 4);
});
test('optional 500K geometry has exact source size and no out-of-range indices', () => {
  const geometry = makeGeometry('sphere', 500000);
  assert.equal(geometry.attributes.position.count, 500000);
  assert.equal(geometry.attributes.normal.count, 500000);
  assert.equal(geometry.index.count % 3, 0);
  for (const i of geometry.index.array) assert.ok(i >= 0 && i < 500000);
  geometry.dispose();
});

test('completion winner is measured symmetrically with a documented tolerance', () => {
  const gl = newLane('webgl', 1, 1000), gpu = newLane('webgpu', 1, 1000);
  gl.state = gpu.state = 'complete';
  gl.metrics.completionMs = 100; gpu.metrics.completionMs = 150;
  let result = completionComparison(gl, gpu);
  assert.equal(result.winner, 'webgl'); assert.equal(result.differenceMs, 50);
  assert.equal(result.ratio, 1.5); assert.ok(Math.abs(result.percentLessTime - 100 / 3) < 1e-8);
  gl.metrics.completionMs = 150; gpu.metrics.completionMs = 100;
  assert.equal(completionComparison(gl, gpu).winner, 'webgpu');
  gpu.metrics.completionMs = 149;
  assert.equal(completionComparison(gl, gpu).winner, null);
});
test('failure, mixed starts, and unresolved signals cannot produce a winner', () => {
  const a = newLane('webgl', 1, 100), b = newLane('webgpu', 1, 100);
  a.metrics.completionMs = 10; b.metrics.completionMs = 20;
  a.state = 'complete'; b.state = 'error'; assert.equal(completionComparison(a, b), null);
  b.state = 'complete'; b.run = 2; assert.equal(completionComparison(a, b), null);
  b.run = 1; b.commonStart = 101; assert.equal(completionComparison(a, b), null);
  b.commonStart = 100; b.metrics.completionMs = null; assert.equal(completionComparison(a, b), null);
});
test('notification delay expands the comparison tolerance', () => {
  const a = newLane('webgl', 1, 100), b = newLane('webgpu', 1, 100);
  a.state = b.state = 'complete'; a.metrics.completionMs = 100; b.metrics.completionMs = 110;
  a.detectorMs = 8;
  assert.equal(completionComparison(a, b).winner, null);
});
test('median and p95 use measured samples and preserve an unavailable empty window', () => {
  assert.equal(quantile([], .5), null);
  assert.equal(quantile([30, 10, 20], .5), 20);
  assert.equal(quantile([10, 20, 30], .95), 29);
});

test('both initialization tasks start before either completion is awaited', async () => {
  const started = [];
  const releases = {};
  const settled = launchBoth(api => { started.push(api); return new Promise(resolve => { releases[api] = resolve; }); });
  await Promise.resolve();
  assert.deepEqual(started.sort(), ['webgl', 'webgpu']);
  releases.webgl('GL ready'); releases.webgpu('GPU ready');
  assert.equal((await settled).filter(value => value.status === 'fulfilled').length, 2);
});
test('failed initialization does not stop the independent peer', async () => {
  let glComplete = false;
  const result = await launchBoth(async api => {
    if (api === 'webgpu') throw new Error('Unsupported');
    await Promise.resolve(); glComplete = true; return 'frame ready';
  });
  assert.ok(glComplete);
  assert.equal(result.filter(value => value.status === 'rejected').length, 1);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
});

test('canonical position/index data can be copied into independently mutable owned buffers', () => {
  const source = makeGeometry('knot');
  const gl = source.clone(), gpu = source.clone();
  assert.notEqual(gl.attributes.position.array, gpu.attributes.position.array);
  assert.notEqual(gl.index.array, gpu.index.array);
  assert.deepEqual(gl.attributes.position.array, gpu.attributes.position.array);
  assert.deepEqual(gl.index.array, gpu.index.array);
  const original = source.attributes.position.getX(0);
  gl.attributes.position.setX(0, original + 123);
  assert.equal(gpu.attributes.position.getX(0), original);
  assert.equal(source.attributes.position.getX(0), original);
  source.dispose(); gl.dispose(); gpu.dispose();
});

test('startup explanation reflects either API being faster, without a preset cause', () => {
  const gl = newLane('webgl', 1, 1000), gpu = newLane('webgpu', 1, 1000);
  gl.state = gpu.state = 'complete';
  gl.metrics.setupMs = 100; gpu.metrics.setupMs = 20;
  gl.metrics.deviceMs = 4; gpu.metrics.deviceMs = 10;
  assert.equal(largestStartupGap(gl, gpu).gapMs, -80);
  gpu.metrics.setupMs = 200;
  assert.equal(largestStartupGap(gl, gpu).gapMs, 100);
});
test('startup explanation cannot infer a gap from failed, missing or stale measurements', () => {
  const gl = newLane('webgl', 1, 1000), gpu = newLane('webgpu', 1, 1000);
  gl.state = gpu.state = 'complete';
  assert.equal(largestStartupGap(gl, gpu), null);
  gl.metrics.deviceMs = 10; gpu.metrics.deviceMs = 20;
  gpu.state = 'unsupported'; assert.equal(largestStartupGap(gl, gpu), null);
  gpu.state = 'complete'; gpu.run = 2; assert.equal(largestStartupGap(gl, gpu), null);
});
