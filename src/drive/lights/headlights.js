// The `headlights` drive part (plan 02, D5.1 and D5.2): the visitor's two headlamps, and what retroreflective
// sheeting, markings and delineators send back from them. Joined in parts.js.
//
// Mechanism. The beam is evaluated in the shader as a surface term (surfaceLight.js) on the materials that matter:
// one texture fetch of the candela map per lamp per fragment, E = I cos(i) / d^2, with the map's real shape (a sharp
// cutoff, the hot spot low and right). It needs no three.js light, so other materials' programs are untouched and
// three's light count (and every program's cache key) stays the same; a SpotLight with a map would have lit every
// Lambert and standard material in the scene, with the map projected through a perspective camera that cannot hold
// the beam's +-45 degrees without wasting most of its texels. The retro term (section 7.4) follows the beam term on
// the reflective materials: R_A(alpha, beta) x E_perp / cos(nu) for sheeting, R_L(alpha) x E_perp for markings, from a
// small table of retro.js's coefficients. The terms: headlamps.js; JavaScript mirrors: headlampMirror.js. The
// pavement itself returns R_L x E_perp (third stretch, decision 13). Units (decision 6): the beam is the lamps' candela,
// the beam on a surface lux and the retroreflected return cd/m^2, all scaled by photometry.js.
//
// Lamps. DEFAULT_LAMPS (beam.js) at the car's nose on the journey's pose (pose.position is the car's centre line on
// the road; the nose is NOSE_M ahead, from public/models/drive/cabin.json's body.front less the lamp's depth), so the
// beam follows the road's grade and crossfall and never where the head looks or the body's bounce.
//
// Automatic switching. On while the ambient illuminance (env.lighting.ambientLux) is under AUTO_ON_LUX, the switch-on
// level UN Regulation 48 sets for automatic dipped beams (1,000 lux; recalled, not re-opened); a pure function of the
// moment, so no hysteresis. Off (by day, or through setEnabled(false)) the terms add exactly nothing.
//
// Materials. Beam: the road (pavement, shoulders, embankments, barriers, structures), the wide ground and the app's
// ground meshes, sign faces and supports, delineator posts and faces, the roadside buildings and the traffic's bodies
// (the session's surfaces of kinds 'building' and 'vehicle'). Retro: road markings by a mask read from the road atlas
// (markingMask.js) and barrier reflectors by the road's `retro` attribute, sign faces by `retro` and `retroLegend`,
// delineator faces by their material.
//
// Keys. H switches between low and high beam while Drive is active (not while typing in a field).


import { decodeBeam, DEFAULT_LAMPS } from './beam.js';
import { beamTexture, retroTable, linearOf, chromaOf, lampPositions } from './headlampMirror.js';
import { markingMaskOf, pavementAlbedo } from './markingMask.js';
import { createHeadlampTerms } from './headlamps.js';
import { createTimings } from '../timing.js';
import { eachGround } from '../parts.js';

/** Ambient illuminance (lux) under which the headlamps are on: UN R48's automatic dipped-beam switch-on level. */
export const AUTO_ON_LUX = 1000;
/** Lamps' distance ahead of pose.position (m): cabin.json body.front 2.95 m, less 0.1 m to the lamp's centre. */
export const NOSE_M = 2.85;
/** Beyond this distance (m) the beam term fades out over FADE_M: E there is under 1% of the night ambient. */
export const RANGE_M = 450, FADE_M = 100;
/** In-service ageing of sheeting (plan 02, 7.4: between 0.4 and 1) and of markings (their R_L is already for new paint). */
export const AGEING = Object.freeze({ sheeting: 0.8, marking: 1 });
/** Colour of the lamps (an LED low beam, about 5,000 K), luminance 1. */
const LAMP_COLOUR = chromaOf([1, 0.95, 0.86]);
/** Sheeting colours by code (sheeting.js: 1 white, 2 yellow, 3 red, 4 green), sRGB; the sign atlas' own where it has them. */
const SHEET_HEX = { black: '#141414', white: '#f4f5f0', yellow: '#f5c400', red: '#b5121b', green: '#006b45' };

const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '') || el.getAttribute?.('role') === 'slider');


/** @param {object} ctx the part context (parts.js) */
export async function createHeadlightsPart(ctx) {
  const dir = `${ctx.app.DATA}/../drive`;
  const fetchOk = async (f) => { const r = await fetch(`${dir}/${f}`); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r; };
  const meta = await fetchOk('beam.json').then((r) => r.json());
  const [lowBytes, highBytes] = await Promise.all(['low', 'high'].map((w) => fetchOk(meta.files?.[w] || `beam_${w}.bin`).then((r) => r.arrayBuffer())));
  const maps = { low: beamTexture(decodeBeam(lowBytes, meta, 'low')), high: beamTexture(decodeBeam(highBytes, meta, 'high')) };
  const table = retroTable();
  const { env } = ctx;

  // colours: the sign atlas' own (faces.js COLOURS) where it exports them
  let signColours = {};
  try { signColours = (await import('../roadside/faces.js')).COLOURS || {}; } catch { signColours = {}; }
  const hexOf = (name) => signColours[name] || SHEET_HEX[name];
  const codes = ['black', 'white', 'yellow', 'red', 'green'];
  const ink = codes.map((c) => linearOf(hexOf(c)));
  const chroma = codes.map((c, i) => (i === 0 ? [0, 0, 0] : chromaOf(linearOf(hexOf(c)))));

  // the road's marking mask, from its atlas
  let mask = null, pavement = null;
  {
    let regions = null, atlasW = 0, paint = null;
    try { const a = await import('../roadnet/atlas.js'); regions = a.REGIONS; atlasW = a.ATLAS_W; paint = a.PAINT || null; } catch { regions = null; }
    const img = ctx.materials?.nightMap?.image || ctx.materials?.map?.image;
    const k = atlasW && img?.width ? img.width / atlasW : 1;
    mask = markingMaskOf(ctx.materials, regions?.reflector ? { reflector: regions.reflector.map((x) => Math.round(x * k)) } : null, paint);
    // the pavement's reference albedo for its R_L (decision 13), from the day atlas
    const kd = atlasW && ctx.materials?.map?.image?.width ? ctx.materials.map.image.width / atlasW : 1;
    pavement = pavementAlbedo(ctx.materials, regions?.lane && regions?.laneC ? { lane: regions.lane.map((x) => x * kd), laneC: regions.laneC.map((x) => x * kd) } : null);
  }
  const terms = createHeadlampTerms({
    ctx, maps, table, ink, chroma, mask, ageing: AGEING, colour: LAMP_COLOUR, range: { range: RANGE_M, fade: FADE_M }, pavement,
  });

  const undo = [];
  const lit = new Set();
  const counts = { beam: 0, retro: 0 };
  /** Add the beam term and, for a reflective kind, the retro term. */
  function attach(material, kind = null, row = 0) {
    if (!material || lit.has(material)) return;
    if (!material.isNodeMaterial) return; // a stock material the renderer converts itself takes no term
    lit.add(material);
    const r = terms.attach(material, kind, row);
    if (!r) return;
    undo.push(r.undo);
    counts.beam++;
    if (r.retro) counts.retro++;
  }

  attach(ctx.materials?.road, 'road');
  attach(ctx.materials?.roadNear, 'road');
  attach(ctx.wideMesh?.material);
  const offGround = eachGround(ctx, (mesh) => attach(mesh.material)); // the terrain patches too, when they come
  // the signs and delineators are the route's own (session.js): attached again when the route changes (setRoute)
  let roadsideOf = null, roadsideUndo = [], roadsideCounts = { beam: 0, retro: 0 };
  function attachRoadside() {
    if (ctx.roadside === roadsideOf) return;
    for (const u of roadsideUndo.reverse()) u();
    for (const m of roadsideMats) lit.delete(m);
    counts.beam -= roadsideCounts.beam; counts.retro -= roadsideCounts.retro;
    roadsideUndo = []; roadsideMats.length = 0;
    roadsideOf = ctx.roadside;
    const from = undo.length, before = { ...counts };
    ctx.roads?.getObjectByName('roadside')?.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (lit.has(m)) continue;
        roadsideMats.push(m);
        if (m.name === 'delineator white') attach(m, 'delineator', 0);
        else if (m.name === 'delineator yellow') attach(m, 'delineator', 1);
        else if (/^signs /.test(m.name)) attach(m, 'sign');
        else attach(m);
      }
    });
    roadsideUndo = undo.splice(from);
    roadsideCounts = { beam: counts.beam - before.beam, retro: counts.retro - before.retro };
  }
  const roadsideMats = [];
  attachRoadside();
  // the corridor's buildings and the traffic's bodies (and later surfaces of those kinds) through the session's surfaces
  const offSurfaces = ctx.eachSurface ? ctx.eachSurface((m, kind) => { if (kind === 'building' || kind === 'vehicle') attach(m); }) : () => {};

  let enabled = true, high = false, beams = 0, on = false, ambient = 0;
  const timings = createTimings();
  let lamps = null, basis = null;

  function apply() {
    const which = high ? 'high' : 'low';
    terms.set({ which, peak: on ? maps[which].peakCd : 0, on, lamps, basis });
  }

  const onKey = (e) => {
    if (e.code !== 'KeyH' && e.key !== 'h' && e.key !== 'H') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || !ctx.group.visible || typing(e.target) || typing(document.activeElement)) return;
    part.setHigh(!high);
  };
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

  const part = {
    name: 'headlights',
    /** { on, high }: on while the lamps light anything (the instrument cluster's telltales). */
    state: () => ({ on, high }),
    setHigh(v) { high = !!v; apply(); ctx.app.invalidate?.(); },
    /** Switch the lamps off and on (a test hook; off, every term adds exactly zero). */
    setEnabled(v) { enabled = !!v; part.update(null); ctx.app.invalidate?.(); },
    update(frame) {
      const t0 = performance.now();
      if (frame) {
        ambient = env.lighting.ambientLux(frame.sun.elevation);
        const pose = frame.pose;
        lamps = lampPositions(pose, DEFAULT_LAMPS, NOSE_M);
        basis = { right: pose.right, up: pose.up, forward: pose.forward };
      }
      on = enabled && ambient < AUTO_ON_LUX;
      apply();
      timings.add(performance.now() - t0);
    },
    setLook(look) { beams = look.beams ?? (look.night ? 1 : 0); apply(); },
    /** Another route: its signs and delineators get the beam and retro terms (the road's materials are shared). */
    setRoute() { attachRoadside(); },
    stats() {
      const t = timings.summary();
      return { on, high, beams, ambientLux: ambient, materials: { beam: counts.beam, retro: counts.retro }, mask: !!terms.hasMask, pavement, js: { mean: t.mean, p95: t.p95, max: t.max } };
    },
    dispose() {
      offGround();
      offSurfaces();
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
      for (const u of [...undo, ...roadsideUndo].reverse()) u();
      terms.dispose();
    },
  };
  ctx.group.userData.headlightsPart = part; // for tests/manual/lights-probe.mjs
  return part;
}
