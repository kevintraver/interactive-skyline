// D5.6: obstruction lights by rule from the building list, attached to their building, a pure function of time.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { OBSTRUCTION_M, FLASH_FROM_M, FLASH_PER_MIN, FLASH_ON_S, STEADY_CD, FLASH_CD, RED, flashOn, flashPhase, hash32,
  roofPoints, towerLights, corridorLights, createObstructionPart } from '../../../src/drive/lights/obstruction.js';
import { encodeCell, decodeCell } from '../../../src/drive/corridor/format.js';
import { createEmitter } from '../../../src/app/events.js';

const BASE = 600;
const sq = (cx, cy, half) => [cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half];
/** A tower entry as src/city/buildings.js makes them. */
const tower = (id, h, half = 10, cx = 0, cy = 0, ground = 620) => ({
  data: { id, ground, v: [{ o: sq(cx, cy, 40), h: [], b: ground, t: ground + 12 }, { o: sq(cx, cy, half), h: [], b: ground, t: ground + h }] },
  mesh: { visible: true }, offset: new THREE.Vector3(),
});

describe('obstruction lights: the rule', () => {
  it('lights buildings above 61 m only, at the top of the highest volume; steady to 151 m, flashing above', () => {
    expect(towerLights(tower('a', 60), BASE)).toBe(null);
    const b = towerLights(tower('b', 100), BASE);
    expect(b.height).toBe(100);
    expect(b.flashing).toBe(false);
    expect(b.top).toBe(620 + 100 - BASE);
    expect(b.points).toEqual([[0, 0]]); // a 20 m roof: one lamp in its middle
    expect(towerLights(tower('c', 200), BASE).flashing).toBe(true);
    expect(OBSTRUCTION_M).toBe(61);
    expect(FLASH_FROM_M).toBe(151);
  });

  it('puts lamps at the corners of wide roofs, farthest apart', () => {
    expect(roofPoints(sq(0, 0, 10))).toHaveLength(1);
    const p2 = roofPoints([0, 0, 40, 0, 40, 5, 0, 5]); // 40 m long
    expect(p2).toHaveLength(2);
    expect(Math.hypot(p2[0][0] - p2[1][0], p2[0][1] - p2[1][1])).toBeGreaterThan(39);
    const p4 = roofPoints(sq(0, 0, 60)); // 120 m square
    expect(p4).toHaveLength(4);
    expect(new Set(p4.map(String)).size).toBe(4);
  });

  it('flashes at 30 a minute for 0.5 s, phase by a hash of the building: inside the 3 Hz comfort limit', () => {
    expect(FLASH_PER_MIN / 60).toBeLessThanOrEqual(3);
    expect(hash32('x')).toBe(hash32('x'));
    expect(flashPhase('a')).not.toBe(flashPhase('b'));
    for (const id of ['a', 'b', 'tower-42']) {
      let lit = 0;
      const N = 2000;
      for (let k = 0; k < N; k++) lit += flashOn(id, 1e12 + (k * 2000) / N); // one period
      expect(lit / N).toBeCloseTo(FLASH_ON_S / (60 / FLASH_PER_MIN), 2);
      // a pure function of time, and periodic
      expect(flashOn(id, 123456)).toBe(flashOn(id, 123456 + 2000 * 7));
    }
  });

  it('is red', () => {
    expect(RED[0]).toBeGreaterThan(20 * RED[1]);
    expect(0.2126 * RED[0] + 0.7152 * RED[1] + 0.0722 * RED[2]).toBeCloseTo(1, 6);
  });

  it('lights the corridor tall set on its drawn ground', () => {
    const cell = decodeCell(encodeCell({ origin: [0, 0], wide: true, buildings: [
      { rings: [[[1000, 2000], [1020, 2000], [1020, 2020], [1000, 2020]]], height: 119, type: 0, rung: 0 },
      { rings: [[[5000, 2000], [5020, 2000], [5020, 2020], [5000, 2020]]], height: 40, type: 0, rung: 0 },
    ] }));
    const out = corridorLights(cell, () => 700, BASE);
    expect(out).toHaveLength(1);
    expect(out[0].height).toBeCloseTo(119, 0);
    expect(out[0].top).toBeGreaterThan(700 + 118 - BASE - 1);
    expect(out[0].top).toBeLessThan(700 + 120 - BASE);
  });
});

describe('obstruction part: attached to its building', () => {
  async function make(tall) {
    const events = createEmitter();
    const group = new THREE.Group();
    const ctx = {
      app: { tall, events, renderer: { getDrawingBufferSize: (v) => v.set(1280, 720) }, camera: new THREE.PerspectiveCamera(), invalidate() {} },
      env: { lighting: { units: { nit: 1 } }, weather: { state: () => ({ visibilityM: 80000 }) } },
      base: BASE, group, optional: async () => null, get: async () => { throw new Error('none'); }, terrain: { heightAt: () => 620 },
    };
    const part = await createObstructionPart(ctx);
    return { part, events, group };
  }

  it('is off by day and on from dusk with the look', async () => {
    const { part, group } = await make([tower('s', 300)]);
    const mesh = group.children[0];
    part.setLook({ lights: 0 });
    expect(mesh.visible).toBe(false);
    part.setLook({ lights: 0.3 });
    expect(mesh.visible).toBe(true);
  });

  it('removes a hidden building\'s lights and moves a moved building\'s lights with it', async () => {
    const a = tower('a', 300), b = tower('b', 100, 10, 500, 0);
    const { part, events } = await make([a, b]);
    part.setLook({ lights: 1 });
    expect(part.lamps()).toHaveLength(2);
    a.mesh.visible = false;
    events.emit('buildings:changed', {});
    expect(part.lamps()).toHaveLength(1);
    expect(part.lamps()[0].x).toBe(500);
    b.offset.set(30, 2, -40); // dragged 30 m east, 40 m north (scene z is -north), the ground 2 m higher
    events.emit('buildings:changed', {});
    const [l] = part.lamps();
    expect(l.x).toBeCloseTo(530, 6);
    expect(l.z).toBeCloseTo(-40, 6);
    expect(l.y).toBeCloseTo(620 + 100 - BASE + 2 + 0.6, 4);
    expect(l.intensity).toBe(STEADY_CD);
    a.mesh.visible = true;
    events.emit('buildings:changed', {});
    const tall = part.lamps().find((x) => Math.abs(x.x) < 1);
    expect([0, FLASH_CD]).toContain(tall.intensity);
  });

  it('flashes as a pure function of simulation time', async () => {
    const { part } = await make([tower('s', 300)]);
    part.setLook({ lights: 1 });
    const at = (ms) => { part.update({ simMs: ms }); part.beforeRender(); return part.lamps()[0].intensity; };
    for (const ms of [0, 250, 700, 1300, 1900, 61000]) expect(at(ms)).toBe(FLASH_CD * flashOn('s', ms));
  });
});

describe('obstruction lights on landmark models', () => {
  it('puts one lamp at a model\'s highest point when the model is lower than its footprint data', () => {
    const e = tower('m', 200);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 20, 0, 5, 150, -7, 10, 30, 0], 3)); // tip at map (5, 7)
    e.mesh.geometry = g;
    const l = towerLights(e, BASE);
    expect(l.points).toEqual([[5, 7]]);
    expect(l.top).toBe(150);
    // a mesh as tall as its data keeps the roof rule
    const f = tower('f', 200);
    const h = new THREE.BufferGeometry();
    h.setAttribute('position', new THREE.Float32BufferAttribute([0, 620 + 200 - BASE, 0], 3));
    f.mesh.geometry = h;
    expect(towerLights(f, BASE).top).toBe(620 + 200 - BASE);
  });
});

describe('obstruction lights without edit events', () => {
  it('still follows a hide and a move, by checking the towers before each draw', async () => {
    const a = tower('a', 100);
    const ctx = {
      app: { tall: [a], renderer: { getDrawingBufferSize: (v) => v.set(1280, 720) }, camera: new THREE.PerspectiveCamera() },
      env: { lighting: { units: { nit: 1 } }, weather: { state: () => ({ visibilityM: 80000 }) } },
      base: BASE, group: new THREE.Group(), optional: async () => null, get: async () => { throw new Error('none'); }, terrain: { heightAt: () => 620 },
    };
    const part = await createObstructionPart(ctx);
    part.setLook({ lights: 1 });
    part.beforeRender();
    expect(part.stats().lamps).toBe(1);
    a.mesh.visible = false;
    part.beforeRender();
    expect(part.stats().lamps).toBe(0);
    a.mesh.visible = true; a.offset.set(10, 0, 0);
    part.beforeRender();
    expect(part.lamps()[0].x).toBeCloseTo(10, 6);
  });
});
