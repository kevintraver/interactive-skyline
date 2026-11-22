import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EARTH_R, createFrame, curveDrop, localUp } from '../../src/world/frame.js';

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

  it('uses the same EARTH_R and curveDrop as main.js, bit for bit', () => {
    const src = read('../../src/main.js');
    const r = src.match(/const EARTH_R = ([^;]+);/)[1];
    const drop = src.match(/const curveDrop = ([^;]+);/)[1];
    const mainR = new Function(`return ${r};`)();
    const mainDrop = new Function('EARTH_R', `return ${drop};`)(mainR);
    expect(Object.is(EARTH_R, mainR)).toBe(true);
    for (let k = 0; k < 2000; k++) {
      const x = (Math.random() - 0.5) * 2e5, z = (Math.random() - 0.5) * 2e5;
      expect(Object.is(curveDrop(x, z), mainDrop(x, z))).toBe(true);
    }
  });
});
