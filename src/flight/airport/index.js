// The drawn airport (plan 03, section 7.10; F4.2, F4.3, F4.4): pavement, paint and every light, generated from the
// city's airport.json (format skyline-airport/1, scripts/build_airport.py) and nothing else. One entry point for the
// session:
//
//   (createAirport, from this file)
//   const airport = createAirport({ data, frame: fe.frame, terrain, nodes: fe.nodes, quality: fe.quality });
//   scene.add(airport.group);                                  // on entering the flight; remove it on leaving
//   airport.update({ camera, simMs, wallS, night, reducedMotion }); // each frame, before the scene pass
//   airport.dispose();                                         // when the flight ends
//
// Three draws in all: the pavement, its paint (rubber first) and the light field. The airport's ground is the runway
// profiles on the runways and the terrain elsewhere, eased between (geometry.js); `groundY(x, y)` gives the scene Y of
// the pavement's top for anything that must stand on it (the wheels, parked aircraft).
//
// Files: geometry.js (runway frames, pavement index, height model), lightLayout.js (F4.3, pure), markings.js (F4.2's
// paint, pure), surfaces.js (F4.2's meshes), lightField.js (F4.4).

import { Group } from 'three';
import { curveDrop } from '../../world/frame.js';
import { runwayFrames, createPavementIndex, createHeightModel } from './geometry.js';
import { layoutLights } from './lightLayout.js';
import { runwayMarkings, taxiwayMarkings } from './markings.js';
import { createSurfaces, LIFT } from './surfaces.js';
import { createLightField } from './lightField.js';

/**
 * @param {{ data: object, frame: { base: number, sceneY: (h: number, x: number, y: number) => number },
 *   terrain?: { surfaceAt?: (x: number, y: number) => number, heightAt?: (x: number, y: number) => number } | null,
 *   nodes: { emissive: Function, pointSource: Function }, quality?: object | string | null }} o
 *   data: airport.json; frame: createFrame(city); terrain: plan 2's provider (src/world/terrain/): the height the app
 *   draws (surfaceAt) is preferred to the bilinear one (heightAt); without one the ground is level at the airport's
 *   elevation; nodes: env.nodes; quality: app.quality or a level name (accepted; nothing depends on it yet)
 * @returns {{ group: Group, update: (o: { camera?: import('three').Camera, simMs?: number, wallS?: number, night?: boolean,
 *   reducedMotion?: boolean, visibilityM?: number }) => void, stats: () => object, dispose: () => void,
 *   heightAt: (x: number, y: number) => number, groundY: (x: number, y: number) => number, layout: object }}
 */
export function createAirport({ data, frame, terrain = null, nodes, quality = null }) {
  if (!data || data.format !== 'skyline-airport/1') throw new Error(`createAirport: expected skyline-airport/1, got ${data?.format}`);
  const level = typeof quality === 'string' ? quality : quality?.level ?? quality?.profile?.level ?? null;
  const terrainZ = terrain?.surfaceAt ?? terrain?.heightAt ?? (() => data.arp.elevation);
  const heightAt = createHeightModel(data, (x, y) => terrainZ(x, y));
  const frames = runwayFrames(data);
  const pavementIndex = createPavementIndex(data);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const layout = layoutLights(data, { heightAt });
  const marks = [...runwayMarkings(data, frames), ...taxiwayMarkings(data, frames, pavementIndex)];
  const surfaces = createSurfaces({ data, frames, marks, heightAt, frame, nodes, floods: layout.lights.filter((l) => l.kind === 'flood') });
  const toScene = (x, y, z) => [x, frame.sceneY(z, x, y), -y];
  const toMap = (p) => [p.x, -p.z, p.y + frame.base + curveDrop(p.x, -p.z)];
  const field = createLightField({ layout, toScene, toMap, nodes });
  const buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  const group = new Group();
  group.name = 'airport';
  group.add(surfaces.pavement, surfaces.paint, field.mesh);

  let last = { night: true, visible: [], levels: null };
  let updateMs = 0;
  return {
    group,
    layout,
    heightAt,
    /** Scene Y of the pavement's top (the runway's on a runway) at map (x, y). */
    groundY: (x, y) => frame.sceneY(heightAt(x, y) + (pavementIndex.classAt(x, y) ? LIFT[pavementIndex.classAt(x, y)] ?? 0 : 0), x, y),
    /**
     * Per frame. camera: the scene camera (its world position picks which flashers are in view); wallS: presentation
     * time in seconds (flashes keep it, never journey time); night: the night steps and the floodlights; reducedMotion:
     * flashers burn steady; visibilityM: the air's visibility (top step below 5 km, and the lights' extinction).
     * simMs is accepted for the session's convenience and not used: nothing at the airport follows journey time.
     */
    update({ camera = null, simMs = 0, wallS = 0, night = true, reducedMotion = false, visibilityM = 80000, levels = null } = {}) {
      void simMs;
      const a = typeof performance !== 'undefined' ? performance.now() : 0;
      if (camera) camera.updateMatrixWorld();
      const eye = camera ? toMap(camera.getWorldPosition ? camera.getWorldPosition(camera.position.clone()) : camera.position) : null;
      const r = field.update({ eye, wallS, night, reducedMotion, visibilityM, levels });
      surfaces.setNight(night);
      last = { night, visible: r.visible.slice(), levels: Array.from(r.levels), flashMax: r.flash.length ? Math.max(...r.flash) : 0 };
      updateMs = (typeof performance !== 'undefined' ? performance.now() : 0) - a;
    },
    /** Counts for the budget (section 9.1) and the debug hooks. */
    stats() {
      const s = surfaces.stats();
      const byKind = {};
      for (const l of layout.lights) byKind[l.kind] = (byKind[l.kind] || 0) + 1;
      return {
        lights: layout.lights.length,
        lightsByKind: byKind,
        lightsByRunway: layout.counts,
        triangles: { pavement: s.pavementTriangles, paint: s.paintTriangles, lights: layout.lights.length * 2, total: s.pavementTriangles + s.paintTriangles + layout.lights.length * 2 },
        drawCalls: 3,
        paintQuads: s.paintQuads,
        marks: marks.length,
        residuals: layout.residuals,
        flashGroupsInView: layout.groups.filter((g, i) => last.visible[i]).map((g) => g.id),
        night: last.night,
        flashMax: last.flashMax ?? 0,
        buildMs: +buildMs.toFixed(1),
        updateMs: +updateMs.toFixed(3),
        quality: level,
      };
    },
    dispose() {
      surfaces.dispose();
      field.dispose();
      group.removeFromParent();
    },
  };
}
