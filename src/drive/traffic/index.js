// The `traffic` drive part (plan 02, D6.4): vehicles on both carriageways, placed by the demand model.
//
// Per route (loaded the first time the journey is on it): the route's traffic file (routes.json
// files.traffic), the demand surface over it (demand.js), and the lane map onto the route's road and the
// opposing carriageway the file names (lanemap.js). Once: the vehicle models (public/models/drive/).
//
// Per frame (update, when the pose moved): the fleet places every vehicle within range ahead and behind
// on both carriageways (fleet.js; the range is where a sedan shrinks below a few pixels with the current
// lens; behind the car only BEHIND_SHARE of it, enough for the mirrors, unless the camera looks back).
// Per render (beforeRender): the renderer
// sorts them into the twelve instanced meshes by size on screen and culls by the view (render.js).
// Nothing is carried from frame to frame but caches: the same simulation time gives the same vehicles.
//
// The part's own API, beyond the session's (update, beforeRender, setLook, whenSettled, stats, dispose):
//   lampPoints()   the lamps of the vehicles drawn this frame (render.js header), for the light sprites
//   placed()       the fleet's placement this frame (fleet.js), for tests and the debug overlay
//   model()        { traffic, laneMap, fleet } of the current route, or null
//   renderer       the instanced meshes (render.js), for tests and the frame-budget probe
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createTraffic } from './demand.js';
import { createLaneMap } from './lanemap.js';
import { createFleet } from './fleet.js';
import { createTrafficRenderer } from './render.js';
import { createTimings } from '../timing.js';

const MODELS = '/models/drive/';
/** Share of the range kept behind the car when the camera looks forward (all of it when it looks back). */
const BEHIND_SHARE = 0.35;

/** @param {object} ctx the part context (parts.js) */
export async function createTrafficPart(ctx) {
  const { session, net, frameOf, earthR, group } = ctx;
  const [sidecar, gltf] = await Promise.all([
    fetch(`${MODELS}vehicles.json`).then((r) => { if (!r.ok) throw new Error(`vehicles.json: HTTP ${r.status}`); return r.json(); }),
    new GLTFLoader().loadAsync(`${MODELS}vehicles.glb`),
  ]);
  const renderer = createTrafficRenderer({ parent: group, sidecar, gltf });
  const models = new Map(); // route id -> Promise<{ traffic, laneMap, fleet } | null>
  let current = null, currentId = null, loading = Promise.resolve();
  let placed = null;
  const placedWindow = { s: 0, range: 0 };
  const timings = { place: createTimings(), draw: createTimings() };

  function modelFor(route) {
    if (!models.has(route.id)) {
      const p = (async () => {
        const file = net.filesOf(route).traffic;
        const data = await ctx.optional(file);
        if (!data) return null;
        const traffic = createTraffic(data);
        const roadnet = net.roadnetOf(route);
        const byId = (id) => roadnet.roads.find((r) => r.id === id);
        const roads = { with: byId(traffic.file.directions.with.road) || net.roadOf(route), against: byId(traffic.file.directions.against.road) };
        if (!roads.against) throw new Error(`traffic: no road ${traffic.file.directions.against.road} for ${route.id}`);
        const laneMap = createLaneMap({ traffic, roads });
        const fleet = createFleet({ traffic, laneMap, frame: frameOf, lengths: renderer.lengths, earthR });
        return { traffic, laneMap, fleet };
      })().catch((e) => { console.warn(`traffic for ${route.id} left out: ${e && e.message ? e.message : e}`); return null; });
      models.set(route.id, p);
    }
    return models.get(route.id);
  }

  /** Make sure the journey's route has its model; returns true when it is ready. */
  function ensure() {
    const route = session.journey?.route;
    if (!route) return false;
    if (route.id !== currentId) {
      currentId = route.id;
      current = null;
      renderer.clear();
      loading = modelFor(route).then((m) => {
        if (currentId === route.id) { current = m; ctx.app?.invalidate?.(); }
      });
      return false;
    }
    return !!current;
  }

  const range = { ahead: 0, behind: 0, full: 0 };
  function rangeFor(frame) {
    const cam = frame.camera, pose = frame.pose;
    const full = renderer.rangeFor(cam, frame.viewport?.height || 720);
    // the camera's look along the car: forward (1) .. back (-1); from above, both ways
    const e = cam.matrixWorld.elements;
    const c = -(e[8] * pose.forward.x + e[9] * pose.forward.y + e[10] * pose.forward.z);
    const lookAhead = c > 0 ? c : 0, lookBack = c < 0 ? -c : 0;
    const height = cam.position.y - pose.position.y;
    const wide = height > 30 ? 1 : 0; // a view from above sees both ways
    range.full = full;
    range.ahead = full * Math.max(BEHIND_SHARE + (1 - BEHIND_SHARE) * (1 - lookBack), wide);
    range.behind = full * Math.max(BEHIND_SHARE + (1 - BEHIND_SHARE) * (1 - lookAhead), wide);
    return range;
  }

  const part = {
    name: 'traffic',
    update(frame) {
      if (!ensure()) { placed = null; return; }
      const t0 = performance.now();
      const r = rangeFor(frame);
      const s = frame.pose.s;
      placed = current.fleet.place(frame.simMs, s - r.behind, s + r.ahead, frame.pose);
      placedWindow.s = s;
      placedWindow.range = Math.max(r.ahead, r.behind);
      timings.place.add(performance.now() - t0);
    },
    beforeRender(frame) {
      if (!placed || !current) { renderer.clear(); return; }
      const t0 = performance.now();
      // the camera turned (looked back, zoomed out) since the placement: place again for the new range
      const ahead = range.ahead, behind = range.behind;
      rangeFor(frame);
      if (range.ahead > ahead * 1.1 || range.behind > behind * 1.1) {
        placed = current.fleet.place(frame.simMs, frame.pose.s - range.behind, frame.pose.s + range.ahead, frame.pose);
        placedWindow.range = Math.max(range.ahead, range.behind);
      } else { range.ahead = ahead; range.behind = behind; }
      renderer.draw(placed, frame.camera, frame.viewport?.height || 720, placedWindow);
      timings.draw.add(performance.now() - t0);
    },
    setLook(look) {
      const dusk = Math.min(1, Math.max(0, look.dusk ?? (look.night ? 1 : 0)));
      renderer.uniforms.uDusk.value = dusk;
      renderer.uniforms.uStrength.value = 0.6 - 0.35 * dusk;
    },
    whenSettled: () => loading,
    stats() {
      const f = current?.fleet.stats();
      return {
        route: currentId, ready: !!current,
        enumerated: f?.enumerated ?? 0, placed: f?.placed ?? 0, gapped: f?.gapped ?? 0,
        ...renderer.stats(),
        range: { ahead: Math.round(range.ahead), behind: Math.round(range.behind) },
        js: { place: timings.place.summary(), draw: timings.draw.summary() },
      };
    },
    lampPoints: () => renderer.lampPoints(),
    placed: () => placed,
    model: () => (current ? { traffic: current.traffic, laneMap: current.laneMap, fleet: current.fleet } : null),
    /** The renderer (render.js), for tests and the frame-budget probe. */
    renderer,
    dispose() { renderer.dispose(); },
  };
  renderer.group.userData.part = part; // for tests/manual/traffic-shots.mjs, which finds it in the scene
  return part;
}
