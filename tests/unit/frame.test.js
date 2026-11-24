import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { EARTH_R, createFrame, curveDrop, localUp, levelQuaternion } from '../../src/world/frame.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const fixture = JSON.parse(read('../fixtures/frame.json'));
const frame = createFrame({ origin: fixture.origin, base: fixture.base });
// metres per degree, near enough to turn an angular error into a distance
const metres = (p, lat, lon) => Math.hypot((lat - p.lat) * 111320, (lon - p.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180));
const tolerance = (p) => (p.dist <= 80000 ? 0.001 : 0.1);

/** Minimal vector with the two methods localUp needs. */
const vec = () => ({
  x: 0, y: 0, z: 0,
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; },
  normalize() { const l = Math.hypot(this.x, this.y, this.z); this.x /= l; this.y /= l; this.z /= l; return this; },
});

describe('frame', () => {
  it('has enough reference points, out to 400 km', () => {
    expect(fixture.points.length).toBeGreaterThanOrEqual(24);
    expect(Math.max(...fixture.points.map((p) => p.dist))).toBeGreaterThanOrEqual(399000);
    for (const name of ['Primm', 'Jean', 'Apex', 'Hoover Dam', 'Mount Whitney']) {
      expect(fixture.points.some((p) => p.name === name)).toBe(true);
    }
  });

  it.each(fixture.points.map((p) => [p.name, p]))('projects %s as pyproj does', (_, p) => {
    const { x, y } = frame.toLocal(p.lat, p.lon);
    expect(Math.hypot(x - p.x, y - p.y)).toBeLessThan(tolerance(p));
  });

  it.each(fixture.points.map((p) => [p.name, p]))('unprojects %s as pyproj does', (_, p) => {
    const { lat, lon } = frame.toGeodetic(p.x, p.y);
    expect(metres(p, lat, lon)).toBeLessThan(tolerance(p));
  });

  it('puts the origin at 0, 0 and keeps base', () => {
    const o = frame.toLocal(fixture.origin.lat, fixture.origin.lon);
    expect(Math.abs(o.x) + Math.abs(o.y)).toBeLessThan(1e-9);
    expect(frame.base).toBe(620);
    expect(frame.sceneY(1000, 3000, -4000)).toBe(1000 - 620 - curveDrop(3000, -4000));
  });

  it('leans the true vertical 0.46 degrees at Primm', () => {
    const p = fixture.points.find((q) => q.name === 'Primm');
    const up = localUp(p.x, -p.y, vec());
    const lean = (Math.acos(up.y) * 180) / Math.PI;
    expect(Math.abs(lean - 0.46)).toBeLessThanOrEqual(0.01);
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 12);
  });

  it('uses the EARTH_R and curveDrop of the map ground (src/core/earth.js), bit for bit', async () => {
    const earth = await import('../../src/core/earth.js');
    expect(Object.is(EARTH_R, earth.EFFECTIVE_RADIUS)).toBe(true);
    expect(curveDrop).toBe(earth.curveDrop);
    // and the map's ground (src/city/terrain.js) is lowered with that same function
    expect(read('../../src/city/terrain.js')).toMatch(/import \{[^}]*\bcurveDrop\b[^}]*\} from '\.\.\/core\/earth\.js'/);
  });
});

// Plan 03, section 5.5: the rotation from the app axes to the level frame at a map position, so an aircraft 300 km out
// is levelled to the curved datum and not to the XZ plane.
describe('levelQuaternion', () => {
  const at = (x, z) => {
    const q = levelQuaternion(x, z, new Quaternion());
    return { q, up: new Vector3(0, 1, 0).applyQuaternion(q), north: new Vector3(0, 0, -1).applyQuaternion(q), east: new Vector3(1, 0, 0).applyQuaternion(q) };
  };
  it('is the identity at the origin', () => {
    const { q } = at(0, 0);
    expect(Math.abs(q.w)).toBeCloseTo(1, 12);
  });
  it.each([[250000, 0], [0, -250000], [-180000, 120000], [3000, -4000], [369000, 0]])('takes +y to localUp at (%d, %d)', (x, z) => {
    const { up } = at(x, z);
    const want = localUp(x, z, new Vector3());
    expect(up.distanceTo(want)).toBeLessThan(1e-12);
  });
  it('leans 1.93 degrees 250 km east (7/6 radius), toward the east', () => {
    const { up } = at(250000, 0);
    expect((Math.acos(up.y) * 180) / Math.PI).toBeCloseTo(1.926, 3);
    expect(up.x).toBeGreaterThan(0);
  });
  it.each([[250000, 0], [-180000, 120000], [90000, -300000]])('keeps level north in the vertical plane of -z at (%d, %d)', (x, z) => {
    const { up, north, east } = at(x, z);
    // north is level, and lies in the plane spanned by the local up and the scene's -z
    expect(Math.abs(north.dot(up))).toBeLessThan(1e-12);
    const planeNormal = new Vector3().crossVectors(up, new Vector3(0, 0, -1)).normalize();
    expect(Math.abs(north.dot(planeNormal))).toBeLessThan(1e-12);
    expect(north.z).toBeLessThan(0);
    // and the frame stays right-handed: east = north x up
    expect(east.distanceTo(new Vector3().crossVectors(north, up))).toBeLessThan(1e-12);
  });
  it('writes into `out` with set() and returns it', () => {
    const out = new Quaternion();
    expect(levelQuaternion(1000, 2000, out)).toBe(out);
  });
});
