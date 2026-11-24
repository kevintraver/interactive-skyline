// D5.4 and D5.5: the pool map (poolTile.js, pools.js), switching across the lamp product, and the surface-light
// helper (surfaceLight.js) that adds pools (and next headlights) to other features' materials.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { createLampTypes, illuminanceAt, poolAt } from '../../../src/drive/lights/lamps.js';
import { poolTile, toHalf, tileToHalfRgba, poolChannel, POOL_TILE_M } from '../../../src/drive/lights/poolTile.js';
import { poolWindow, RING } from '../../../src/drive/lights/pools.js';
import { switchThresholdLux, sliceLit, litShare, lampHash } from '../../../src/drive/lights/switching.js';
import { ambientLux } from '../../../src/drive/env.js';
import { decodeLampPack } from '../../../src/drive/lights/pack.js';
import { addSurfaceTerm, removeSurfaceTerm, surfaceTerms } from '../../../src/drive/lights/surfaceLight.js';
import { lightAtNight } from '../../../src/night.js';
import { active } from '../../../src/render/active.js';
import * as legacyMaterials from '../../../src/render/legacy/materials.js';

active.legacy = legacyMaterials; // the drive's GLSL materials are the classic renderer's, until they are ported (plan 02)

const ROOT = new URL('../../../', import.meta.url).pathname;
const typesJson = JSON.parse(readFileSync(`${ROOT}data/lamp_types.json`, 'utf8'));
const types = createLampTypes(typesJson);

/** A product with the given lamps, one 1024 m cell grid around the origin. */
function packOf(lamps) {
  const cell = 1024, x0 = -4096, y0 = -4096, nx = 8, ny = 8;
  const cellOf = (l) => Math.floor((l.y - y0) / cell) * nx + Math.floor((l.x - x0) / cell);
  const sorted = [...lamps].sort((a, b) => cellOf(a) - cellOf(b));
  const cellStart = new Uint32Array(nx * ny + 1);
  for (const l of sorted) cellStart[cellOf(l) + 1]++;
  for (let c = 0; c < nx * ny; c++) cellStart[c + 1] += cellStart[c];
  const f = (k, T = Float64Array) => T.from(sorted, (l) => l[k] ?? 0);
  return { count: sorted.length, cell, x0, y0, nx, ny, cellStart, x: f('x'), y: f('y'), mount: f('mount', Float32Array), type: f('type', Uint8Array),
    lumens: f('lumens', Float32Array), aim: Float32Array.from(sorted, (l) => l.aim ?? NaN), enclosed: new Uint8Array(sorted.length) };
}

describe('the pool map', () => {
  const led = types.byKey.get('led_street');
  const lamp = { x: 101, y: 57, mount: 9, lumens: 10000, type: led.id };
  const pack = packOf([lamp]);
  const tile = poolTile(pack, types, 0, 0);
  const at = (x, y) => tile.channels.reduce((a, c) => a + poolAt(c, { x0: tile.x0, y0: tile.y0, cell: tile.cell, nx: tile.n, ny: tile.n }, x, y), 0);

  it('under one 9 m, 10,000 lm lamp is within 10% of the analytic value on axis and 10 m out', () => {
    for (const [dx, dy] of [[0, 0], [10, 0], [0, -10], [7.07, 7.07]]) {
      const want = illuminanceAt(led, 10000, 9, dx, dy, null);
      expect(Math.abs(at(lamp.x + dx, lamp.y + dy) / want - 1)).toBeLessThan(0.1);
    }
  });

  it('puts the lamp in its class and slice channel only', () => {
    const ch = poolChannel(false, 0);
    expect(ch).toBe(lampHash(0) < 0.5 ? 2 : 3);
    tile.channels.forEach((c, i) => { const sum = c.reduce((a, b) => a + b, 0); if (i === ch) expect(sum).toBeGreaterThan(0); else expect(sum).toBe(0); });
  });

  it('is a pure function of the tile, and neighbouring tiles agree across their edge', () => {
    const edge = packOf([{ ...lamp, x: POOL_TILE_M - 3 }]);
    const a = poolTile(edge, types, 0, 0), b = poolTile(edge, types, 1, 0), again = poolTile(edge, types, 0, 0);
    expect(again.channels.every((c, i) => c.every((v, j) => v === a.channels[i][j]))).toBe(true);
    const sum = (t) => t.channels.reduce((s, c) => s + c.reduce((p, q) => p + q, 0), 0);
    expect(sum(b)).toBeGreaterThan(0); // the light crosses into the next tile
    // the last column of tile 0 and the first of tile 1 straddle the edge: near-equal values in the lamp's row
    const row = Math.floor((lamp.y - a.y0) / a.cell), n = a.n;
    const ch = a.channels.findIndex((c) => c.some((v) => v > 0));
    const l = a.channels[ch][row * n + n - 1], r = b.channels[ch][row * n];
    expect(Math.abs(l - r) / Math.max(l, r)).toBeLessThan(0.25);
  });

  it('half floats are IEEE binary16', () => {
    for (const v of [0, 1, 0.5, 2.75, 65504, 1e-3, 6.1e-5, 3e-6, 1e-9, 70000, 12.3456, -2.5]) {
      expect(Math.abs(toHalf(v) - THREE.DataUtils.toHalfFloat(v))).toBeLessThanOrEqual(1); // rounding (ours) or truncation (three's): one unit in the last place
    }
    const rgba = tileToHalfRgba(tile);
    expect(rgba.length).toBe(tile.n * tile.n * 4);
  });

  it('the window is a function of where the car is', () => {
    const w = poolWindow(1000, -300);
    expect(poolWindow(1000 + 200, -300 - 200)).toEqual(w);
    const car = [1000, -300];
    expect(car[0] - w.ti0 * POOL_TILE_M).toBeGreaterThanOrEqual(RING * POOL_TILE_M / 2 - POOL_TILE_M / 2);
    expect((w.ti0 + RING) * POOL_TILE_M - car[0]).toBeGreaterThanOrEqual(RING * POOL_TILE_M / 2 - POOL_TILE_M / 2);
  });
});

describe('switching across the lamps', () => {
  const served = `${ROOT}public/data/lv/lamps-drive.json`;
  const count = existsSync(served) ? JSON.parse(readFileSync(served, 'utf8')).count : 50000;
  // the shader's rule, lamp by lamp: lit while the ambient illuminance is below the lamp's threshold
  const share = (el) => { const a = ambientLux(el); let lit = 0; for (let i = 0; i < count; i++) if (a < switchThresholdLux(i)) lit++; return lit / count; };

  it('the lit share at three sun elevations', () => {
    // the photocells (switching.js, 16 lux middle) bring most lamps on between -4 and -6 degrees
    const s0 = share(0), s45 = share(-4.5), s6 = share(-6);
    expect(s0).toBeLessThan(0.05);
    expect(s45).toBeGreaterThan(0.2);
    expect(s45).toBeLessThan(0.8);
    expect(s6).toBeGreaterThan(0.95);
    expect(Math.abs(s45 - litShare(ambientLux(-4.5)))).toBeLessThan(0.01);
  });

  it('the pools\' two slices together light the same share as the lamps', () => {
    for (const el of [1, -1, -2, -3, -4, -6]) {
      const a = ambientLux(el);
      const both = (sliceLit(a, 0, 0.5).share + sliceLit(a, 0.5, 1).share) / 2;
      expect(both).toBeCloseTo(litShare(a), 6);
    }
  });
});

describe('the surface-light helper', () => {
  const shaderOf = (name) => ({ uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib[name].uniforms), vertexShader: THREE.ShaderLib[name].vertexShader, fragmentShader: THREE.ShaderLib[name].fragmentShader });
  const term = (id, body = 'slE += vec3(1.0);') => ({ id, body, head: `uniform float u_${id};`, uniforms: { [`u_${id}`]: { value: 1 } }, key: 'k1' });

  it('chains onto a material\'s own hook and key, and takes itself out again', () => {
    const m = new THREE.MeshLambertMaterial();
    const own = (shader) => { shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n// OWN'); };
    m.onBeforeCompile = own;
    m.customProgramCacheKey = () => 'own-key';
    const remove = addSurfaceTerm(m, term('pools'));
    addSurfaceTerm(m, term('headlights', 'slL += vec3(0.5);'));
    expect(surfaceTerms(m)).toEqual(['pools', 'headlights']);
    const sh = shaderOf('lambert');
    m.onBeforeCompile(sh, null);
    expect(sh.vertexShader).toContain('// OWN');
    expect(sh.vertexShader).toContain('slWorldPos = ( modelMatrix * slW ).xyz;');
    expect(sh.fragmentShader).toContain('uniform float u_pools;');
    expect(sh.fragmentShader).toContain('slL += vec3(0.5);');
    expect(sh.fragmentShader.indexOf('slE += vec3(1.0);')).toBeGreaterThan(sh.fragmentShader.indexOf('#include <lights_fragment_end>'));
    expect(sh.uniforms.u_pools.value).toBe(1);
    expect(m.customProgramCacheKey()).toBe('own-key|sl:pools@k1,headlights@k1');
    remove();
    expect(surfaceTerms(m)).toEqual(['headlights']);
    removeSurfaceTerm(m, 'headlights');
    expect(m.onBeforeCompile).toBe(own);
    expect(m.customProgramCacheKey()).toBe('own-key');
  });

  it('works over night.js\'s lit windows and over a material with three\'s default key', () => {
    const lit = lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true }));
    addSurfaceTerm(lit, term('pools'));
    const sh = shaderOf('lambert');
    lit.onBeforeCompile(sh, null);
    expect(sh.fragmentShader).toContain('nightGlow()');
    expect(sh.fragmentShader).toContain('reflectedLight.directDiffuse += slE * BRDF_Lambert( slAlbedo ) + slL;');
    expect(lit.customProgramCacheKey()).toMatch(/^night-v\d+\|sl:pools@k1$/);

    const plain = new THREE.MeshLambertMaterial();
    const before = plain.customProgramCacheKey();
    addSurfaceTerm(plain, term('pools'));
    expect(plain.customProgramCacheKey()).toBe(`${before}|sl:pools@k1`);
    removeSurfaceTerm(plain, 'pools');
    expect(plain.customProgramCacheKey()).toBe(before);
    expect(Object.prototype.hasOwnProperty.call(plain, 'customProgramCacheKey')).toBe(false);
  });
});
