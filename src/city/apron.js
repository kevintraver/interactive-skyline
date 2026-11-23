// An apron of ground around the outer terrain grid (the stability pass, plan 01): from the far grid's border out to
// where the fog has hidden the ground (exponential-squared, density 0.000014: 99 % at about 150 km), so a camera
// near the edge of its limits never sees the terrain end in a cliff with the sky below it.
//
//   shape    rings of the grid's border rectangle, grown outward; the first ring is the border itself at the grid's
//            own heights, an inner ring tucks under the grid so a step between two border samples shows ground,
//            not sky; outward the heights ease to a smoothed border height and fall with the Earth's curve
//            (curveDrop), as the terrain does
//   colour   the aerial photo's edge colours, averaged along the border, as vertex colours; the material follows the
//            far grid's (photo on or off, the night's street glow) on every draw
//   cost     about two thousand triangles, one draw; no shadows, never picked, not part of groundY or the limits
import * as THREE from 'three';
import { curveDrop } from '../core/earth.js';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { active } from '../render/active.js';

/** Distances of the rings beyond the border, in meters (the first, negative, tucks under the grid). */
export const APRON_RINGS = [-200, 0, 1500, 6000, 20000, 50000, 100000, 180000];
/** Spacing of the samples along the border, in meters. */
export const APRON_SEGMENT = 2000;
/** Outward, the heights ease from the border's own to a smoothed border height over this distance. */
const EASE_M = 8000;
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The border's samples: map positions walking around the grid, with an outward direction for each. */
export function borderSamples(hf, segment = APRON_SEGMENT) {
  const x0 = hf.x0, y0 = hf.y0, x1 = hf.x0 + (hf.nx - 1) * hf.step, y1 = hf.y0 + (hf.ny - 1) * hf.step;
  const nx = Math.max(2, Math.round((x1 - x0) / segment)), ny = Math.max(2, Math.round((y1 - y0) / segment));
  const out = [];
  // counter-clockwise seen from above (x east, y north): south side, east, north, west; corners point diagonally
  for (let i = 0; i < nx; i++) out.push({ x: x0 + ((x1 - x0) * i) / nx, y: y0, dx: i === 0 ? -1 : 0, dy: -1 });
  for (let j = 0; j < ny; j++) out.push({ x: x1, y: y0 + ((y1 - y0) * j) / ny, dx: 1, dy: j === 0 ? -1 : 0 });
  for (let i = 0; i < nx; i++) out.push({ x: x1 - ((x1 - x0) * i) / nx, y: y1, dx: i === 0 ? 1 : 0, dy: 1 });
  for (let j = 0; j < ny; j++) out.push({ x: x0, y: y1 - ((y1 - y0) * j) / ny, dx: -1, dy: j === 0 ? 1 : 0 });
  return out;
}

/** Average colours of the photo near each border sample (linear RGB), or grey without a readable image. */
function edgeTones(map, hf, samples) {
  const grey = samples.map(() => [0.5, 0.5, 0.5]);
  const img = map && map.image;
  if (!img || typeof OffscreenCanvas === 'undefined') return grey;
  try {
    const W = 256, H = Math.max(16, Math.round((256 * hf.ny) / hf.nx));
    const g = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const x0 = hf.x0, y0 = hf.y0, sx = (hf.nx - 1) * hf.step, sy = (hf.ny - 1) * hf.step;
    const R = 4; // a window of 9 x 9 texels of the small copy, about 3 km in Las Vegas, held inside the image
    return samples.map((s) => {
      // flipY is false: image row 0 is the grid's first row, the south edge
      const cu = Math.round(((s.x - x0) / sx) * (W - 1)), cv = Math.round(((s.y - y0) / sy) * (H - 1));
      const ci = Math.min(W - 1 - R, Math.max(R, cu)), cj = Math.min(H - 1 - R, Math.max(R, cv));
      const sum = [0, 0, 0];
      let n = 0;
      for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
        const k = (j * W + i) * 4;
        for (let c = 0; c < 3; c++) sum[c] += srgbToLinear(px[k + c] / 255);
        n++;
      }
      return sum.map((v) => v / n);
    });
  } catch { return grey; }
}

/** Smooth a closed list of numbers (or arrays of numbers) with a moving average over +-k entries. */
function smoothClosed(list, k) {
  const n = list.length, scalar = typeof list[0] === 'number';
  return list.map((_, i) => {
    let acc = scalar ? 0 : list[0].map(() => 0);
    for (let d = -k; d <= k; d++) {
      const v = list[(i + d + n) % n];
      if (scalar) acc += v; else acc = acc.map((a, c) => a + v[c]);
    }
    return scalar ? acc / (2 * k + 1) : acc.map((a) => a / (2 * k + 1));
  });
}

/** The apron's geometry: positions (world), vertex colours (photo tones), indices. Pure enough to unit-test. */
export function apronGeometry(hf, BASE, tones = null, { rings = APRON_RINGS, segment = APRON_SEGMENT } = {}) {
  const samples = borderSamples(hf, segment);
  const n = samples.length;
  const border = samples.map((s) => hf.sample(s.x, s.y));
  const far = smoothClosed(border, 6);
  const tone = tones || samples.map(() => [1, 1, 1]);
  const pos = new Float32Array(rings.length * n * 3), col = new Float32Array(rings.length * n * 3), nor = new Float32Array(rings.length * n * 3);
  rings.forEach((d, r) => {
    for (let i = 0; i < n; i++) {
      const s = samples[i], k = (r * n + i) * 3;
      const x = s.x + s.dx * d, y = s.y + s.dy * d;
      let h;
      if (d < 0) h = Math.min(border[i], hf.sample(x, y)) - 30; // under the grid: hidden where the grid is
      else { const t = Math.min(1, d / EASE_M), e = t * t * (3 - 2 * t); h = border[i] + (far[i] - border[i]) * e; }
      pos[k] = x; pos[k + 1] = h - BASE - curveDrop(x, y); pos[k + 2] = -y;
      col.set(tone[i], k);
      nor[k + 1] = 1;
    }
  });
  const idx = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i, b = r * n + ((i + 1) % n), c = a + n, e = b + n;
      // facing up (x east, z south): a, c, b and b, c, e
      idx.push(a, c, b, b, c, e);
    }
  }
  return { pos, col, nor, idx, samples };
}

/**
 * Build the apron for the far grid `hf` and its terrain mesh `farMesh` (whose material it follows), add it to the
 * scene, and return it.
 */
export function createApron({ scene, base }, hf, farMesh, map) {
  const samples = borderSamples(hf);
  const tonesRaw = edgeTones(map, hf, samples);
  const tones = smoothClosed(tonesRaw, 1);
  const g = apronGeometry(hf, base, tones);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.nor, 3));
  const color = new THREE.BufferAttribute(g.col.slice(), 3);
  geo.setAttribute('color', color);
  geo.setIndex(g.idx);
  geo.computeVertexNormals();
  const material = active.legacy ? new THREE.MeshLambertMaterial({ vertexColors: true }) : new MeshLambertNodeMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'terrain apron';
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.raycast = () => {}; // never picked
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  // the mean tone of the edge: the emissive (street glow) multiplied by the photo on the grid is that tone here
  const mean = [0, 1, 2].map((c) => tones.reduce((s, t) => s + t[c], 0) / tones.length);
  const meanTone = new THREE.Color(mean[0], mean[1], mean[2]);
  let photo = true;
  // follow the far grid's material on every draw (the photo switch, the night's glow, the look's pre-exposure)
  mesh.onBeforeRender = () => {
    const m = farMesh.material;
    const hasPhoto = !!m.map;
    if (hasPhoto !== photo) {
      photo = hasPhoto;
      if (photo) color.array.set(g.col); else color.array.fill(1);
      color.needsUpdate = true;
    }
    material.color.copy(m.color);
    material.emissive.copy(m.emissive);
    if (photo) material.emissive.multiply(meanTone);
    material.emissiveIntensity = m.emissiveIntensity;
  };
  scene.add(mesh);
  return mesh;
}
