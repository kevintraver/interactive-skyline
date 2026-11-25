// The ground at night from the air (plan 03, F6.3, F6.4, sections 7.11, 7.14, 9.1 and 9.2). One entry point:
//
//   (createNightGround, from this file; src/flight/world.js makes one)
//   const night = createNightGround({ fe, region, ground, data, renderer, scene });
//   group.add(night.group);                     // with the flight's world
//   night.show(true);                           // on entering a flight (false on leaving: the map's ground is given back)
//   night.update({ camera, simMs, visibilityM });   // every frame, after the camera is placed
//   await night.whenSettled();                  // nothing loading
//   night.stats();  night.dispose();
//
// What is drawn, all of it switched by the Sun as the drive's lamps are (each lamp's photocell against the ambient light
// of the moment, src/drive/lights/switching.js, so lamps come on through civil twilight and a frame is a pure function
// of the clock):
//   lamps     every street lamp of the valley's inventory and of the region's towns as light points, one draw
//             (lamps.js, thin.js); the files load at the first frame the Sun is low enough for any lamp to be lit;
//   ground    dark between the lamps: while flying, the map's orange street glow on its near and far grids (an
//             emissive over the whole of both, src/sky/legacySky.js STREET_GLOW) is switched off, so the airport's
//             infield, the desert and the mountains have no light of their own. The streets' light is in the lamps'
//             points (each carries its pool and its neighbourhood's light from a few hundred metres out, lamps.js);
//   traffic   the valley's freeways and arterials as ribbons of head and tail light, and the red obstruction lights on
//             tall buildings: the drive's parts, run here (driveParts.js);
//   air       how much of a lamp's light reaches the eye, from the eye's height and the ground's visibility
//             (extinction.js); the airport's lights take the same (`airportVisibilityM`).

import { Group } from 'three';
import { vec3 } from 'three/tsl';
import { createEphemeris } from '../../sky/ephemeris.js';
import { ambientLux as ambientLuxAt, ephemerisOn } from '../../drive/env.js';
import { createOnTable, litShare, SWITCH_MID_LUX, SWITCH_SPREAD, ON_TABLE } from '../../drive/lights/switching.js';
import { EARTH_R } from '../../world/frame.js';
import { altitudeOf } from '../../core/earth.js';
import { createAirLamps, AIR_BUDGET } from './lamps.js';
import { extinctionLength, visibilityForLength } from './extinction.js';
import { flightPartContext, loadDriveParts, collectTall } from './driveParts.js';

/** The highest photocell threshold a lamp can have (switching.js: u clamped to 1e-4): above this ambient no lamp is lit. */
export const LIT_BELOW_LUX = SWITCH_MID_LUX * ((1 - 1e-4) / 1e-4) ** SWITCH_SPREAD;
/**
 * The obstruction lights switch on below this ambient illuminance (lux): 35 foot-candles. FAA AC 70/7460-1M has
 * obstruction lighting switched by a photocell facing the northern sky, on as that light falls through about 35 fc and
 * off above 60 fc. The figure is RECALLED, not re-read: the circular could not be fetched on 25 Nov 2026 (both the
 * FAA's and the FCC's copies refused). A north-facing sensor reads less than the horizontal illuminance this is
 * compared with, so the lights come on, if anything, earlier. On the street lamps' switch (as before F8.1) they were
 * still off on lv-19-dusk's final, with the Sun 1.3 degrees down.
 */
export const OBSTRUCTION_ON_LUX = 377;
/** The files, in the city's data folder. */
export const FILES = Object.freeze({ valley: 'lamps-drive', region: 'lights-region' });

/**
 * The share of the lamps lit at a Sun elevation (degrees): 0 by day, 1 at night, through civil twilight between.
 * @param {number} sunAltDeg
 */
export const lampsLitAt = (sunAltDeg) => litShare(ambientLuxAt(sunAltDeg));

/**
 * @param {{ fe: object, region: object, ground?: { near?: import('three').Mesh, far?: import('three').Mesh },
 *   data: string, renderer?: object, scene?: import('three').Scene, tall?: object[], fetchFile?: (name: string) => Promise<Response>,
 *   level?: string }} o
 *   fe: the flight environment (src/flight/env.js: city, frame, nodes, state, quality, events, invalidate); region: the
 *   regional terrain (heightAt, setEmissive); ground: the map's own near and far meshes, whose emissive is swapped
 *   while flying; data: the city's data folder (/data/<city>); scene: where the map's towers are found (their
 *   obstruction lights) unless `tall` (app.tall) is given
 */
export function createNightGround({ fe, region, ground = {}, data, renderer = null, scene = null, tall = null, fetchFile = null, level = null }) {
  const city = fe.city;
  const base = fe.frame.base;
  const getFile = fetchFile ?? ((name) => fetch(`${data}/${name}`));
  const heightAt = (x, y) => region.heightAt(x, y);
  const group = new Group();
  group.name = 'flight-night-ground';
  const quality = fe.quality ?? null;
  const lvl = () => level ?? quality?.level ?? 'high';

  // the Sun, the lamps' switching table and the air, per frame
  const ephemeris = ephemerisOn(createEphemeris({ lat: city.origin.lat, lon: city.origin.lon, elevationM: city.base ?? base }), city.tz || 'UTC');
  let onTable = null;
  const table = new Float32Array(ON_TABLE.n);
  const light = { ambientLux: 1e5, extinctionM: 80000, sunAltDeg: 90, lit: 0 };

  let lamps = null, parts = { valley: null, obstruction: null }, loading = null, loadError = null;
  let shown = false, heightKey = '', heightJob = null, lastHeightCheck = -Infinity;
  const towers = tall ?? [];
  const offRebuilt = !tall && scene && fe.events?.on ? fe.events.on('buildings:rebuilt', () => collectTall(scene, towers)) : null;
  if (!tall && scene) collectTall(scene, towers);

  // the map's near and far grids: no emissive while flying (the street glow is the lamps' now), theirs again after
  const mapMaterials = [...new Set([ground.near?.material, ground.far?.material].filter((m) => m?.isNodeMaterial))];
  const dark = vec3(0, 0, 0);
  const saved = new Map();
  function darkenMapGround(on) {
    for (const m of mapMaterials) {
      if (on) {
        if (!saved.has(m)) { saved.set(m, m.emissiveNode ?? null); m.emissiveNode = dark; m.needsUpdate = true; }
      } else if (saved.has(m)) {
        m.emissiveNode = saved.get(m); m.needsUpdate = true; saved.delete(m);
      }
    }
  }

  const json = async (name) => { const r = await getFile(name); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); };
  const bin = async (name) => { const r = await getFile(name); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.arrayBuffer(); };
  const optionalPack = async (stem) => {
    try { const meta = await json(`${stem}.json`); return { meta, buffer: await bin(meta.file || `${stem}.bin`), name: stem }; } catch (err) {
      console.warn(`Fly: ${stem} is missing; drawn without it.`, err); return null;
    }
  };

  /** Fetch and build everything (once). */
  function load() {
    if (loading) return loading;
    loading = (async () => {
      const [valley, regionPack] = await Promise.all([optionalPack(FILES.valley), optionalPack(FILES.region)]);
      const packs = [valley, regionPack].filter(Boolean);
      if (packs.length) {
        lamps = createAirLamps({ packs, heightAt, base, earthR: EARTH_R, nodes: fe.nodes, level: lvl() });
        await lamps.placeHeights();
        heightKey = heightSignature();
        group.add(lamps.mesh);
      }
      onTable = createOnTable(ephemeris);
      const ctx = flightPartContext({
        fetchFile: getFile, nodes: fe.nodes, city, heightAt, base, earthR: EARTH_R, renderer, invalidate: fe.invalidate,
        quality, tall: towers, events: fe.events, group, light,
      });
      parts = await loadDriveParts(ctx);
      fe.invalidate?.();
    })().catch((err) => { loadError = String(err?.message ?? err); console.warn('Fly: the night ground could not be built.', err); });
    return loading;
  }

  /** Which regional grids answer heights now: when it changes the lamps are put on the finer ground. */
  const heightSignature = () => ['valley', 'approaches', 'region'].map((n) => (region.grid?.(n) ? 1 : 0)).join('');
  function refreshHeights(now) {
    if (!lamps || heightJob || now - lastHeightCheck < 1000) return;
    lastHeightCheck = now;
    const k = heightSignature();
    if (k === heightKey) return;
    heightKey = k;
    heightJob = lamps.placeHeights().finally(() => { heightJob = null; fe.invalidate?.(); });
  }

  let updateMs = 0;
  const night = {
    group,
    /** Switch the flight's ground on or off: the map's grids dark, the lamps and parts with the group. */
    show(on) {
      shown = !!on;
      group.visible = shown;
      darkenMapGround(shown);
    },
    /** The light of this frame, for the airport's lights (the same air). */
    get light() { return { ...light }; },
    /** The visibility (m) whose Koschmieder extinction gives this frame's extinction length: for the airport's lights. */
    get airportVisibilityM() { return visibilityForLength(light.extinctionM); },
    /**
     * Every frame while flying, after the camera is placed.
     * @param {{ camera: import('three').PerspectiveCamera, simMs?: number, visibilityM?: number, sunAltDeg?: number }} o
     *   visibilityM: the ground's visibility (the weather's); sunAltDeg: default fe.state's Sun
     */
    update({ camera, simMs = 0, visibilityM = 80000, sunAltDeg = fe.state?.sun?.altDeg ?? 90 }) {
      const t0 = performance.now();
      light.sunAltDeg = sunAltDeg;
      light.ambientLux = ambientLuxAt(sunAltDeg);
      light.lit = litShare(light.ambientLux);
      const eyeAlt = altitudeOf(camera.position, { base });
      const groundAlt = Math.min(eyeAlt, heightAt(camera.position.x, -camera.position.z));
      const heightAboveGround = eyeAlt - groundAlt;
      light.extinctionM = extinctionLength({ eyeAltM: eyeAlt, groundAltM: groundAlt, visibilityM });
      const any = light.ambientLux < LIT_BELOW_LUX;
      if (any && !loading) load();
      if (onTable && any) onTable(simMs, table);
      if (lamps) {
        lamps.setLevel(lvl());
        refreshHeights(t0);
        lamps.update({ camera, renderer, heightAboveGround, extinctionM: light.extinctionM, ambientLux: light.ambientLux, onTable: table, on: shown && any });
      }
      const frame = { simMs, camera, dtSimMs: 0, rate: 1, playing: false };
      if (parts.valley) { parts.valley.update(frame); parts.valley.beforeRender(frame); }
      if (parts.obstruction) {
        parts.obstruction.update(frame);
        parts.obstruction.setLook({ lights: light.ambientLux < OBSTRUCTION_ON_LUX ? 1 : 0 });
        parts.obstruction.beforeRender(frame);
      }
      updateMs = performance.now() - t0;
    },
    /** Load now (the shots and tests ask for it before the Sun is low). */
    load,
    whenSettled: async () => { if (loading) await loading; if (heightJob) await heightJob; },
    stats() {
      const l = lamps?.stats() ?? null;
      const v = parts.valley?.stats?.() ?? null, o = parts.obstruction?.stats?.() ?? null;
      const draws = (l && l.drawn > 0 ? 1 : 0) + (v?.visible ? 1 : 0) + (o?.on && o.sprites > 0 ? 1 : 0);
      return {
        loaded: !!loading && !loadError, loadError, sunAltDeg: +light.sunAltDeg.toFixed(2), ambientLux: +light.ambientLux.toPrecision(3),
        lit: +light.lit.toFixed(3), extinctionKm: +(light.extinctionM / 1000).toFixed(1),
        drawn: l?.drawn ?? 0, lamps: l, mapGroundDark: saved.size,
        ribbons: v && { visible: v.visible, triangles: v.triangles, fade: +(+v.fade).toFixed(3) },
        obstruction: o && { on: o.on, lamps: o.lamps, towers: o.towers, corridor: o.corridor, flashing: o.flashing },
        draws, budget: AIR_BUDGET[lvl()] ?? AIR_BUDGET.high, updateMs: +updateMs.toFixed(3),
      };
    },
    dispose() {
      night.show(false);
      offRebuilt?.();
      lamps?.dispose();
      parts.valley?.dispose?.();
      parts.obstruction?.dispose?.();
      group.removeFromParent();
    },
  };
  return night;
}
