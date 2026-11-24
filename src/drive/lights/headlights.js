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
// small table of retro.js's coefficients. GLSL: headlamps.glsl.js; JavaScript mirrors: headlampMirror.js.
//
// Lamps. DEFAULT_LAMPS (beam.js) at the car's nose on the journey's pose (pose.position is the car's centre line on
// the road; the nose is NOSE_M ahead, from public/models/drive/cabin.json's body.front less the lamp's depth), so the
// beam follows the road's grade and crossfall and never where the head looks or the body's bounce.
//
// Automatic switching. On while the ambient illuminance (env.lighting.ambientLux, the sun's clear-sky table) is
// under AUTO_ON_LUX, the switch-on level UN Regulation 48 sets for automatic dipped beams (1,000 lux; recalled, not
// re-opened); a pure function of the sun, so no hysteresis. That is with the sun about half a degree above the
// horizon. The drawn strength is then scaled by the look's `beams` (0 by day, 1 from mid civil twilight): env.js's
// units are fitted to the night look, and the dusk blend fades the drive's lights in with it (env.js, LIGHTING_UNITS).
// Off (by day, or through setEnabled(false)) the terms add exactly nothing: the shader skips them on uHlSpec.x.
//
// Materials. Beam: the road (pavement, shoulders, embankments, barriers, structures), the wide ground and the app's
// ground meshes, sign faces and supports, delineator posts and faces, the roadside buildings and the traffic's bodies
// (the last two found in the scene once they load). Retro: road markings by a mask read from the road atlas
// (markingMask.js) and barrier reflectors by the road's `retro` attribute, sign faces by `retro` and `retroLegend`,
// delineator faces by their material. With this part running the road's and roadside's stand-in glow is off
// (setHeadlights on their APIs).
//
// Keys. H switches between low and high beam while Drive is active (not while typing in a field).
//
// Renderers (plan 02, third stretch, decisions 2 and 6). The terms live in headlamps.js (classic, GLSL through
// surfaceLight.js) and headlamps.node.js (plan 01's, TSL through surfaceLight.node.js), picked by ctx.legacy; this
// file is the part, the same on both. On plan 01's renderer the beam is the lamps' candela, the beam on a surface lux
// and the retroreflected return cd/m^2, all scaled by photometry.node.js; the look's `beams` fade and the retro term's
// soft shoulder (headlamps.glsl.js RETRO_SHOULDER) were stand-ins for the classic fixed exposure and apply only at
// ?display=classic, where the parity tool compares with the classic renderer (display.js).

import { decodeBeam, DEFAULT_LAMPS } from './beam.js';
import { beamTexture, retroTable, linearOf, chromaOf, lampPositions } from './headlampMirror.js';
import { markingMaskOf } from './markingMask.js';
import { displayFade } from './display.js';
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
  const legacy = ctx.legacy !== false;
  // the terms of the renderer (decision 2): headlamps.js (GLSL) or headlamps.node.js (TSL)
  const { createHeadlampTerms } = await (legacy ? import('./headlamps.js') : import('./headlamps.node.js'));

  // colours: the sign atlas' own (faces.js COLOURS) where it exports them
  let signColours = {};
  try { signColours = (await import('../roadside/faces.js')).COLOURS || {}; } catch { signColours = {}; }
  const hexOf = (name) => signColours[name] || SHEET_HEX[name];
  const codes = ['black', 'white', 'yellow', 'red', 'green'];
  const ink = codes.map((c) => linearOf(hexOf(c)));
  const chroma = codes.map((c, i) => (i === 0 ? [0, 0, 0] : chromaOf(linearOf(hexOf(c)))));

  // the road's marking mask, from its atlas
  let mask = null;
  {
    let regions = null, atlasW = 0, paint = null;
    try { const a = await import('../roadnet/atlas.js'); regions = a.REGIONS; atlasW = a.ATLAS_W; paint = a.PAINT || null; } catch { regions = null; }
    const img = ctx.materials?.nightMap?.image || ctx.materials?.map?.image;
    const k = atlasW && img?.width ? img.width / atlasW : 1;
    mask = markingMaskOf(ctx.materials, regions?.reflector ? { reflector: regions.reflector.map((x) => Math.round(x * k)) } : null, paint);
  }
  const terms = createHeadlampTerms({
    ctx, maps, table, ink, chroma, mask, ageing: AGEING, colour: LAMP_COLOUR, range: { range: RANGE_M, fade: FADE_M },
  });
  const display = terms.display || 'classic';

  const undo = [];
  const lit = new Set();
  const counts = { beam: 0, retro: 0 };
  /** Add the beam term and, for a reflective kind, the retro term. */
  function attach(material, kind = null, row = 0) {
    if (!material || lit.has(material)) return;
    if (!legacy && !material.isNodeMaterial) return; // a classic material plan 01's renderer converts itself: no term
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
    ctx.roadside?.setHeadlights?.(true);
  }
  const roadsideMats = [];
  attachRoadside();
  ctx.materials?.setHeadlights?.(true);
  // plan 01's renderer: the corridor's buildings (and later surfaces of that kind) through the session's surfaces
  const offSurfaces = !legacy && ctx.eachSurface ? ctx.eachSurface((m, kind) => { if (kind === 'building') attach(m); }) : () => {};

  // the roadside buildings and the traffic arrive later: look for their materials now and then
  let lateCheck = 0;
  const lateDone = { corridor: false, traffic: false };
  function findLate() {
    for (const name of Object.keys(lateDone)) {
      if (lateDone[name]) continue;
      ctx.group.getObjectByName(name)?.traverse((o) => {
        if (!o.isMesh || o.material?.type === 'ShaderMaterial') return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m && (m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial)) { attach(m); lateDone[name] = true; }
        }
      });
    }
  }

  let enabled = true, high = false, beams = 0, on = false, ambient = 0;
  const timings = createTimings();
  let lamps = null, basis = null;

  function apply() {
    const which = high ? 'high' : 'low';
    const gain = on ? displayFade({ legacy, display, fade: beams }) : 0;
    terms.set({ which, peak: maps[which].peakCd * gain, on: on && gain > 0, lamps, basis });
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
        if (legacy && lateCheck++ % 30 === 0 && !(lateDone.corridor && lateDone.traffic)) findLate();
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
      return { on, high, beams, ambientLux: ambient, materials: { beam: counts.beam, retro: counts.retro }, mask: !!terms.hasMask, renderer: legacy ? 'classic' : 'node', display, js: { mean: t.mean, p95: t.p95, max: t.max } };
    },
    dispose() {
      offGround();
      offSurfaces();
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
      for (const u of [...undo, ...roadsideUndo].reverse()) u();
      ctx.materials?.setHeadlights?.(false);
      ctx.roadside?.setHeadlights?.(false);
      terms.dispose();
    },
  };
  ctx.group.userData.headlightsPart = part; // for tests/manual/headlights-shots.mjs
  return part;
}
