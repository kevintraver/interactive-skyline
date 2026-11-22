// Everything Drive mode builds and runs, created the first time Drive is entered (index.js imports
// this module only then). It owns the drive's scene objects (wide ground, skirts, road chunks), the
// clock, the journey and the rig, and runs one frame at a time from the app's animation loop.
//
// The usual frame (plan 02, section 5.7): clock.advance -> journey.poseAt -> chunks.update ->
// rig.apply on the app's own camera. Everything else (which look, what the pill shows) follows from
// the pose and the clock, so a frame is a pure function of simulation time and the look state.

import * as THREE from 'three';
import { createFrame, EARTH_R, localUp } from '../world/frame.js';
import { buildWideMesh } from '../world/terrain/widemesh.js';
import { buildSkirt } from '../world/terrain/skirt.js';
import { loadRoutes } from './routes.js';
import { createRoadMaterials } from './roadnet/material.js';
import { createRoadChunks } from './roadnet/chunks.js';
import { createEnv } from './env.js';
import { createJourney } from './journey.js';
import { defaultDeparture } from './moment.js';
import { createRig } from './vehicle/rig.js';
import { isNightAt } from './look.js';
import { sightOverGround } from './sightline.js';
import { createTimings } from './timing.js';

/** Real time a single frame may advance the clock by, so a hidden tab or a stalled frame does not jump the car. */
const MAX_STEP_MS = 250;
/** Metres the skirts hang below the edges of the finer terrain meshes: more than the 8 m sink and the grids' disagreement. */
const SKIRT_DEPTH = 20;
const RAD = Math.PI / 180;

const bitmapOf = (blob) => createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

/**
 * Download and build everything the drive needs. Rejects (leaving nothing in the scene) when a file fails.
 * @param {object} ctx the context initDrive was given  @param {object} terrain from createTerrain
 * @param {{ onFrame: (session: object) => void }} hooks onFrame runs at the end of every drive frame (the UI)
 */
export async function createSession(ctx, terrain, hooks) {
  const { city, DATA, scene, renderer, camera, seam, invalidate, applyNight, settings, tall, getLow, ground } = ctx;
  const get = async (name) => {
    const r = await fetch(`${DATA}/${name}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r;
  };
  const [net, wide, bitmap] = await Promise.all([
    loadRoutes({ fetchJson: (n) => get(n).then((r) => r.json()), fetchBinary: (n) => get(n).then((r) => r.arrayBuffer()) }),
    terrain.loadWide(),
    terrain.hasWide ? get('ground-wide.jpg').then((r) => r.blob()).then(bitmapOf) : null,
  ]);

  const group = new THREE.Group();
  group.name = 'drive';
  group.visible = false;
  let wideMesh = null, wideMap = null;
  if (wide) {
    if (bitmap) {
      wideMap = new THREE.Texture(bitmap);
      wideMap.flipY = false; // flipped while decoding, as main.js does for its grids
      wideMap.colorSpace = THREE.SRGBColorSpace;
      wideMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
      wideMap.needsUpdate = true;
    }
    wideMesh = buildWideMesh({ wide, hole: terrain.grid('far'), base: city.base, map: wideMap });
    group.add(wideMesh);
  }
  // ground[i] is drawn from the grid named alongside it; a skirt fills the ledge at each one's edge
  for (const [mesh, name] of ground) group.add(buildSkirt(mesh, terrain.grid(name), SKIRT_DEPTH));
  const roads = new THREE.Group();
  roads.name = 'roads';
  group.add(roads);
  scene.add(group);

  const materials = createRoadMaterials({ anisotropy: renderer.capabilities.getMaxAnisotropy() });
  const chunks = createRoadChunks({ roadnet: net.roadnet, base: city.base, earthR: EARTH_R, parent: roads, materials });
  const env = createEnv({ city });
  const clock = env.clock;
  const frameOf = createFrame(city);
  const rig = createRig();
  const journeys = new Map();

  let journey = null, pose = null, needPose = true, lastNow = null, loading = false, updateId = 0;
  // the hold-position lock (plan 02, section 4.3) and the start chip the visitor last chose
  let locked = false, startKey = 'reveal';
  const timings = { total: createTimings(), journey: createTimings(), chunks: createTimings(), rig: createTimings(), ui: createTimings() };
  const viewport = () => ({ width: innerWidth, height: innerHeight });

  function journeyFor(routeId) {
    const route = net.route(routeId);
    if (!route) throw new Error(`no route "${routeId}" (routes: ${net.routes.map((r) => r.id).join(', ')})`);
    if (!journeys.has(route.id)) {
      journeys.set(route.id, createJourney({ route, road: net.roadOf(route), frame: frameOf, departMs: 0, startS: route.starts.reveal, city: ctx.cityId }));
    }
    return journeys.get(route.id);
  }

  /** The look (day or night) for the clock's time; switches the app's look and the road's, not the saved setting. */
  function updateLook() {
    const night = isNightAt(env.ephemeris.sun(clock.now()).elevation);
    if (seam.night === night) return;
    seam.night = night;
    applyNight();
    chunks.setNight(night);
    document.documentElement.dataset.theme = night ? 'dark' : 'light';
  }

  /** Bring the pose, the road chunks and the look up to date with the clock. */
  function update() {
    let t = performance.now();
    const lap = (name) => { const n = performance.now(); timings[name].add(n - t); t = n; };
    pose = journey.poseAt(clock.now());
    lap('journey');
    chunks.update({ x: pose.position.x, y: -pose.position.z });
    const id = ++updateId;
    loading = true;
    // Paused, the next frame is drawn once the chunks are in, not one per chunk as they arrive: the
    // mesher is quick, and on a slow GPU (or a software one) frames in between starve it of CPU.
    // Playing, the clock asks for every frame anyway.
    chunks.whenSettled().then(() => { if (id === updateId) loading = false; invalidate(); });
    updateLook();
    lap('chunks');
  }

  const session = {
    net, env, clock, rig, chunks, group, terrain, timings,
    get journey() { return journey; },
    get pose() { return pose; },
    get loading() { return loading; },
    get locked() { return locked; },
    get startKey() { return startKey; },
    /** The car is at the end of the route, holding there. */
    get arrived() { return !!(pose && journey && pose.s >= journey.s1 - 1); },

    /**
     * Put the car on a route. With no time, the default moment (moment.js): today, timed so the reveal
     * falls in mid civil twilight. With a time, the journey is re-timed so `s` falls at `t`.
     * @param {string} routeId  @param {{ s?: number, t?: number }} [at]
     */
    configure(routeId, { s, t } = {}) {
      journey = journeyFor(routeId);
      const startS = Number.isFinite(s) ? s : journey.route.starts.reveal ?? journey.s0;
      if (Number.isFinite(t)) journey.rebase(startS, t);
      else {
        const d = defaultDeparture({ journey, env, startS });
        journey.rebase(startS, Number.isFinite(d.startMs) ? d.startMs : Date.now());
      }
      clock.seek(journey.timeAt(startS));
      needPose = true;
      invalidate();
    },

    /** Move the car: both s and t re-time the journey; s alone moves the clock to when the car is there. */
    seek({ s, t } = {}) {
      if (Number.isFinite(s) && Number.isFinite(t)) { journey.rebase(s, t); clock.seek(t); }
      else if (Number.isFinite(s)) clock.seek(journey.timeAt(s));
      else if (Number.isFinite(t)) clock.seek(t);
      // the pose is current at once; the next frame redoes it and times the whole frame. No frame is
      // asked for here: update() asks for one once the road chunks for the new place are in
      if (group.visible) update();
      needPose = true;
    },
    seekBy(seconds) { session.setTime(clock.now() + seconds * 1000); },

    /** Change the time. Unlocked the car drives along the journey to where it is then; locked it stays. */
    setTime(t) {
      if (!Number.isFinite(t)) return;
      if (locked && pose) session.keepPlace(t); else session.seek({ t });
    },
    /** Change the time and keep the car where it is, lock or no lock (the time-of-day jumps). */
    keepPlace(t) {
      if (!Number.isFinite(t) || !pose) return;
      session.seek({ s: pose.s, t });
    },
    /** Locked, the journey is re-based every frame so the car holds its place while the clock runs. */
    setLocked(on) { locked = !!on; },
    setRate(rate) { clock.setRate(rate); },
    /** The default moment (moment.js) for where the car is, on the clock's own day. */
    duskAt() {
      if (!pose) return NaN;
      return defaultDeparture({ journey, env, startS: pose.s, nowMs: clock.now() }).startMs;
    },
    /** A start chip: the car goes to that start at the default moment for it. */
    startFrom(key) {
      const s = journey?.route.starts?.[key];
      if (!Number.isFinite(s)) return;
      startKey = key;
      session.configure(journey.route.id, { s });
      if (group.visible) update();
    },
    /** From the end of the route: drive it again from the chosen start, on the same timing. */
    restart() {
      const s = journey?.route.starts?.[startKey] ?? journey?.startS;
      if (Number.isFinite(s)) session.seek({ s });
    },

    /** Show or hide the drive's scene objects. */
    show(on) {
      group.visible = on;
      lastNow = null;
      if (on) {
        if (wideMesh) {
          wideMesh.material.map = settings.imagery ? wideMap : null;
          wideMesh.material.color.set(settings.imagery ? 0xffffff : 0xbdb9ad);
          wideMesh.material.needsUpdate = true;
        }
        needPose = true;
        update();
      }
      invalidate();
    },

    /** One frame, run by the app's animation loop before it renders. */
    frame(now) {
      const t0 = performance.now();
      const dt = lastNow === null ? 0 : Math.min(Math.max(now - lastNow, 0), MAX_STEP_MS);
      lastNow = now;
      const before = clock.now();
      clock.advance(dt);
      if (locked && pose && clock.now() !== before) journey.rebase(pose.s, clock.now());
      const moved = needPose || clock.now() !== before;
      if (moved) {
        needPose = false;
        update(); // asks for a frame once the chunks are in; a playing clock asks for every frame below
      }
      let t = performance.now();
      // every tick: resize() may have put the map's lens back on the shared camera
      rig.apply(camera, pose, viewport());
      ctx.sky.position.copy(camera.position);
      if (moved) timings.rig.add(performance.now() - t);
      t = performance.now();
      hooks.onFrame(session);
      if (moved) {
        timings.ui.add(performance.now() - t);
        timings.total.add(performance.now() - t0);
      }
      if (clock.playing) invalidate();
    },

    /** Look at a point in the scene: the head turns, the car does not. */
    lookAt(point) {
      const eye = camera.position, up = localUp(eye.x, eye.z, new THREE.Vector3());
      const dir = point.clone().sub(eye).normalize();
      const fh = pose.forward.clone().addScaledVector(up, -pose.forward.dot(up)).normalize();
      const dh = dir.clone().addScaledVector(up, -dir.dot(up)).normalize();
      const yaw = Math.atan2(new THREE.Vector3().crossVectors(fh, dh).dot(up), fh.dot(dh)) / RAD;
      const pitch = (Math.asin(dir.dot(up)) - Math.asin(pose.forward.dot(up))) / RAD;
      rig.look({ yaw, pitch });
      invalidate();
    },

    /** Whether a building's top can be seen from the eye: standing, and clear of the terrain and other buildings. */
    visible(targetId) {
      const entry = tall.find((e) => e.data.id === targetId);
      if (!entry || !entry.mesh.visible || !pose) return false;
      const eye = rig.apply(scratch, pose, viewport()).position.clone();
      const top = topOf(entry).add(entry.mesh.position);
      if (!sightOverGround(eye, top, terrain.groundY).clear) return false;
      const dist = eye.distanceTo(top);
      ray.set(eye, top.clone().sub(eye).normalize());
      ray.far = dist - 1;
      const others = tall.filter((e) => e !== entry && e.mesh.visible).map((e) => e.mesh);
      if (ray.intersectObjects(others, false).length) return false;
      const low = getLow();
      return !(low && low.geometry.boundsTree && ray.intersectObject(low, false).length);
    },

    /** Resolves when the road chunks and terrain for the current pose are in and a frame with them has been drawn. */
    async whenSettled() {
      if (!pose || !group.visible) await nextFrame(); // seek and show bring the chunks up to date at once; otherwise a frame does
      await Promise.all([chunks.whenSettled(), terrain.whenSettled()]);
      const drawn = renderer.info.render.frame;
      invalidate();
      while (renderer.info.render.frame === drawn) await nextFrame();
    },

    /** Pose as plain numbers. */
    poseNumbers() {
      if (!pose) return null;
      const v = (p) => ({ x: p.x, y: p.y, z: p.z });
      return {
        route: journey.route.id, s: pose.s, km: pose.s / 1000, lane: pose.lane, lateral: pose.lateral,
        speed: pose.speed, mph: pose.speed / 0.44704, accel: pose.accel, grade: pose.grade, curvature: pose.curvature,
        position: v(pose.position), forward: v(pose.forward), up: v(pose.up), eye: v(rig.apply(scratch, pose, viewport()).position),
        t: clock.now(), iso: new Date(clock.now()).toISOString(), playing: clock.playing,
        yaw: rig.yaw, pitch: rig.pitch, lens: rig.lens, night: !!seam.night, rate: clock.rate, locked, arrived: session.arrived,
        sunElevation: env.ephemeris.sun(clock.now()).elevation,
      };
    },

    stats() {
      const r = renderer.info.render;
      return {
        render: { calls: r.calls, triangles: r.triangles },
        roads: chunks.stats(),
        terrain: terrain.stats(),
        js: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v.summary()])),
      };
    },
  };

  const scratch = new THREE.PerspectiveCamera();
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const tops = new WeakMap();
  /** The highest vertex a building draws, where it really stands (the same point scripts/lib/sightline.py uses). */
  function topOf(entry) {
    const geo = entry.mesh.geometry;
    if (!tops.has(geo)) {
      const p = geo.getAttribute('position');
      let k = 0;
      for (let i = 1; i < p.count; i++) if (p.getY(i) > p.getY(k)) k = i;
      tops.set(geo, new THREE.Vector3(p.getX(k), p.getY(k), p.getZ(k)));
    }
    return tops.get(geo).clone();
  }

  return session;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
