// The cloud a flight draws round itself (plan 03, F2.8's as-flown weather, 7.14), while plan 01's renderer has none.
//
// Plan 01's sky on this branch is today's dome with a fixed exponential fog (src/sky/legacySky.js): it draws no cloud
// layer and its fog does not follow the weather (its phases 3 and 6 are not merged here). So the flight draws the
// honest minimum itself, from the layers env.js sky() gives (the flight's as-flown record, or plan 01's sample when the
// visitor picked other weather):
//
//   the veil   camera-centred shells, each the extinction of the air between it and the one inside it
//              (1 - exp(-sigma dr), sigma = 3.912 / visibility, Koschmieder), so the view fades with distance as the
//              visibility at the eye says: inside a broken or overcast layer a white-out a hundred metres deep (the wing
//              still shows, the ground does not), under the base the reported visibility. Clear air above (80 km) draws
//              nothing: the scene's fog does that.
//   the decks  each layer as a curved sheet at its top when the eye is above it (lit by the scene's lights: white in
//              the Sun) and at its base when the eye is below it (the haze's grey), following the frame's curve
//              (frame.sceneY) out to beyond the eye's horizon; a layer short of overcast is cut into patches by noise in
//              proportion to its cover. Inside the layer's heights neither is drawn: the veil is the cloud.
//
// What this is not: a cloud renderer. No shape, light or shadow inside the layer, no cloud shadow on the ground (plan
// 01's light still has the Sun on it), and a deck is flat where real tops billow. When plan 01's clouds land, this goes.
import { Group, Mesh, SphereGeometry, BufferGeometry, BufferAttribute, BackSide, FrontSide, Vector3 } from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { uniform, vec3, float, mix, dot, positionWorld, positionLocal, cameraPosition, smoothstep, length, normalize, exp, abs, max, mx_noise_float, Fn } from 'three/tsl';
import { altitudeOf, horizonDistance } from '../core/earth.js';
import { cloudAt, CLEAR_VISIBILITY_M } from './env.js';

/** Koschmieder's constant: visual range = 3.912 / extinction. */
export const KOSCHMIEDER = 3.912;
/** The shells' radii (m): geometric from 3 m (inside the wing's span) to beyond the horizon of a low eye. */
export const SHELL_RADII = Object.freeze(Array.from({ length: 18 }, (_, k) => 3 * 1.8 ** k));
/** At most this many shells are drawn (each is a full-screen blend). */
export const MAX_SHELLS = 10;
/** A shell thinner than this is skipped; the shell where the remaining transmittance falls below CUTOFF is opaque. */
const MIN_ALPHA = 0.01, CUTOFF = 0.01;
/** Ice cloud: drawn as a thin veil, not an opaque sheet. */
const ICE = new Set(['ci', 'cs']);
/** Visibility at or beyond this draws no veil (the scene's fog stands for clear air). */
export const VEIL_FROM_M = 0.9 * CLEAR_VISIBILITY_M;

/**
 * The shells for an extinction coefficient: [{ radius, alpha }], innermost first, the last opaque when the view is
 * used up before the last radius. Pure.
 */
export function veilShells(sigma, { radii = SHELL_RADII, max = MAX_SHELLS } = {}) {
  if (!(sigma > 0)) return [];
  const out = [];
  let inner = 0, T = 1, pending = 0;
  for (const r of radii) {
    // the air from the last drawn shell to this one, merged into this shell when the ones between were too thin
    const a = 1 - Math.exp(-sigma * (r - inner));
    pending = 1 - (1 - pending) * (1 - a);
    inner = r;
    if (pending < MIN_ALPHA && T * Math.exp(-sigma * r) > CUTOFF) continue;
    T *= 1 - pending;
    if (T <= CUTOFF || out.length === max - 1) { out.push({ radius: r, alpha: 1 }); return out; }
    out.push({ radius: r, alpha: pending });
    pending = 0;
  }
  return out;
}

/**
 * Which decks to draw for an eye at `altM`: a layer's top when the eye is above it, its base when below, none inside.
 * Pure. @returns {{ layer: object, side: 'top' | 'base', heightM: number }[]}
 */
export function decksFor(layers, altM) {
  const out = [];
  for (const l of layers) {
    const cover = l.fraction ?? l.cover ?? 0;
    if (!(cover > 0)) continue;
    if (altM > l.topM) out.push({ layer: l, side: 'top', heightM: l.topM, cover });
    else if (altM < l.baseM) out.push({ layer: l, side: 'base', heightM: l.baseM, cover });
  }
  return out;
}

/** Rings of the deck's disc, as fractions of its radius: dense near the eye. */
const RINGS = 40, SEGMENTS = 72;

function discGeometry() {
  const n = 1 + RINGS * SEGMENTS;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
  const normal = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) normal[i * 3 + 1] = 1;
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  const idx = [];
  for (let s = 0; s < SEGMENTS; s++) idx.push(0, 1 + ((s + 1) % SEGMENTS), 1 + s);
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = 1 + r * SEGMENTS + s, b = 1 + r * SEGMENTS + ((s + 1) % SEGMENTS);
      const c = a + SEGMENTS, d = b + SEGMENTS;
      idx.push(a, b, d, a, d, c);
    }
  }
  g.setIndex(idx);
  return g;
}

/** Fill a disc of radius R about the eye's (x, z) at height H above sea level on the frame's curve. */
function placeDisc(g, frame, cx, cz, H, R, down) {
  const p = g.attributes.position.array, nrm = g.attributes.normal.array;
  const y0 = frame.sceneY(H, cx, -cz);
  p[0] = 0; p[1] = 0; p[2] = 0;
  for (let r = 0; r < RINGS; r++) {
    const rad = R * ((r + 1) / RINGS) ** 2;
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2, dx = Math.cos(a) * rad, dz = Math.sin(a) * rad;
      const i = (1 + r * SEGMENTS + s) * 3;
      p[i] = dx; p[i + 1] = frame.sceneY(H, cx + dx, -(cz + dz)) - y0; p[i + 2] = dz;
    }
  }
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = down ? -1 : 1;
  g.attributes.position.needsUpdate = true;
  g.attributes.normal.needsUpdate = true;
  g.computeBoundingSphere();
  return y0;
}

/**
 * @param {{ fe: object, scene: import('three').Scene, haze?: { value: import('three').Color } }} o
 *   haze: the scene fog's colour uniform (plan 01's shared one), which the veil and the cloud's underside take
 */
export function createClouds({ fe, scene, haze = null }) {
  const group = new Group();
  group.name = 'flight-clouds';
  const city = fe.city;
  const hazeNode = haze ?? uniform(new Vector3(0.83, 0.87, 0.91));
  // the cloud's own grey: the haze with most of its colour taken out (by day a light grey, at night a dark one)
  const grey = Fn(() => { const h = vec3(hazeNode); return mix(h, vec3(dot(h, vec3(0.2126, 0.7152, 0.0722))), 0.8); });

  // the veil
  const shellGeom = new SphereGeometry(1, 48, 24);
  const shells = [];
  for (let i = 0; i < MAX_SHELLS; i++) {
    const alpha = uniform(0);
    const m = new MeshBasicNodeMaterial({ name: 'flight-cloud-veil', transparent: true, depthWrite: false, side: BackSide, fog: false });
    m.colorNode = grey();
    m.opacityNode = alpha;
    const mesh = new Mesh(shellGeom, m);
    mesh.name = `flight-cloud-veil-${i}`;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.raycast = () => {};
    mesh.visible = false;
    mesh.renderOrder = 10000 + MAX_SHELLS - i; // outermost first: back to front
    group.add(mesh);
    shells.push({ mesh, alpha });
  }

  // the decks: one disc each for up to four layers; its material by the side it is seen from and the cloud's kind:
  // an overcast of water cloud is an opaque sheet, broken or fewer clouds are soft patches covering the reported share,
  // ice cloud (cirrus, cirrostratus) is a thin veil.
  /** Optical depth of an ice-cloud deck seen straight through (ESTIMATED: thin cirrostratus lets most of the sky
   * through overhead); along a slant the path is longer, 1 / sin(elevation), so it whitens toward the horizon. */
  const THIN_TAU = 0.25;
  function deckMaterial(side, kind) {
    const cover = uniform(1), radius = uniform(1e5), seed = uniform(0);
    const lit = side === 'top';
    const o = { side: FrontSide, ...(kind !== 'solid' ? { transparent: true, depthWrite: false } : {}) };
    const name = `flight-cloud-${side}-${kind}`;
    const m = lit ? new MeshStandardNodeMaterial({ name, roughness: 1, metalness: 0, ...o }) : new MeshBasicNodeMaterial({ name, ...o });
    const xz = positionWorld.xz;
    // two octaves of noise fixed to the ground (the patches stay where they are as the aircraft flies past), spread
    // to about 0..1 so that the share above a threshold is about the cover
    const raw = mx_noise_float(vec3(xz.div(3500), seed)).mul(0.65).add(mx_noise_float(vec3(xz.div(900), seed.add(7))).mul(0.35));
    const n = raw.mul(1.6).add(0.5).clamp(0, 1);
    const fine = mx_noise_float(vec3(xz.div(260), seed.add(3))).mul(0.5).add(0.5);
    // the tops in the Sun: white with a little relief; the base: the haze's grey, darker where thick
    if (lit) m.colorNode = vec3(0.95).mul(float(0.84).add(n.mul(0.1)).add(fine.mul(0.06)));
    else m.colorNode = grey().mul(kind === 'thin' ? 1.0 : float(0.8).add(n.mul(0.12)));
    if (kind !== 'solid') {
      m.opacityNode = Fn(() => {
        const edge = smoothstep(0.7, 1.0, length(positionLocal.xz).div(radius));
        const t = float(1).sub(cover);
        const patch = cover.greaterThanEqual(0.999).select(float(1), smoothstep(t.sub(0.1), t.add(0.1), n));
        const shape = patch.mul(float(1).sub(edge));
        if (kind !== 'thin') return shape;
        const slant = max(abs(normalize(positionWorld.sub(cameraPosition)).y), 0.03);
        return float(1).sub(exp(shape.mul(float(0.7).add(fine.mul(0.3))).mul(-THIN_TAU).div(slant)));
      })();
    }
    return { m, cover, radius, seed };
  }
  const KINDS = ['solid', 'patchy', 'thin'];
  const decks = [];
  for (let i = 0; i < 4; i++) {
    const mats = {};
    for (const side of ['top', 'base']) for (const k of KINDS) mats[`${side}-${k}`] = deckMaterial(side, k);
    const mesh = new Mesh(discGeometry(), mats['top-solid'].m);
    mesh.name = `flight-cloud-deck-${i}`;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.raycast = () => {};
    mesh.visible = false;
    group.add(mesh);
    decks.push({ mesh, mats, key: '' });
  }
  const kindOf = (w) => (ICE.has(w.layer.genus) ? 'thin' : w.cover >= 0.999 ? 'solid' : 'patchy');

  const _eye = new Vector3();
  let last = { veil: [], decks: [], visibilityM: CLEAR_VISIBILITY_M, inCloud: false, source: 'standard', altitudeM: NaN };

  return {
    group,
    /** Place everything round the camera for this frame (after the camera is placed, before the render). */
    update(camera) {
      camera.getWorldPosition(_eye);
      const alt = altitudeOf(_eye, city);
      const sky = fe.sky();
      const here = cloudAt(sky.layers, alt, { belowBaseM: sky.belowBaseM });
      // the veil
      const sigma = here.visibilityM < VEIL_FROM_M ? KOSCHMIEDER / here.visibilityM : 0;
      const list = veilShells(sigma);
      shells.forEach((s, i) => {
        const v = list[i];
        s.mesh.visible = !!v;
        if (!v) return;
        s.mesh.position.copy(_eye);
        s.mesh.scale.setScalar(Math.min(v.radius, camera.far * 0.95));
        s.alpha.value = v.alpha;
      });
      // the decks
      const want = decksFor(sky.layers, alt).slice(0, decks.length);
      const R = Math.min(Math.max(horizonDistance(Math.max(alt - (city.base ?? 0), 10)) * 1.15, 40000), camera.far * 0.9);
      decks.forEach((d, i) => {
        const w = want[i];
        d.mesh.visible = !!w;
        if (!w) return;
        const mat = d.mats[`${w.side}-${kindOf(w)}`];
        d.mesh.material = mat.m;
        mat.cover.value = Math.min(1, w.cover);
        mat.radius.value = R;
        mat.seed.value = i * 13.7 + w.heightM / 1000;
        const key = `${w.side}:${w.heightM}:${Math.round(R / 1000)}`;
        const moved = d.cx === undefined || Math.hypot(_eye.x - d.cx, _eye.z - d.cz) > Math.max(200, R * 0.004);
        if (moved || key !== d.key) {
          d.cx = _eye.x; d.cz = _eye.z; d.key = key;
          d.y0 = placeDisc(d.mesh.geometry, fe.frame, d.cx, d.cz, w.heightM, R, w.side === 'base');
        }
        d.mesh.position.set(d.cx, d.y0, d.cz);
      });
      last = { veil: list, decks: want.map((w) => ({ side: w.side, heightM: w.heightM, cover: w.cover, genus: w.layer.genus, kind: kindOf(w) })),
        visibilityM: here.visibilityM, inCloud: here.inCloud, source: sky.source, altitudeM: alt };
      return last;
    },
    /** What the last update drew: for the debug hooks and the tests. */
    stats: () => ({ ...last, shells: last.veil.length }),
    dispose() {
      group.removeFromParent();
      shellGeom.dispose();
      for (const s of shells) s.mesh.material.dispose();
      for (const d of decks) { d.mesh.geometry.dispose(); for (const k of Object.keys(d.mats)) d.mats[k].m.dispose(); }
    },
  };
}
