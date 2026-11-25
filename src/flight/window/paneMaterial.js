// The pane's node material (plan 03, section 7.7; F5.2, F5.4 to F5.6): section 7.7's equation, drawn on the inner
// pane's quads, treating the three sheets as one thin layer that transmits, scatters, refracts and reflects.
//
//   L = T(theta) tint [ (1 - sN - sW) outside(screenUV + drop refraction)      the view, bent inside drops
//                      + sN outsideBlur(narrow, across the scratch)             glare of scratches and dirt (lamps)
//                      + sW outsideBlur(wide) ]                                 frost, fog and mist: nearly diffuse
//     + Esun visible scatter(theta_sun) (dirt + scratches + frost + fog)        the sun on the pane itself
//     + R_inner cabin(reflect) + R_outer cabin(reflect, from the outer pane)    the cabin, mirrored (twice above Low)
//
// `outside` is the frame behind the pane with a mip chain. In the app (F3.9) it is the cabin stage's copy of the
// finished outside picture (view/cabinStage.js: world and airframe, no cabin), through the `outside` option:
// (uv, level) => colour node. Without it (the standalone harness) it is three's viewportMipTexture, a copy of the pass's
// colour made when the pane is drawn. The pane is laid under what is already drawn behind it (the window's structure),
// so it shows only through the model's opening.
//
// Pane coordinates come from the geometry (instance-local, body axes): u aft along z, v up along the ring. The outer
// pane's point is the view ray carried on across the gap (so the layers shift against each other as the head moves);
// frost lives there, and the drops. The breather hole is on the middle pane.
//
// Focus (F5.6): focused far (the default), a point on the pane 35 cm away is blurred over the aperture (3.5 mm,
// ESTIMATED: a pupil by day or a phone's lens), so the pane's textures are read with a mip bias of that blur: scratches
// tens of microns wide dissolve into a veil that only shows near a light. Focused on the pane, the bias goes and the
// outside is blurred by the matching angle instead (about 0.5 degrees).
//
// Light is in buffer units throughout: the outside samples already are; the sun's illuminance comes in multiplied by
// the pre-exposure (paneFrame's sunE); the cube holds the cabin at the exposure of its capture, rescaled each frame.
//
// Texture taps per pane pixel by preset (section 9.1: 4 / 12 / 20): Low 5 (view, wide blur, surface, frost, cabin);
// High 11 (+ two glare taps across the scratches, a drop's bent view, the facets, the second reflection); Ultra 14
// (four glare taps, the ghost of bright lights between the panes). Low's drops show the wide blur, not a bent view (5).

import { DoubleSide, CustomBlending, NoBlending, OneMinusDstAlphaFactor, OneFactor, AddEquation, Vector3, Vector2 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, If, uniform, texture, cubeTexture, viewportMipTexture, screenUV, screenSize, positionGeometry, positionLocal, positionWorld,
  positionView, cameraWorldMatrix, cameraPosition, cameraProjectionMatrix, modelWorldMatrixInverse, instanceIndex, vec2, vec3, vec4, float, int,
  normalize, dot, length, max, min, abs, clamp, mix, smoothstep, sqrt, atan, cos, sin, pow, exp, floor, fract, log2,
  reflect, select, dFdx, dFdy, luminance, hash, step,
} from 'three/tsl';
import { FUSELAGE, WINDOW } from '../aircraft/dimensions.js';
import { CABIN_GAIN } from '../cabin/cabin.js';
import { RING } from './paneFrame.js';
import { stackNode, glarePhaseNode, scratchGlintNode, PANE_TINT, GLARE_K } from './paneOptics.js';
import { TEXTURE_SPAN, TEXTURE_SIZE } from './paneTextures.js';

/** The pane's look, ESTIMATED where not marked: tuned for restraint against window-seat photographs. */
export const LOOK = Object.freeze({
  /** Aperture of the eye or camera focused far, metres: a phone's lens (f/1.8 at about 4 mm) or the eye by day, 2 to
   * 3 mm. 3.5 mm (the first value) blurred drops and fern frost on the outer pane nearly away. */
  apertureM: 0.0025,
  /** How far the fern frost has grown at full frost (paneState's 1), in the growth maps' time (0 first seed .. 1 all
   * grown): at cruise (frost about 0.8) the ferns round the breather hole and the start of those in the lower corners.
   * The maps are sparse (fully grown about a hundredth of the pane, scripts/build_pane_textures.py). */
  frostCover: 0.7,
  /** Width of the growth front in the growth maps' units, focused on the pane and focused far. */
  frostFront: 0.035, frostFrontFar: 0.06,
  /** Frost focused far: the maps are read at most this many levels blurrier than their own footprint (a fern line
   * is a texel or two; read at the aperture's full blur it would average away), and drawn at this contrast instead,
   * so it reads as a faint soft feathering rather than not at all. */
  frostFarLods: 1, frostFarContrast: 0.5,
  /** The share of windows with any frost: the rest of the run stays clear ("often absent"). */
  frostPresence: 0.7,
  /** Scattered shares: scratches (at density 1), dirt (at 1), into the narrow glare; frost, fog and mist into the wide. */
  scratchScatter: 0.05, dirtScatter: 0.035, iceScatter: 0.6, fogScatter: 0.7, mistScatter: 0.6,
  /** Condensation and mist also send the outside's diffuse light toward the eye (a milky veil): its share at full
   * fog. Without it, fog only mixed in a wide blur of the view, which over even ground looks the same. */
  fogVeil: 0.5,
  /** The least contrast a defocused drop or rivulet keeps (it is perceived even when blurred: the eye refocuses). */
  dropFloor: 0.3,
  /** Glare of the sun off the pane per unit of each mask, times GLARE_K (the drive's 4 cd/m^2 per lux per deg^-2): set
   * so that dense scratches tangent to the sun 10 degrees away glow at about half the sky's luminance and a dirty patch
   * 5 degrees from it at a tenth, as photographs through airliner windows show them (judged, not measured). */
  sunDirt: 1.5, sunScratch: 12, sunFog: 8,
  /** Core angles of the phase functions, degrees: dirt, scratches, fog. */
  coreDirt: 0.5, coreScratch: 4, coreFog: 10,
  /** Frost lit by the sun through the outer pane: a floor plus a forward lobe (12 degrees). */
  iceSunFloor: 0.012, iceSunLobe: 1.6, coreIce: 12,
  /** Soft cap of the sun's glare on the pane, buffer units (the drive's CAP_SUN). */
  capSun: 1.5,
  /** Angles of the narrow and wide blurs, radians (7.7: about 2 and 20 degrees). */
  narrowRad: 2 * Math.PI / 180, wideRad: 20 * Math.PI / 180,
  /** A drop bends the view by up to this angle at its rim, radians, and shows it upside down. Kept small: the frame
   * copy holds the cabin round the window, and light through a drop on the outer face never comes from the cabin. */
  dropBendRad: 0.15,
  /** The share of the outside's diffuse light a drop's upper edge returns toward the eye. */
  dropSky: 1.2,
  /** The breather hole: radius, metres (7.7: about 1 mm across), and where it is (pane metres, low on the centre line). */
  holeR: 0.0005, holeV: -0.15,
  /** The cabin's interior as the reflection's proxy: a cylinder about the fuselage axis, metres. */
  proxyR: 1.62,
  /** Angular offset of the ghost of bright lights between not quite parallel panes, radians; and its weight. */
  ghostRad: 0.006, ghostWeight: 0.012,
});

const TEXEL_M = TEXTURE_SPAN[0] / TEXTURE_SIZE[0];

/** three's hash() takes its seed as an unsigned integer: a negative seed becomes 0 (every drop on the lower half of
 * the pane had the same hash, so a streak ran in every lane there) and fractions are cut off (seed + 1.3 hashed as
 * seed + 1). This one shifts the seed positive and keeps a sixteenth. */
const phash = (x) => hash(x.add(65536.0).mul(16.0));

/**
 * @param {{ textures: ReturnType<typeof import('./paneTextures.js').loadPaneTextures>, level?: 'low'|'high'|'ultra',
 *   reflection?: { texture: import('three').Texture }, panes?: { PaneInner?: number, PaneMiddle?: number, PaneOuter?: number },
 *   outside?: (uv: any, level: any) => any }} o
 */
export function createPaneMaterial({ textures, level = 'high', reflection = null, panes = {}, outside = null }) {
  const low = level === 'low', ultra = level === 'ultra';
  const rIn = panes.PaneInner ?? 1.8368, rMid = panes.PaneMiddle ?? 1.851, rOut = panes.PaneOuter ?? 1.868;
  const AXIS = FUSELAGE.axisY;

  const u = {
    sunBody: uniform(new Vector3(0, -1, 0)), sunE: uniform(0), sunColor: uniform(new Vector3(1, 0.97, 0.92)),
    frost: uniform(0), fog: uniform(0), wet: uniform(0), mist: uniform(0), rain: uniform(0), scratches: uniform(1),
    reflection: uniform(0), timeS: uniform(0), flow: uniform(new Vector3(0, -1, 0)), focus: uniform(0),
    capture: uniform(new Vector3(1.75, 3.9, 0)), hole: uniform(1), on: uniform(1), ambient: uniform(0), transmission: uniform(1), debug: uniform(0),
  };
  const tSurface = texture(textures.surface), tFrost = texture(textures.frost), tFacets = texture(textures.facets);
  const cube = reflection ? cubeTexture(reflection.texture) : null;
  const viewport = outside ? null : viewportMipTexture();
  const sampleOutside = outside ?? ((uv, lod) => viewport.sample(uv).level(lod));

  const material = new MeshBasicNodeMaterial({
    // laid "under" what the cabin pass drew behind the inner pane (src x (1 - dst.a) + dst): the window's structure,
    // drawn first, stays where the model has it, and the glass fills the opening (F3.9: the outside picture holds no
    // cabin). The inner pane's own light (reflections, the sun on it) therefore shows in the opening only. That is the
    // app's path (an `outside` from the cabin stage). Without `outside` (the harness: the pane in the scene pass,
    // reading the mid-pass copy, which holds the cabin) it replaces what is behind it, as before
    name: 'window-pane', transparent: true, depthWrite: false, depthTest: true, side: DoubleSide, fog: false,
    ...(outside ? {
      blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneMinusDstAlphaFactor, blendDst: OneFactor,
      blendEquationAlpha: AddEquation, blendSrcAlpha: OneMinusDstAlphaFactor, blendDstAlpha: OneFactor,
    } : { blending: NoBlending }),
  });

  // drawn 4 mm inboard of the model's inner pane: the model puts it 2 mm outboard of the frame ring behind it, which
  // it crosses at a grazing angle round the opening (a noisy band where the two fight); 4 mm is still behind the
  // reveal's liner everywhere but its last few millimetres
  // (positionLocal: the material's position node is applied after instancing, so it must start from the placed point)
  material.positionNode = Fn(() => {
    const p = positionLocal;
    const n = normalize(vec2(p.x, p.y.sub(AXIS)));
    return p.sub(vec3(n.x, n.y, 0).mul(0.004));
  })();

  material.colorNode = Fn(() => {
    // ---- geometry: the inner pane's point, the view ray, pane coordinates on the three sheets
    const pg = positionGeometry; // instance-local, body axes (x outboard on the right, mirrored on the left)
    // never through world coordinates: at cruise the aircraft is some 300 km from the scene's origin, where a float
    // holds positionWorld to centimetres (the view ray 35 cm long would swing by several per cent from pixel to
    // pixel). The model-view matrix is composed in double precision on the CPU, so positionView is exact
    const pm = positionLocal; // the cabin group's axes (the pane's group is placed at identity in it)
    const dirW = cameraWorldMatrix.mul(vec4(positionView, 0)).xyz;
    const eyeDist = length(dirW);
    const dir = normalize(modelWorldMatrixInverse.mul(vec4(dirW, 0)).xyz).toVar();
    const side = select(pg.x.lessThan(0), float(-1), float(1));
    const rad2 = normalize(vec2(pg.x, pg.y.sub(AXIS)));
    const nOut = vec3(rad2.x, rad2.y, 0); // outward normal at this point
    const tV = vec3(rad2.y.negate().mul(side), rad2.x.mul(side), 0); // up along the ring
    const tU = vec3(0, 0, 1);
    const cosI = max(dot(dir, nOut), 0.05);
    const paneUV = (p) => {
      const r = length(vec2(p.x, p.y.sub(AXIS)));
      const th = atan(p.y.sub(AXIS), abs(p.x));
      return vec2(p.z, r.mul(th.sub(RING)));
    };
    const across = (dr) => pg.add(dir.mul(float(dr).div(cosI)));
    const uvIn = paneUV(pg);
    const uvOut = paneUV(across(rOut - rIn));
    const uvMid = paneUV(across(rMid - rIn));
    const texUV = (p) => vec2(p.x.div(TEXTURE_SPAN[0]).add(0.5), float(0.5).sub(p.y.div(TEXTURE_SPAN[1])));

    // ---- focus: blur on the pane (metres) and the outside's blur (mip level)
    const ppr = cameraProjectionMatrix.element(1).y.mul(screenSize.y).mul(0.5); // pixels per radian
    const blurM = mix(float(LOOK.apertureM), float(0.0003), u.focus);
    const bias = log2(max(blurM.div(TEXEL_M), 1));
    // the textures' own footprint per pixel (texels), so each is read at an explicit level: footprint plus blur
    const footprint = (uvP) => {
      const t = texUV(uvP).mul(vec2(...TEXTURE_SIZE));
      return max(max(length(vec2(dFdx(t.x), dFdy(t.x))), length(vec2(dFdx(t.y), dFdy(t.y)))), 1e-4);
    };
    const lodIn = log2(max(footprint(uvIn), 1)).add(bias);
    const lodOut = log2(max(footprint(uvOut), 1)).add(bias);
    // the skin's opening (the outer pane's extent): a rounded rectangle; outside it the ray through the inner pane's
    // margin meets the window's structure, not the outer panes, so nothing of theirs is drawn there
    const box = (p, hw, hh, r) => {
      const q = abs(p).sub(vec2(hw - r, hh - r));
      return length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(r);
    };
    const throughOut = smoothstep(blurM.mul(0.5), blurM.mul(-0.5), box(uvOut, WINDOW.width / 2, WINDOW.height / 2, WINDOW.cornerRadius)).toVar();
    const lodOf = (radians) => log2(max(radians.mul(ppr), 1));
    const sharpLod = lodOf(float(LOOK.apertureM).div(max(eyeDist, 0.05)).mul(u.focus));

    // ---- the pane's own textures
    const surf = tSurface.sample(texUV(uvIn)).level(lodIn);
    const dir2raw = surf.rg.mul(2).sub(1);
    const scratchD = surf.b.mul(u.scratches);
    const coherence = clamp(length(dir2raw).div(max(surf.b, 1e-3)), 0, 1);
    const dirt = surf.a.mul(u.scratches);
    // frost: the variant and how much this window has, from the instance (windows differ)
    const inst = float(instanceIndex);
    const hv = hash(inst.add(17.0));
    const lodFrost = min(lodOut, log2(max(footprint(uvOut), 1)).add(float(LOOK.frostFarLods).mul(float(1).sub(u.focus))));
    const fr = tFrost.sample(texUV(uvOut)).level(lodFrost);
    const arrival = select(hv.lessThan(0.25), fr.r, select(hv.lessThan(0.5), fr.g, select(hv.lessThan(0.75), fr.b, fr.a)));
    const cover = u.frost.mul(LOOK.frostCover).mul(mix(float(0.55), float(1.35), hash(inst.add(3.0))));
    // defocus: the growth map is read blurred (lodOut), which lowers its slope, so a fixed front in its units widens
    // with the blur on the pane; wider still at far focus, where frost is a soft feathered haze
    const front = mix(float(LOOK.frostFrontFar), float(LOOK.frostFront), u.focus);
    const present = step(hash(inst.add(29.0)), float(LOOK.frostPresence));
    const ice = smoothstep(arrival.sub(front), arrival.add(front.mul(0.5)), cover).mul(step(0.0001, u.frost)).mul(throughOut)
      .mul(present).mul(mix(float(LOOK.frostFarContrast), float(1), u.focus)).toVar();
    // fog between the panes: low-frequency, heavier low down and at the edges (the coldest parts)
    const edge = max(abs(uvIn.x).div(0.145), abs(uvIn.y).div(0.19));
    const fogMask = u.fog.mul(clamp(float(0.45).add(smoothstep(0.55, 1.0, edge).mul(0.5)).add(uvIn.y.negate().mul(1.2)), 0, 1)).mul(throughOut).toVar();

    // ---- drops on the outer face (stateless: a function of pane position and presentation time)
    const dropCover = float(0).toVar(), dropN = vec2(0).toVar();
    If(u.wet.greaterThan(0.002), () => {
      const P = uvOut;
      const f = normalize(u.flow.xy);
      const fp = vec2(f.y.negate(), f.x);
      const speed = u.flow.z;
      const rainK = clamp(u.rain.div(8), 0, 1);
      // sitting and creeping drops: cells of 11 mm, two crossfaded generations of 6 s
      const wS = float(1).sub(smoothstep(0.05, 0.3, speed));
      If(wS.greaterThan(0.01), () => {
        const C = 0.011;
        for (let i = 0; i < 2; i++) {
          const ph = u.timeS.div(6).add(i * 0.5);
          const ep = floor(ph), w = fract(ph);
          const fade = smoothstep(0, 0.12, w).mul(smoothstep(1, 0.88, w));
          const q = P.div(C).add(i * 0.37);
          const cell = floor(q);
          const seed = cell.x.mul(157.1).add(cell.y.mul(311.7)).add(ep.mul(47.3)).add(i * 91);
          const h1 = phash(seed), h2 = phash(seed.add(1.3)), h3 = phash(seed.add(2.7)), h4 = phash(seed.add(4.1));
          const exists = step(h1, u.wet.mul(mix(float(0.2), float(0.5), rainK)));
          const creep = f.mul(min(speed, 0.004)).mul(w).mul(6).div(C);
          const r = mix(float(0.08), float(0.27), h4.mul(h4)); // in cells: 0.9 to 3 mm
          const c = cell.add(vec2(h2, h3).mul(float(1).sub(r.mul(2))).add(r)).add(creep);
          const d = q.sub(c).div(r);
          const dl = length(d);
          const soft = blurM.div(C).div(r).add(0.08);
          // a blurred drop keeps its light: spread over the blur, its contrast falls as (size / blur)^2
          const k = min(float(1), r.mul(C).mul(2).div(blurM).pow(2).add(LOOK.dropFloor));
          const cov = smoothstep(float(1).add(soft.mul(0.5)), float(1).sub(soft.mul(0.5)), dl).mul(exists).mul(fade).mul(wS).mul(k);
          dropN.assign(select(cov.greaterThan(dropCover), d.mul(min(dl, 1).div(max(dl, 1e-3))).mul(k), dropN));
          dropCover.assign(max(dropCover, cov));
        }
      });
      // running streaks at speed: lanes 11 mm apart along the flow, cells 12 cm long (each lane's cells shifted by its
      // own hash, so heads do not line up across lanes), two crossfaded generations of half a second; each drop is
      // born in its cell and runs downstream, leaving a thin rivulet
      const wR = smoothstep(0.02, 0.2, speed);
      If(wR.greaterThan(0.01), () => {
        const A = dot(P, f), B = dot(P, fp);
        const CA = 0.12, CB = 0.011, LIFE = 0.5;
        const lane = floor(B.div(CB));
        const Ao = A.add(phash(lane.mul(7.13).add(0.37)).mul(CA));
        for (let i = 0; i < 2; i++) {
          const ph = u.timeS.div(LIFE).add(i * 0.5);
          const ep = floor(ph), w = fract(ph);
          const fade = smoothstep(0, 0.1, w).mul(smoothstep(1, 0.8, w));
          const age = w.mul(LIFE);
          const travel = min(speed.mul(age), CA * 2.6);
          for (let k = 0; k < 3; k++) {
            const ka = floor(Ao.div(CA)).sub(k);
            const seed = ka.mul(73.1).add(lane.mul(19.7)).add(ep.mul(5.3)).add(i * 37 + 11);
            const h1 = phash(seed), h2 = phash(seed.add(1.7)), h3 = phash(seed.add(3.1));
            const exists = step(h1, u.wet.mul(mix(float(0.1), float(0.4), rainK)));
            const a0 = ka.add(h2).mul(CA);
            const head = a0.add(travel);
            const bc = lane.add(float(0.2).add(h3.mul(0.6))).mul(CB);
            const db = B.sub(bc);
            const rH = float(0.0007).add(h3.mul(0.0007));
            const tw = float(0.0008);
            const along = clamp(Ao.sub(a0).div(max(travel, 1e-4)), 0, 1);
            const inTrail = step(a0, Ao).mul(step(Ao, head));
            const kT = min(float(1), tw.mul(2).div(blurM).pow(2).add(LOOK.dropFloor * 0.8));
            const trail = smoothstep(tw.add(blurM.mul(0.5)), tw.sub(blurM.mul(0.5)).max(0), abs(db)).mul(inTrail).mul(along.mul(0.6).add(0.4)).mul(kT);
            const dh = vec2(Ao.sub(head), db).div(rH);
            const dhl = length(dh);
            const kH = min(float(1), rH.mul(2).div(blurM).pow(2).add(LOOK.dropFloor));
            const headCov = smoothstep(float(1).add(blurM.div(rH).mul(0.5)), float(1).sub(blurM.div(rH).mul(0.5)), dhl).mul(kH);
            const cov = max(trail.mul(0.85), headCov).mul(exists).mul(fade).mul(wR);
            const n = select(headCov.greaterThan(trail.mul(0.85)), dh.mul(min(dhl, 1).div(max(dhl, 1e-3))).mul(kH), vec2(0, db.div(tw).clamp(-1, 1).mul(0.8)));
            // back into pane axes from the flow's
            const nP = f.mul(n.x).add(fp.mul(n.y));
            dropN.assign(select(cov.greaterThan(dropCover), nP, dropN));
            dropCover.assign(max(dropCover, cov));
          }
        }
      });
    });

    dropCover.assign(dropCover.mul(throughOut));

    // ---- screen-space directions of pane vectors (for glare taps and the drops' refraction)
    const dux = dFdx(uvIn), duy = dFdy(uvIn);
    const det = dux.x.mul(duy.y).sub(dux.y.mul(duy.x));
    const toScreen = (vP) => { // pane metres -> pixels, then normalised
      const sx = duy.y.mul(vP.x).sub(duy.x.mul(vP.y)).div(det);
      const sy = dux.x.mul(vP.y).sub(dux.y.mul(vP.x)).div(det);
      return normalize(vec2(sx, sy).add(vec2(1e-7, 0)));
    };
    // screenUV's y runs down: a pixel step in +y (dFdy) is a step down the screen in uv
    const pxToUv = vec2(float(1).div(screenSize.x), float(1).div(screenSize.y));

    // ---- the view through the pane
    const sharp = sampleOutside(screenUV, sharpLod).rgb.toVar();
    // the wide blur of the frame takes in the dark cabin round the window, which frost on the outer pane cannot
    // see: its floor is the outside's diffuse light (paneFrame's ambient, buffer units)
    const wide = max(sampleOutside(screenUV, lodOf(float(LOOK.wideRad))).rgb, vec3(u.ambient));
    // inside a drop: the view bent (and inverted) by the drop's lens, mixed in by the drop's defocused coverage
    const bend = dropN.mul(-LOOK.dropBendRad);
    const bent = low ? null : sampleOutside(screenUV.add(toScreen(bend).mul(length(bend)).mul(ppr).mul(pxToUv)), sharpLod.add(1.5)).rgb;
    let glare;
    if (low) glare = mix(sharp, wide, 0.25);
    else {
      // across the scratches: light from either side of a scratch is thrown along it
      const phi = atan(dir2raw.y, dir2raw.x.add(1e-6)).mul(0.5);
      const perp = vec2(sin(phi).negate(), cos(phi));
      const sdir = toScreen(perp);
      const lodN = lodOf(float(LOOK.narrowRad));
      const step1 = sdir.mul(float(LOOK.narrowRad * 1.5).mul(ppr)).mul(pxToUv);
      let acc = sampleOutside(screenUV.add(step1), lodN).rgb.add(sampleOutside(screenUV.sub(step1), lodN).rgb);
      if (ultra) acc = acc.add(sampleOutside(screenUV.add(step1.mul(2.5)), lodN).rgb).add(sampleOutside(screenUV.sub(step1.mul(2.5)), lodN).rgb);
      glare = mix(acc.div(ultra ? 4 : 2), wide, coherence.oneMinus().mul(0.5));
    }
    // a little loss, and a darker rim (light from the dark cabin, refracted at the steep edge)
    const nl = length(dropN);
    const dropShade = mix(float(0.85), float(0.45), smoothstep(0.7, 1.0, nl));
    // and the sky caught along a drop's or a rivulet's upper edge (what makes thin water read on the glass by day)
    const skyEdge = vec3(u.ambient).mul(LOOK.dropSky).mul(smoothstep(0.2, 0.9, dot(dropN, vec2(0, 1))));
    const view = mix(sharp, (bent ?? wide).mul(dropShade).add(skyEdge), dropCover);

    const sN = clamp(scratchD.mul(LOOK.scratchScatter).add(dirt.mul(LOOK.dirtScatter)), 0, 0.3);
    const sW = clamp(ice.mul(LOOK.iceScatter).add(fogMask.mul(LOOK.fogScatter)).add(u.mist.mul(LOOK.mistScatter).mul(throughOut)), 0, 0.95);
    const stack = stackNode(cosI);
    const tint = vec3(...PANE_TINT);
    let Lview = view.mul(float(1).sub(sN).sub(sW)).add(glare.mul(sN)).add(wide.mul(sW))
      .add(vec3(u.ambient).mul(LOOK.fogVeil).mul(fogMask.add(u.mist.mul(throughOut).mul(0.6))));
    if (ultra) {
      // the ghost of bright lights: twice reflected between the outer panes, which are not quite parallel
      const g = sampleOutside(screenUV.add(vec2(0, LOOK.ghostRad).mul(ppr).mul(pxToUv)), float(1)).rgb;
      Lview = Lview.add(g.mul(LOOK.ghostWeight).mul(u.transmission));
    }
    // the breather hole on the middle pane: a dark ring, all but gone at far focus
    const hd = length(uvMid.sub(vec2(0, LOOK.holeV)));
    const holeK = min(float(1), float(LOOK.holeR * 2).div(blurM).pow(2));
    const holeRing = smoothstep(float(LOOK.holeR).add(blurM.mul(0.5)), float(LOOK.holeR).sub(blurM.mul(0.5)).max(0), hd).mul(holeK).mul(u.hole).mul(u.scratches).mul(throughOut);
    Lview = Lview.mul(float(1).sub(holeRing.mul(0.6)));
    const transmitted = Lview.mul(mix(vec3(1), tint.mul(stack.x), u.transmission));

    // ---- the sun on the pane itself
    const sunE = u.sunE;
    const cosSun = dot(dir, u.sunBody);
    const d = u.sunBody.sub(dir);
    const radial = normalize(vec2(dot(d, tU), dot(d, tV)).add(vec2(0, 1e-6)));
    const glint = scratchGlintNode(dir2raw, radial, coherence);
    // the inner pane is sunlit only where sunlight comes through the skin's opening: carry the ray toward the sun out
    // to the outer pane and test it against the opening (the structure between shades the rest)
    const sunUp = max(dot(u.sunBody, nOut), 0.05);
    const pSun = pg.add(u.sunBody.mul(float(rOut - rIn).div(sunUp)));
    const litIn = smoothstep(0.002, -0.002, box(paneUV(pSun), WINDOW.width / 2, WINDOW.height / 2, WINDOW.cornerRadius));
    const scatterSun = dirt.mul(LOOK.sunDirt).mul(litIn).mul(glarePhaseNode(cosSun, float(LOOK.coreDirt)))
      .add(scratchD.mul(glint).mul(litIn).mul(LOOK.sunScratch).mul(glarePhaseNode(cosSun, float(LOOK.coreScratch))))
      .add(fogMask.mul(LOOK.sunFog).mul(glarePhaseNode(cosSun, float(LOOK.coreFog))))
      .mul(GLARE_K)
      .add(ice.mul(float(LOOK.iceSunFloor).add(glarePhaseNode(cosSun, float(LOOK.coreIce)).mul(LOOK.iceSunLobe))));
    let sunL = u.sunColor.mul(sunE.mul(scatterSun));
    if (!low) {
      // each crystal's own facet catches the sun when it lines up (a glint that moves with the head, never a clock)
      const facet = tFacets.sample(texUV(uvOut)).level(lodFrost);
      const fid = select(hv.lessThan(0.25), facet.r, select(hv.lessThan(0.5), facet.g, select(hv.lessThan(0.75), facet.b, facet.a)));
      const fh = fid.mul(255).add(inst.mul(0.17));
      const tilt = vec2(hash(fh).sub(0.5), hash(fh.add(7.1)).sub(0.5)).mul(0.5);
      const fn = normalize(nOut.negate().add(tU.mul(tilt.x)).add(tV.mul(tilt.y)));
      const spec = pow(max(dot(reflect(u.sunBody.negate(), fn), dir.negate()), 0), 80);
      sunL = sunL.add(u.sunColor.mul(sunE.mul(spec).mul(ice).mul(0.02)));
    }
    sunL = sunL.div(luminance(sunL).div(LOOK.capSun).add(1));

    // ---- the cabin, mirrored
    let mirrored = vec3(0);
    if (cube) {
      const lookup = (o, r) => {
        // the far side of the proxy cylinder along the reflected ray, seen from where the cube was drawn
        const ox = o.x, oy = o.y.sub(AXIS);
        const a = r.x.mul(r.x).add(r.y.mul(r.y)).max(1e-5);
        const b = ox.mul(r.x).add(oy.mul(r.y));
        const c = ox.mul(ox).add(oy.mul(oy)).sub(LOOK.proxyR * LOOK.proxyR);
        const t = b.negate().add(sqrt(max(b.mul(b).sub(a.mul(c)), 0))).div(a);
        const hit = o.add(r.mul(max(t, 0.05)));
        return normalize(hit.sub(u.capture));
      };
      const rDir = reflect(dir, nOut);
      const c1 = cube.sample(lookup(pm, rDir)).rgb;
      if (low) mirrored = c1.mul(stack.y.add(stack.z));
      else {
        const pOutM = pm.add(dir.mul(float(rOut - rIn).div(cosI)));
        const c2 = cube.sample(lookup(pOutM, rDir)).rgb;
        mirrored = c1.mul(stack.y).add(c2.mul(stack.z));
      }
      // the cabin as it is shown: with its own adaptation (cabin.js cabinAdaptation; the cube is drawn without it)
      mirrored = mirrored.mul(u.reflection).mul(CABIN_GAIN);
    }
    // frost and fog also scatter the cabin's own light back toward the eye (faint, at night)
    const cabinBack = cube ? cube.sample(nOut.negate()).rgb.mul(u.reflection).mul(CABIN_GAIN).mul(ice.mul(0.08).add(fogMask.mul(0.04))) : vec3(0);

    const out = transmitted.add(sunL).add(mirrored).add(cabinBack);
    // debug views (the harness): 1 ice, 2 the frost front's width x 10, 3 the growth map, 4 drops, 5 scratch density
    const dbg = u.debug;
    const pick = select(dbg.lessThan(1.5), vec3(ice), select(dbg.lessThan(2.5), vec3(front.mul(10)), select(dbg.lessThan(3.5), vec3(arrival),
      select(dbg.lessThan(4.5), vec3(dropCover, dropN.mul(0.5).add(0.5)), vec3(scratchD.mul(4))))));
    return vec4(select(dbg.greaterThan(0.5), pick, out), 1);
  })();

  void [Vector2, int, exp, cos];
  return { material, uniforms: u, textureNodes: { surface: tSurface, frost: tFrost, facets: tFacets }, taps: low ? 5 : ultra ? 14 : 11, level };
}
