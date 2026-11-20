import * as THREE from 'three';

export const STAGE_SECONDS = 6;
export const TOTAL_SECONDS = STAGE_SECONDS * 6;
export const VERTEX_LEVELS = [1000, 10000, 50000, 100000] as const;
export type ObjectKind = 'cube' | 'sphere' | 'torus' | 'knot' | 'particles';
export type DisplayMode = 'pipeline' | 'vertices' | 'wireframe' | 'solid' | 'triangles' | 'normals';
export type Layout = 'split' | 'webgl' | 'webgpu' | 'difference';
/** Keep shared camera pose/FOV identical while adapting each API's depth convention. */
export function setCameraConvention(camera: THREE.PerspectiveCamera, convention: THREE.CoordinateSystem) {
  if (camera.coordinateSystem !== convention) {
    camera.coordinateSystem = convention;
    camera.updateProjectionMatrix();
  }
}
export function stageAt(time: number) {
  const stage = Math.min(5, Math.max(0, Math.floor(time / STAGE_SECONDS)));
  return { stage, progress: Math.min(1, Math.max(0, time / STAGE_SECONDS - stage)) };
}

export function makeGeometry(kind: ObjectKind, count?: number): THREE.BufferGeometry {
  if (count) {
    // Exact vertex-buffer size. Indexed UV sphere, including a partial final row.
    const columns = Math.floor(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const positions = new Float32Array(count * 3);
    const indices: number[] = [];
    for (let i = 0; i < count; i++) {
      const u = (i % columns) / (columns - 1) * Math.PI * 2;
      const v = Math.floor(i / columns) / (rows - 1) * Math.PI;
      positions.set([1.8 * Math.sin(v) * Math.cos(u), 1.8 * Math.cos(v), 1.8 * Math.sin(v) * Math.sin(u)], i * 3);
      if (i % columns < columns - 1 && i + columns + 1 < count) indices.push(i, i + columns, i + 1, i + 1, i + columns, i + columns + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }
  switch (kind) {
    case 'cube': return new THREE.BoxGeometry(2.7, 2.7, 2.7);
    case 'sphere': return new THREE.SphereGeometry(1.8, 24, 16);
    case 'torus': return new THREE.TorusGeometry(1.35, .5, 12, 32);
    case 'knot': return new THREE.TorusKnotGeometry(1.15, .38, 80, 10);
    case 'particles': {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(100000 * 3);
      const angle = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < 100000; i++) {
        const y = 1 - i / 99999 * 2;
        const r = Math.sqrt(1 - y * y);
        positions.set([1.8 * Math.cos(i * angle) * r, 1.8 * y, 1.8 * Math.sin(i * angle) * r], i * 3);
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(positions.map(v => v / 1.8), 3));
      return geometry;
    }
  }
}

export interface RasterImage { colors: Uint8ClampedArray; covered: number; width: number; height: number }
/** CPU teaching rasterizer: sample-center coverage, barycentric interpolation and z-buffer.
 * Not a capture of the hardware rasterizer; no clipping, MSAA or perspective-correct attributes.
 * Triangles intersecting the near plane are skipped. The orbit camera stays outside the object.
 */
export function rasterize(geometry: THREE.BufferGeometry, mvp: THREE.Matrix4, normalMatrix: THREE.Matrix3, size = 64): RasterImage {
  const colors = new Uint8ClampedArray(size * size * 4);
  const depth = new Float32Array(size * size).fill(Infinity);
  const position = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const projected: number[][] = [];
  const light = new THREE.Vector3(.5, .8, 1).normalize();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).applyMatrix4(mvp);
    const shade = normals ? Math.max(0, n.fromBufferAttribute(normals, i).applyNormalMatrix(normalMatrix).dot(light)) * .8 + .2 : 1;
    projected.push([(p.x * .5 + .5) * size, (-p.y * .5 + .5) * size, p.z, shade]);
  }
  const index = geometry.index;
  const count = index?.count ?? position.count;
  const edge = (a: number[], b: number[], x: number, y: number) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  for (let i = 0; i + 2 < count; i += 3) {
    const a = projected[index ? index.getX(i) : i];
    const b = projected[index ? index.getX(i + 1) : i + 1];
    const c = projected[index ? index.getX(i + 2) : i + 2];
    if ([a, b, c].some(v => v[2] < -1 || v[2] > 1)) continue;
    const area = edge(a, b, c[0], c[1]);
    if (Math.abs(area) < 1e-8) continue;
    for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))); y < Math.min(size, Math.ceil(Math.max(a[1], b[1], c[1]))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))); x < Math.min(size, Math.ceil(Math.max(a[0], b[0], c[0]))); x++) {
        const w0 = edge(b, c, x + .5, y + .5) / area;
        const w1 = edge(c, a, x + .5, y + .5) / area;
        const w2 = 1 - w0 - w1;
        if (Math.min(w0, w1, w2) < -1e-7) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const pixel = y * size + x;
        if (z >= depth[pixel]) continue;
        depth[pixel] = z;
        const shade = w0 * a[3] + w1 * b[3] + w2 * c[3];
        colors.set([90 * shade, 160 * shade, 255 * shade, 255], pixel * 4);
      }
    }
  }
  return { colors, covered: depth.reduce((sum, z) => sum + (z < Infinity ? 1 : 0), 0), width: size, height: size };
}
