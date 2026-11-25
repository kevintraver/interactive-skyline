// The ground, the airport and the sky for a flight (plan 03, sections 7.9, 7.10 and 7.14; F4.7, F4.8, F6.2).
//
//   regional terrain  region, approaches and valley (src/flight/terrain): ground to the horizon from cruise, drawn
//                     under and around the map's near and far grids, which stay the map's own meshes
//   the airport       pavement, paint and lights (src/flight/airport), built from airport.json during the entry
//   airport ground    the map's near and far meshes moved onto the airport's height model while flying, and a 12 m
//                     inset for the part of the airport outside the near grid (view/airportGround.js), so that the
//                     wheels, the pavement and the ground around it agree; given back bit for bit on leaving
//   map apron         the map's own apron ring around the far grid stands above the regional ground in places: hidden
//                     while flying
//   night ground      every street lamp of the valley and the region's towns as light points, the lit streets under
//                     the eye in place of the map's orange street glow, the valley's traffic as ribbons of light and the
//                     obstruction lights on tall buildings, all switched by the Sun (src/flight/ground; F6.4, 7.11);
//                     the airport's lights cross the same air
//   sky dome          centred on the camera already (src/sky/legacySky.js); scaled while flying to just inside the far
//                     plane (view/layers.js nearFar: the eye's horizon plus the highest summit's, up to 700 km), so the
//                     terrain is in front of it and the far plane never cuts it. Scale 1 again on leaving
//
// Everything here is added on show(true) and taken out on show(false); the map's look is untouched when not flying.
import { Group, Mesh, BufferGeometry, BufferAttribute } from 'three';
import { createRegionTerrain } from './terrain/index.js';
import { createAirport } from './airport/index.js';
import { createPavementIndex, EASE_M } from './airport/geometry.js';
import { conformGround, applyConformed, buildInset, insetY, onInset, pavementBox, airportTerrain } from './view/airportGround.js';
import { createNightGround } from './ground/index.js';
import { levelsFor } from './airport/lightLayout.js';

/** The sky dome's radius in src/sky/legacySky.js. */
const DOME_R = 120000;
/** The dome sits at this fraction of the far plane. */
const DOME_AT = 0.97;
/** Ground beyond the pavement that is worked on (m): the runways' ease, and room for the inset's edges. */
const AROUND = EASE_M + 200;

/** Scene Y of a ground mesh's triangles at map (x, y), split as src/city/terrain.js indexes each cell. */
function meshY(array, g, x, y) {
  const fx = Math.min(Math.max((x - g.x0) / g.step, 0), g.nx - 1), fy = Math.min(Math.max((y - g.y0) / g.step, 0), g.ny - 1);
  const i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2), ax = fx - i, ay = fy - j;
  const at = (ii, jj) => array[(jj * g.nx + ii) * 3 + 1];
  const a = at(i, j), b = at(i + 1, j), d = at(i, j + 1), e = at(i + 1, j + 1);
  return ax + ay <= 1 ? a + ax * (b - a) + ay * (d - a) : e + (1 - ax) * (d - e) + (1 - ay) * (b - e);
}

/**
 * The airport ground: conformed heights for the map's two meshes and the inset, worked out once (about 100 ms) and
 * applied while flying.
 */
function airportGround({ airport, data, provider, ground, base }) {
  const near = provider.grid('near'), far = provider.grid('far');
  const nearMesh = ground.near, farMesh = ground.far;
  if (!near || !far || !nearMesh || !farMesh) return null;
  const nearBox = { x0: near.x0, x1: near.x0 + (near.nx - 1) * near.step, y0: near.y0, y1: near.y0 + (near.ny - 1) * near.step };
  const pave = createPavementIndex(data);
  const onPavement = (x, y, tol) => pave.on(x, y, tol);
  const box = pavementBox(data, AROUND);
  const nearAttr = nearMesh.geometry.attributes.position, farAttr = farMesh.geometry.attributes.position;
  const t0 = performance.now();
  const cNear = conformGround({ positions: nearAttr, grid: near, base, heightModel: airport.heightAt, onPavement, box });
  const nearCopy = nearAttr.array.slice();
  for (let n = 0; n < cNear.index.length; n++) nearCopy[cNear.index[n] * 3 + 1] = cNear.conformed[n];
  const farArray = farAttr.array;
  const inset = buildInset({
    far, farY: (x, y) => meshY(farArray, far, x, y), nearY: (x, y) => meshY(nearCopy, near, x, y), near: nearBox, box, base,
    heightModel: airport.heightAt, onPavement,
  });
  const cFar = inset ? conformGround({ positions: farAttr, grid: far, base, hole: nearBox, heightModel: airport.heightAt, onPavement, box, under: inset }) : null;
  let insetMesh = null;
  if (inset) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(inset.position, 3));
    geo.setAttribute('normal', new BufferAttribute(inset.normal, 3));
    geo.setAttribute('uv', new BufferAttribute(inset.uv, 2));
    geo.setIndex(new BufferAttribute(inset.index, 1));
    geo.computeBoundingSphere();
    insetMesh = new Mesh(geo, farMesh.material); // the far photo and the map's terrain material: imagery and night follow it
    insetMesh.name = 'flight airport ground';
    insetMesh.receiveShadow = farMesh.receiveShadow;
    insetMesh.raycast = () => {}; // picking is for buildings
  }
  const buildMs = performance.now() - t0;
  let on = false;
  return {
    insetMesh, box, nearBox,
    /** On runway, taxiway or apron. */
    paved: (x, y) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] && !!pave.classAt(x, y),
    set(next) {
      if (next === on) return;
      on = next;
      applyConformed(nearAttr, cNear, on);
      if (cFar) applyConformed(farAttr, cFar, on);
    },
    /** Scene Y of the ground drawn at map (x, y), or null outside the airport's box. */
    groundY(x, y) {
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) return null;
      if (inset && onInset(inset, x, y)) return insetY(inset, x, y);
      if (x >= nearBox.x0 && x <= nearBox.x1 && y >= nearBox.y0 && y <= nearBox.y1) return meshY(on ? nearAttr.array : nearCopy, near, x, y);
      return null;
    },
    stats: () => ({ buildMs: +buildMs.toFixed(1), nearMoved: cNear.index.length, farMoved: cFar?.index.length ?? 0, insetTriangles: inset ? inset.index.length / 3 : 0, on }),
    dispose() { this.set(false); insetMesh?.geometry.dispose(); },
  };
}

/**
 * @param {{ scene: import('three').Scene, fe: ReturnType<import('./env.js').createFlightEnv>, provider: object,
 *   meta: object, data: string, ground: { near: import('three').Mesh, far: import('three').Mesh }, sky: { dome: import('three').Mesh },
 *   settings: { imagery: boolean }, renderer?: object, fetchJson?: (file: string) => Promise<object>, tall?: object[] }} o
 *   provider: the app's terrain provider (src/world/terrain createTerrain); meta: terrain.json; data: the city's data
 *   folder (/data/<city>); ground: the map's own near and far meshes (main.js app.terrain); tall: the map's removable
 *   towers (app.tall), for their obstruction lights (found in the scene when not given)
 */
export async function createFlightWorld({ scene, fe, provider, meta, data, ground, sky, settings, renderer = null, fetchJson = null, tall = null }) {
  const base = fe.frame.base;
  const getJson = fetchJson ?? (async (file) => {
    const r = await fetch(`${data}/${file}`);
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return r.json();
  });
  const group = new Group();
  group.name = 'flight world';
  group.visible = false;

  const region = createRegionTerrain({ meta, baseUrl: data, frame: fe.frame, terrain: provider, nodes: fe.nodes, quality: fe.quality });
  group.add(region.group);

  // the airport costs about 350 ms on the main thread: built here, during the entry and before the fade-in
  let airport = null, apGround = null, airportError = null;
  try {
    const airportData = await getJson('airport.json');
    const near = provider.grid('near');
    airport = createAirport({ data: airportData, frame: fe.frame, terrain: near ? airportTerrain(provider, near) : provider, nodes: fe.nodes, quality: fe.quality });
    group.add(airport.group);
    apGround = airportGround({ airport, data: airportData, provider, ground, base });
    if (apGround?.insetMesh) group.add(apGround.insetMesh);
  } catch (err) {
    airportError = String(err?.message ?? err);
    console.warn('Fly: the airport could not be built; the runway is the ground photograph.', err);
  }
  // the night ground: its files load at the first frame the Sun is low enough for a lamp to be lit
  const night = createNightGround({ fe, region, ground, data, renderer, scene, tall });
  group.add(night.group);

  scene.add(group);
  const mapApron = scene.getObjectByName('terrain apron');
  let apronWas = null, shown = false;

  const world = {
    group, region, airport, night,
    /** Add or take out the flight's ground; moves the map's ground under the airport, hides the map's apron. */
    show(on) {
      shown = !!on;
      group.visible = shown;
      apGround?.set(shown);
      night.show(shown);
      if (shown) {
        if (mapApron && apronWas === null) { apronWas = mapApron.visible; mapApron.visible = false; }
      } else {
        if (mapApron && apronWas !== null) { mapApron.visible = apronWas; apronWas = null; }
        if (sky.dome) sky.dome.scale.setScalar(1);
      }
    },
    /**
     * Scene Y of the ground the aircraft stands on, as drawn: the airport's pavement (its runway profile on a runway),
     * the airport's conformed ground and inset around it, the regional terrain elsewhere.
     */
    surfaceY(x, y) {
      if (apGround) {
        if (apGround.paved(x, y)) return airport.groundY(x, y);
        const g = apGround.groundY(x, y);
        if (g !== null) return g;
      }
      return region.surfaceY(x, y);
    },
    /** Load the grids a position needs (before the first frame of a flight). */
    preload: (o) => region.preload(o),
    whenSettled: () => Promise.all([region.whenSettled(), provider.whenSettled?.(), night.whenSettled()]),
    /**
     * Every frame while flying, after the camera is placed: the grids the eye can see, the photo setting, the airport's
     * lights, and the dome just inside the far plane.
     * @param {{ camera: import('three').PerspectiveCamera, position: { x: number, y: number, z: number }, simMs?: number,
     *   wallS?: number, night?: boolean, reducedMotion?: boolean, visibilityM?: number }} o
     */
    update({ camera, position, simMs = 0, wallS = 0, night: isNight = false, reducedMotion = false, visibilityM = 80000 }) {
      region.update({ camera, position, renderer });
      region.setImagery(settings.imagery);
      night.update({ camera, simMs, visibilityM });
      // the airport's lights cross the same air as the city's (the extinction from the eye's height, given as the
      // visibility that has it); their brightness steps follow the visibility on the ground, as the tower sets them
      airport?.update({ camera, simMs, wallS, night: isNight, reducedMotion, visibilityM: night.airportVisibilityM,
        levels: levelsFor({ night: isNight, visibilityM }) });
      if (sky.dome) sky.dome.scale.setScalar((camera.far * DOME_AT) / DOME_R);
    },
    stats() {
      return { region: region.stats(), airport: airport ? airport.stats() : null, airportError, airportGround: apGround?.stats() ?? null, ground: night.stats() };
    },
    dispose() {
      world.show(false);
      apGround?.dispose();
      night.dispose();
      airport?.dispose();
      region.dispose();
      group.removeFromParent();
    },
  };
  return world;
}
