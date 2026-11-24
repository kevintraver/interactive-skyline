// The screens and billboards on plan 01's renderer (plan 02, third stretch): the LED mirror held to the TSL of plan
// 01's building material as led.test.js holds it to the GLSL; the light levels in physical units; the node face's
// rules held to the JavaScript schedules; the node light terms and the node path of the screens part.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { ledScale, ledLevel, ledMean, ledSamples } from '../../../src/drive/screens/led.js';
import { ledCdM2, PHOTOMETRY } from '../../../src/render/photometry.js';
import {
  digitalCdM2, digitalLevel, faceLevels, staticLevel, NIGHT_NITS, DAY_NITS, NIGHT_LUX, DAY_LUX, STATIC_FACE_LUX, VINYL, PLAIN,
  FLOOD_LENS_CDM2,
} from '../../../src/drive/screens/digital.js';
import { imageAt } from '../../../src/drive/roadside/billboardsImages.js';
import { VINYL as VINYL_FACE, PLAIN as PLAIN_FACE } from '../../../src/drive/roadside/billboardsFace.js';
import { faceMaterial, lampMaterial } from '../../../src/drive/roadside/billboardsFace.node.js';
import { createSphereLight, createGlowLight, GLOW_MAX } from '../../../src/drive/screens/light.node.js';
import { surfaceTerms } from '../../../src/drive/lights/surfaceLight.node.js';
import { createEmitter } from '../../../src/app/events.js';
import { createScreensPart, SPHERE_ID } from '../../../src/drive/screens/index.js';
import { contentSeconds } from '../../../src/drive/screens/clock.js';
import { switchOn } from '../../../src/render/materials/shared.js';
import { DETAIL } from '../../../src/drive/roadside/billboards.js';

const ROOT = path.resolve(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('the LED mirror held to plan 01\'s TSL (src/render/materials/buildingMaterial.js)', () => {
  const tsl = read('src/render/materials/buildingMaterial.js');
  it('copies the node formula (change both together)', () => {
    for (const line of [
      'const p = fract(p0.mul(vec2(123.34, 456.21)));', 'const q = p.add(dot(p, p.add(45.32)));', 'return fract(q.x.mul(q.y));',
      'const ledHash = (p) => nightHash(p.xy.add(vec2(p.z.mul(7.13), p.z.mul(3.71))));',
      'const f = f0.mul(f0).mul(f0.mul(-2).add(3));',
      'const a = mix(h(0, 0, 0), h(1, 0, 0), f.x), b = mix(h(0, 1, 0), h(1, 1, 0), f.x);',
      'const c = mix(h(0, 0, 1), h(1, 0, 1), f.x), d = mix(h(0, 1, 1), h(1, 1, 1), f.x);',
      'return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);',
      'const pos = varying(positionGeometry, \'vNightPos\');',
      'const noise = ledNoise(pos.mul(0.022).add(vec3(0, t.mul(-0.11), t.mul(0.05))));',
      'const band = pos.y.mul(0.018).add(dot(pos.xz, vec2(0.009, 0.006))).sub(t.mul(0.05)).add(noise.mul(0.7));',
      'const ledColor = cos(band.add(vec3(0, 0.33, 0.67)).mul(6.2832)).mul(0.45).add(0.55);',
      'const pulse = sin(band.mul(2).sub(t.mul(0.07)).mul(6.2832)).mul(0.35).add(0.65);',
      'const ledPattern = ledColor.mul(pulse).mul(led);',
      'const ledLight = ledPattern.mul(mix(0.05, 1.2, night));',
      'const ledPhys = ledPattern.mul(float(PHOTOMETRY.ledNightDim - 1).mul(switchOn.signs).add(1).mul(PHOTOMETRY.ledCdM2)).mul(artificial);',
    ]) expect(tsl, line).toContain(line);
  });

  it('scales the pattern as each renderer and display draws it', () => {
    expect(ledScale({ display: 'legacy', night: 0.7 })).toBeCloseTo(ledLevel(0.7), 12);
    expect(ledScale({ display: 'classic', night: 0.7, nit: 0.1 })).toBeCloseTo(ledLevel(0.7) / 0.1, 9);
    // the physical look: plan 01's ledCdM2, 1,200 cd/m2 by day and 3 % of it at night
    expect(ledScale({ display: 'physical', signs: 0 })).toBe(PHOTOMETRY.ledCdM2);
    expect(ledScale({ display: 'physical', signs: 1 })).toBeCloseTo(PHOTOMETRY.ledCdM2 * PHOTOMETRY.ledNightDim, 9);
    expect(ledScale({ display: 'physical', signs: 0.4 })).toBeCloseTo(ledCdM2(0.4), 9);
  });
});

describe('face levels in physical units (screens/digital.js faceLevels)', () => {
  it('a digital face\'s white is 300 cd/m2 at night and 6,000 by day (section 7.9), geometric between', () => {
    expect(digitalCdM2(0.01)).toBeCloseTo(NIGHT_NITS, 9);
    expect(digitalCdM2(NIGHT_LUX)).toBeCloseTo(300, 9);
    expect(digitalCdM2(DAY_LUX)).toBeCloseTo(6000, 9);
    expect(digitalCdM2(100000)).toBeCloseTo(DAY_NITS, 9);
    const mid = Math.sqrt(NIGHT_LUX * DAY_LUX); // half way in the log: the smoothstep's middle
    expect(digitalCdM2(mid)).toBeCloseTo(Math.sqrt(300 * 6000), 6);
    let last = 0;
    for (let lx = 0.001; lx < 1e5; lx *= 1.7) { const v = digitalCdM2(lx); expect(v).toBeGreaterThanOrEqual(last); last = v; }
  });

  it('a static face is vinyl under its floodlights: VINYL x 400 lx / pi, off with the lamps', () => {
    const on = faceLevels({ display: 'physical', ambientLux: 0.1, lampsOn: 1 });
    expect(on.static).toBeCloseTo((VINYL * STATIC_FACE_LUX) / Math.PI, 9);
    expect(on.static).toBeCloseTo(104.4, 1);
    expect(on.lamp).toBe(FLOOD_LENS_CDM2);
    expect(faceLevels({ display: 'physical', ambientLux: 0.1, lampsOn: 0 }).static).toBe(0);
    expect(on.digital).toBeCloseTo(300, 9);
  });

  it('the classic renderer keeps its levels, and the classic display draws them through LIGHTING_UNITS', () => {
    const units = { nit: 0.1 };
    for (const [lx, on] of [[0.05, 1], [30, 0.6], [20000, 0]]) {
      const legacy = faceLevels({ display: 'legacy', ambientLux: lx, lampsOn: on, units });
      expect(legacy.digital).toBe(digitalLevel(lx, units));
      expect(legacy.static).toBe(staticLevel(on, units));
      expect(legacy.lamp).toBe(1.5 * on);
      const classic = faceLevels({ display: 'classic', ambientLux: lx, lampsOn: on, units });
      for (const k of ['digital', 'static', 'lamp']) expect(classic[k] * units.nit).toBeCloseTo(legacy[k], 12);
    }
  });

  it('the face constants live in digital.js and billboardsFace.js re-exports them', () => {
    expect(VINYL_FACE).toBe(VINYL);
    expect(PLAIN_FACE).toBe(PLAIN);
  });
});

describe('the node face (roadside/billboardsFace.node.js)', () => {
  const src = read('src/drive/roadside/billboardsFace.node.js');
  it('uses the hash and the timing of the JavaScript schedules', () => {
    expect(src).toContain('x0.bitXor(x0.shiftRight(uint(16)))');
    expect(src).toContain('x.mul(uint(0x7feb352d))');
    expect(src).toContain('x.bitXor(x.shiftRight(uint(15)))');
    expect(src).toContain('x.mul(uint(0x846ca68b))');
    expect(src).toContain('seed.bitXor(uint(k).mul(uint(0x9e3779b9)))');
    expect(src).toContain('.mod(uint(DESIGNS))');
    expect(src).toMatch(/import \{ FADE_S, HOLD_S, PLAIN, VINYL \} from '\.\.\/screens\/digital\.js';/);
  });

  it('picks the image of hold k as imageAt does, from hold -1 on, with no negative operand of %', () => {
    expect(src).toContain('const i = int(ad.z.add(0.5)).add(k.add(n).mul(int(ad.w.add(0.5)))).mod(n);');
    // that formula in JavaScript (integer arithmetic, the operands never negative for k >= -1)
    const node = (a, k) => { const num = a.start + (k + a.n) * a.step; expect(num).toBeGreaterThanOrEqual(0); return a.base + (num % a.n); };
    for (const a of [{ base: 32, n: 8, start: 5, step: 3 }, { base: 0, n: 32, start: 31, step: 0 }, { base: 3, n: 1, start: 0, step: 1 }]) {
      for (let k = -1; k < 500; k++) expect(node(a, k)).toBe(imageAt(a, k));
    }
  });

  it('builds the material with the classic uniforms\' keys, each with a value', () => {
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const table = new THREE.DataTexture(new Float32Array(8), 1, 2, THREE.RGBAFormat, THREE.FloatType);
    const { material, uniforms } = faceMaterial({ blank, blankTable: table, photometry: { display: 'physical' } });
    expect(material.isNodeMaterial).toBe(true);
    expect(material.colorNode).toBeTruthy();
    expect(material.emissiveNode).toBeTruthy();
    for (const k of ['uArt', 'uAds', 'uAdTable', 'uAdTexel', 'uMode', 'uTime', 'uDigitalLevel', 'uStaticLevel']) expect(uniforms[k], k).toHaveProperty('value');
    expect(uniforms.uAds.value.image).toBe(blank.image); // a filterable copy of the blank (below)
    uniforms.uAds.value = table; // a texture node takes a new texture
    expect(uniforms.uAds.value).toBe(table);
    expect(uniforms.uAdTexel.value.isVector2).toBe(true);
    const lamp = lampMaterial({ photometry: { display: 'classic' } });
    expect(lamp.material.emissiveNode).toBeTruthy();
    lamp.uniforms.uLevel.value = 15;
    expect(lamp.uniforms.uLevel.value).toBe(15);
  });

  it('is built against filterable stand-ins, so WGSL samples the atlas with its mipmaps', () => {
    // three's WGSL builder decides at build time: a texture with Nearest min and mag filters is "unfilterable" and read
    // with textureSampleLevel(..., 0), and the shader keeps that after the atlas replaces the stand-in (found by
    // tests/manual/screens-parity.mjs: the faces aliased on WebGPU only)
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); // Nearest, as billboards.js makes it
    const table = new THREE.DataTexture(new Float32Array(8), 1, 2, THREE.RGBAFormat, THREE.FloatType);
    const { uniforms } = faceMaterial({ blank, blankTable: table, photometry: { display: 'physical' } });
    for (const k of ['uArt', 'uAds']) {
      const t = uniforms[k].value;
      expect(t.minFilter === THREE.NearestFilter && t.magFilter === THREE.NearestFilter, k).toBe(false);
    }
  });

  it('detail by quality level: the atlas tier, the floodlights per face and the glowing faces', () => {
    expect(DETAIL.low).toEqual({ tier: 'low', lampsBulletin: 2, lampsPoster: 2, glow: 2 });
    expect(DETAIL.high).toEqual({ tier: 'high', lampsBulletin: 4, lampsPoster: 2, glow: 6 });
    expect(DETAIL.ultra.tier).toBe('high');
  });
});

describe('the node light terms (screens/light.node.js)', () => {
  it('share one term object between materials and come off again', () => {
    const light = createSphereLight({ range: 900, photometry: { display: 'physical' } });
    expect(light.display).toBe('physical');
    const a = new MeshLambertNodeMaterial(), b = new MeshLambertNodeMaterial();
    const offA = light.attach(a), offB = light.attach(b);
    expect(surfaceTerms(a)).toEqual(['screenSphere']);
    expect(surfaceTerms(b)).toEqual(['screenSphere']);
    expect(light.uniforms.uScrSphere.value.isVector4).toBe(true);
    expect(light.uniforms.uScrSphereSpec.value.x).toBe(900);
    offA(); offB();
    expect(surfaceTerms(a)).toEqual([]);
  });

  it('the glow takes as many faces as the quality level gives it, none for 0', () => {
    const g = createGlowLight({ range: 70, count: 2, photometry: { display: 'classic' } });
    expect(g.count).toBe(2);
    expect(g.uniforms.uScrGlowP.value).toHaveLength(2);
    expect(g.uniforms.uScrGlowN.value[0].w).toBe(70);
    const m = new MeshLambertNodeMaterial();
    g.attach(m)();
    expect(createGlowLight({ range: 70, count: 99 }).count).toBe(GLOW_MAX);
    const none = createGlowLight({ range: 70, count: 0 }), m2 = new MeshLambertNodeMaterial();
    none.attach(m2);
    expect(surfaceTerms(m2)).toEqual([]);
  });
});

describe('the screens part on plan 01\'s renderer', () => {
  function tower(id) {
    const g = new THREE.BufferGeometry();
    const p = [0, 0, 0, 40, 0, 0, 40, 40, 0, 0, 0, 0, 40, 40, 0, 0, 40, 0];
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('led', new THREE.Float32BufferAttribute(new Array(6).fill(1), 1));
    return { data: { id, name: id }, mesh: new THREE.Mesh(g, new THREE.MeshBasicMaterial()), offset: new THREE.Vector3() };
  }
  it('gives the Sphere\'s mean in cd/m2 (plan 01\'s ledCdM2), lights node materials and leaves others alone', () => {
    const sphere = tower(SPHERE_ID);
    const road = new MeshLambertNodeMaterial(), plain = new THREE.MeshLambertMaterial();
    const surfaces = [];
    const part = createScreensPart({
      legacy: false, app: { tall: [sphere], events: createEmitter() }, session: null, group: new THREE.Group(),
      materials: { road, roadNear: plain }, ground: [], env: {}, eachSurface: (fn) => { surfaces.push(fn); return () => {}; },
    });
    expect(surfaceTerms(road)).toEqual(['screenSphere']);
    expect(part.stats().materials).toBe(1);
    const corridor = new MeshLambertNodeMaterial(), sign = new MeshLambertNodeMaterial();
    surfaces[0](corridor, 'building');
    surfaces[0](sign, 'sign');
    expect(surfaceTerms(corridor)).toEqual(['screenSphere']);
    expect(surfaceTerms(sign)).toEqual([]);
    const was = switchOn.signs.value;
    switchOn.signs.value = 1;
    const simMs = Date.parse('2026-11-22T05:00:00Z');
    const { samples } = ledSamples(sphere.mesh.geometry.getAttribute('position').array, sphere.mesh.geometry.getAttribute('led').array, 512);
    const want = ledMean(samples, contentSeconds(simMs)).map((v) => v * ledCdM2(1));
    const got = part.registry.meanColor('sphere', simMs);
    for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(want[c], 3);
    switchOn.signs.value = was;
    part.dispose();
    expect(surfaceTerms(road)).toEqual([]);
  });
});
