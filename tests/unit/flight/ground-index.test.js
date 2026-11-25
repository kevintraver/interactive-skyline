// The night ground's entry point (src/flight/ground/index.js): loading when the Sun is low, the map's ground dark while
// flying (no orange street glow at the airport) and given back after, lamps switching through civil twilight, the air
// from the eye's height, the drive's traffic ribbons and obstruction lights running without a drive, and the same
// frame for the same moment.
import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Mesh, BufferGeometry, PerspectiveCamera, Vector3 } from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { createNightGround, lampsLitAt, LIT_BELOW_LUX } from '../../../src/flight/ground/index.js';
import { createFrame, curveDrop } from '../../../src/world/frame.js';
import { ambientLux } from '../../../src/drive/env.js';
import cities from '../../../data/cities.json';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const city = { ...cities.lv, id: 'lv' };
const BASE = city.base;
const GROUND = 640;
const fetched = [];
function fetchFile(name) {
  fetched.push(name);
  const u = new URL(name, DATA);
  if (!existsSync(u)) return Promise.resolve({ ok: false, status: 404, json: async () => { throw new Error('404'); }, arrayBuffer: async () => new ArrayBuffer(0) });
  const b = readFileSync(u);
  return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(b.toString('utf8')), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
}
const renderer = { getDrawingBufferSize: (v) => v.set(1280, 800) };

function setup({ sunAltDeg = -30 } = {}) {
  const fe = { city, frame: createFrame(city), nodes: null, state: { sun: { altDeg: sunAltDeg } }, quality: { level: 'high' }, events: null, invalidate: () => {} };
  const region = { heightAt: () => GROUND, grid: () => null };
  const mat = () => { const m = new MeshLambertNodeMaterial(); m.emissive.set(0xffa858); m.emissiveIntensity = 0.26; return m; };
  const ground = { near: new Mesh(new BufferGeometry(), mat()), far: new Mesh(new BufferGeometry(), mat()) };
  const night = createNightGround({ fe, region, ground, data: '/data/lv', renderer, fetchFile, level: 'high' });
  return { fe, region, ground, night };
}
function camera({ x, y, alt, look }) {
  const c = new PerspectiveCamera(46.8, 1280 / 800, 1, 500000);
  c.position.set(x, alt - BASE - curveDrop(x, y), -y);
  c.lookAt(new Vector3(look[0], GROUND - BASE, -look[1]));
  c.updateMatrixWorld();
  return c;
}
const NIGHT_MS = Date.UTC(2026, 2, 10, 4, 0); // 9 pm in Las Vegas, 10 March 2026 (lv-19-night)

describe('switching with the Sun', () => {
  it('lights the lamps through civil twilight: few at sunset, nearly all by -6 degrees, as the drive does', () => {
    expect(lampsLitAt(10)).toBe(0 + lampsLitAt(10)); // a number
    expect(lampsLitAt(10)).toBeLessThan(1e-3);
    expect(lampsLitAt(0)).toBeLessThan(0.05);
    expect(lampsLitAt(-6)).toBeGreaterThan(0.95);
    let prev = 0;
    for (let el = 6; el >= -12; el -= 0.5) { const v = lampsLitAt(el); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    expect(ambientLux(-1)).toBeLessThan(LIT_BELOW_LUX);
  });

  it('fetches nothing by day, and the lamps\' files once the Sun is low enough for any lamp', async () => {
    fetched.length = 0;
    const { night, fe } = setup({ sunAltDeg: 30 });
    const cam = camera({ x: 20000, y: -20000, alt: 3000, look: [0, 0] });
    night.update({ camera: cam, simMs: NIGHT_MS });
    await night.whenSettled();
    expect(fetched).toEqual([]);
    expect(night.stats().drawn).toBe(0);
    fe.state.sun.altDeg = -10;
    night.show(true);
    night.update({ camera: cam, simMs: NIGHT_MS });
    await night.whenSettled();
    expect(fetched).toContain('lamps-drive.json');
    expect(fetched).toContain('lights-region.json');
    night.update({ camera: cam, simMs: NIGHT_MS + 1000 });
    expect(night.stats().drawn).toBeGreaterThan(1000);
    night.dispose();
  });
});

describe('the ground between the lamps', () => {
  it('switches the map\'s street glow off while flying (the airport\'s ground is not orange) and gives it back after', () => {
    const { night, ground } = setup();
    const before = [ground.near.material.emissiveNode, ground.far.material.emissiveNode];
    night.show(true);
    for (const m of [ground.near.material, ground.far.material]) {
      expect(m.emissiveNode).not.toBe(null);
      expect(m.emissiveNode.isNode).toBe(true);
      // a constant black: the emissive colour and intensity the map's look writes each frame are no longer read
      const v = m.emissiveNode.value;
      expect([v.x, v.y, v.z]).toEqual([0, 0, 0]);
    }
    expect(night.stats().mapGroundDark).toBe(2);
    night.show(false);
    expect([ground.near.material.emissiveNode, ground.far.material.emissiveNode]).toEqual(before);
    expect(night.stats().mapGroundDark).toBe(0);
    night.dispose();
  });
});

describe('the air and the airport', () => {
  it('lets light carry further the higher the eye, and gives the airport the same air as a visibility', async () => {
    const { night } = setup();
    night.update({ camera: camera({ x: 0, y: -8000, alt: GROUND + 10, look: [0, 0] }), simMs: NIGHT_MS, visibilityM: 40000 });
    const low = night.airportVisibilityM;
    expect(Math.abs(low / 40000 - 1)).toBeLessThan(0.01); // on the ground: the weather's own visibility
    night.update({ camera: camera({ x: 0, y: -8000, alt: 9000, look: [0, 0] }), simMs: NIGHT_MS, visibilityM: 40000 });
    expect(night.airportVisibilityM).toBeGreaterThan(2 * low);
    await night.whenSettled();
    night.dispose();
  });
});

describe('the drive\'s valley-wide parts, without a drive', () => {
  it('runs the traffic ribbons and the obstruction lights at night', async () => {
    const { night } = setup();
    night.show(true);
    const cam = camera({ x: 15000, y: -15000, alt: 2000, look: [0, 0] });
    night.update({ camera: cam, simMs: NIGHT_MS });
    await night.whenSettled();
    night.update({ camera: cam, simMs: NIGHT_MS + 1000 });
    const s = night.stats();
    expect(s.ribbons?.visible).toBe(true);
    expect(s.ribbons.triangles).toBeGreaterThan(1000);
    expect(s.obstruction?.on).toBe(true);
    expect(s.obstruction.lamps).toBeGreaterThan(0); // the corridor's tall buildings (no towers without a scene here)
    expect(s.draws).toBe(3);
    night.dispose();
  });
});

describe('a frame is a function of the moment', () => {
  it('draws the same lamps with the same light for the same camera and clock', async () => {
    const lists = [];
    for (let k = 0; k < 2; k++) {
      const { night } = setup();
      night.show(true);
      const cam = camera({ x: 18000, y: -22000, alt: 2500, look: [0, 0] });
      night.update({ camera: cam, simMs: NIGHT_MS });
      await night.whenSettled();
      night.update({ camera: cam, simMs: NIGHT_MS });
      const layer = night.group.children.find((c) => c.name === 'flight-lamps');
      const n = night.stats().drawn;
      lists.push({ n, list: Array.from(layer.geometry.getAttribute('spriteIndex').array.slice(0, 2 * n)), amb: night.light.ambientLux });
      night.dispose();
    }
    expect(lists[0].n).toBeGreaterThan(0);
    expect(lists[1]).toEqual(lists[0]);
  });
});
