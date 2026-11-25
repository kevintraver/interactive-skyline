// The drawn airport's entry point (plan 03, section 7.10; F4.2 to F4.4): what the session adds in three lines, its
// draw calls and triangles against section 9.1, the light steps by day and night, and its ground.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { createFrame } from '../../../src/world/frame.js';
import { createEnvNodes } from '../../../src/env/nodes.js';
import { createAirport } from '../../../src/flight/airport/index.js';
import { runwayFrames } from '../../../src/flight/airport/geometry.js';
import { LIFT, cutOnGrid } from '../../../src/flight/airport/surfaces.js';
import cities from '../../../data/cities.json';

const data = JSON.parse(readFileSync(new URL('../../../public/data/lv/airport.json', import.meta.url), 'utf8'));
const frame = createFrame(cities.lv);
const nodes = createEnvNodes({ state: null });
const airport = createAirport({ data, frame, terrain: { surfaceAt: () => 640 }, nodes, quality: 'high' });
const { ends } = runwayFrames(data);

/** A camera on the approach to an end, `dist` m out on a 3 degree path, looking at the threshold. */
function cameraOnFinal(end, dist) {
  const e = ends[end];
  const [x, y] = e.toMap(-dist, 0);
  const z = e.thr[2] + 15 + dist * Math.tan((3 * Math.PI) / 180);
  const cam = new PerspectiveCamera(50, 16 / 9, 0.5, 100000);
  cam.position.set(x, frame.sceneY(z, x, y), -y);
  const [tx, ty] = e.toMap(300, 0);
  cam.lookAt(tx, frame.sceneY(e.thr[2], tx, ty), -ty);
  cam.updateMatrixWorld();
  return cam;
}

describe('createAirport', () => {
  it('is one group of three draws: pavement, paint and lights', () => {
    expect(airport.group.children.map((c) => c.name)).toEqual(['airport-pavement', 'airport-paint', 'airport-lights']);
    expect(airport.stats().drawCalls).toBe(3);
  });
  it('stays within section 9.1: about 6,000 light points, and pavement and paint under 120,000 triangles', () => {
    const s = airport.stats();
    expect(s.lights).toBeLessThan(6500);
    expect(s.triangles.pavement + s.triangles.paint).toBeLessThan(120000);
    expect(s.triangles.pavement).toBeGreaterThan(5000);
  });
  it('burns the runway lights at the middle step by night and leaves only the PAPI by day', () => {
    airport.update({ camera: cameraOnFinal('26L', 5000), wallS: 1, night: true });
    const night = airport.group.getObjectByName('airport-lights');
    expect(night).toBeDefined();
    const sn = airport.stats();
    expect(sn.night).toBe(true);
    expect(sn.flashGroupsInView).toContain('malsf-26L');
    expect(sn.flashGroupsInView).not.toContain('reil-19R');
    airport.update({ camera: cameraOnFinal('19R', 5000), wallS: 1, night: false });
    expect(airport.stats().flashGroupsInView).toContain('reil-19R');
  });
  it('puts its ground on the runway profile, under the runway pavement\'s top', () => {
    const e = ends['26L'];
    const [x, y] = e.toMap(800, 0);
    expect(airport.heightAt(x, y)).toBeCloseTo(e.zAt(800), 3);
    expect(airport.groundY(x, y)).toBeCloseTo(frame.sceneY(e.zAt(800) + LIFT.runway, x, y), 3);
  });
  it('refuses a file that is not an airport', () => {
    expect(() => createAirport({ data: { format: 'x' }, frame, nodes })).toThrow(/skyline-airport/);
  });
  it('cuts a polygon on the grid without losing area', () => {
    const ring = [0, 0, 100, 0, 100, 60, 50, 30, 0, 60];
    const area = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
    const cut = cutOnGrid(ring, 25);
    expect(cut.reduce((a, p) => a + area(p), 0)).toBeCloseTo(100 * 60 - 50 * 30, 6);
  });
});
