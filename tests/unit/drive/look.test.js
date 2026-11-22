// The drive's continuous look (src/drive/look.js) and its application to the legacy sky (src/drive/skyblend.js).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  duskAt, lightsAt, lookAt, skyAt, sunLightAt, elevationForDusk, isNightAt, rgbOf, KEYS,
  DAY_ELEVATION, NIGHT_ELEVATION, NIGHT_DUSK, NIGHT_BELOW,
} from '../../../src/drive/look.js';
import { createSkyBlend, sceneDirection, SUN_STEP_MS } from '../../../src/drive/skyblend.js';
import { createLegacySky, DAY, NIGHT } from '../../../src/sky/legacySky.js';
import { night } from '../../../src/night.js';

const range = (a, b, step) => { const out = []; for (let x = a; x >= b - 1e-9; x -= step) out.push(x); return out; };

describe('duskAt', () => {
  it('is 0 in full day and 1 at night, exactly', () => {
    for (const el of [90, 45, 20, DAY_ELEVATION]) expect(duskAt(el)).toBe(0);
    for (const el of [NIGHT_ELEVATION, -12, -18, -40, -90]) expect(duskAt(el)).toBe(1);
  });
  it('is monotonic and continuous in elevation', () => {
    let prev = -1;
    for (const el of range(10, -12, 0.01)) {
      const d = duskAt(el);
      expect(d).toBeGreaterThanOrEqual(prev);
      if (prev >= 0) expect(d - prev).toBeLessThan(0.002); // no step anywhere: at most 0.002 per 0.01 degree
      prev = d;
    }
  });
  it('changes fastest in civil twilight, between 0 and -6 degrees', () => {
    const rate = (el) => duskAt(el - 0.5) - duskAt(el + 0.5);
    let best = null;
    for (const el of range(6, -9, 0.25)) if (!best || rate(el) > rate(best)) best = el;
    expect(best).toBeLessThan(0);
    expect(best).toBeGreaterThan(-6);
    expect(duskAt(2)).toBeLessThan(0.05); // still day a few degrees up
    expect(duskAt(-6)).toBeGreaterThan(0.7);
  });
  it('inverts', () => {
    for (const d of [0.05, 0.3, 0.5, 0.9]) expect(duskAt(elevationForDusk(d))).toBeCloseTo(d, 6);
  });
});

describe('night boolean', () => {
  it('switches where the old switch was, before the default moment', () => {
    expect(NIGHT_BELOW).toBe(1.5);
    expect(NIGHT_DUSK).toBeCloseTo(duskAt(-1.5), 12);
    expect(isNightAt(10)).toBe(false);
    expect(isNightAt(-1.4)).toBe(false);
    expect(isNightAt(-1.6)).toBe(true);
    expect(isNightAt(-3)).toBe(true); // the default moment shows the night interface
    expect(lookAt({ elevation: -1.6, azimuth: 250 }).night).toBe(true);
    expect(lookAt({ elevation: -1.4, azimuth: 250 }).night).toBe(false);
  });
});

describe('lightsAt', () => {
  it('is exactly 0 and 1 at the ends, monotonic, and about half on at the default moment', () => {
    expect(lightsAt(0)).toBe(0);
    expect(lightsAt(1)).toBe(1);
    let prev = 0;
    for (let d = 0; d <= 1; d += 0.01) { expect(lightsAt(d)).toBeGreaterThanOrEqual(prev); prev = lightsAt(d); }
    const atDefault = lightsAt(duskAt(-3));
    expect(atDefault).toBeGreaterThan(0.25);
    expect(atDefault).toBeLessThan(0.6);
  });
});

describe('skyAt and lookAt', () => {
  const sameColour = (rgb, hex) => expect(rgb).toEqual(rgbOf(hex));
  it('is the app\'s day look exactly at the day end', () => {
    const l = lookAt({ elevation: 30, azimuth: 200 });
    expect(l.dusk).toBe(0);
    expect(l.lights).toBe(0);
    for (const k of ['haze', 'zenith', 'skyLight', 'groundLight']) sameColour(l.sky[k], DAY[k]);
    expect(l.sky.hemi).toBe(DAY.hemi);
    expect(l.sky.glowAmount).toBe(0);
    expect(l.light).toMatchObject({ source: 'sun', intensity: DAY.sunPower });
    sameColour(l.light.color, DAY.sun);
    expect(l.street).toEqual(DAY.street);
  });
  it('is the app\'s night look exactly at the night end', () => {
    const l = lookAt({ elevation: -30, azimuth: 300 });
    expect(l.dusk).toBe(1);
    expect(l.lights).toBe(1);
    for (const k of ['haze', 'zenith', 'skyLight', 'groundLight']) sameColour(l.sky[k], NIGHT[k]);
    expect(l.sky.hemi).toBe(NIGHT.hemi);
    expect(l.sky.glowAmount).toBe(0);
    expect(l.light).toMatchObject({ source: 'moon', intensity: NIGHT.sunPower });
    sameColour(l.light.color, NIGHT.sun);
    expect(l.street).toEqual(NIGHT.street);
  });
  it('passes through the key states in order and is continuous between them', () => {
    expect(KEYS.map((k) => k.dusk)).toEqual([...KEYS.map((k) => k.dusk)].sort((a, b) => a - b));
    for (const k of KEYS) sameColour(skyAt(k.dusk).zenith, k.zenith);
    const fields = (s) => [...s.haze, ...s.zenith, ...s.skyLight, ...s.groundLight, ...s.glow, s.hemi, s.glowAmount];
    let prev = fields(skyAt(0));
    for (let d = 0.001; d <= 1; d += 0.001) {
      const f = fields(skyAt(d));
      f.forEach((v, i) => expect(Math.abs(v - prev[i])).toBeLessThan(0.02)); // linear between keys: no jumps
      prev = f;
    }
  });
  it('warms the low-sun horizon, darkens the zenith in twilight, and keeps the sky darkening overall', () => {
    const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const low = skyAt(duskAt(1)), twi = skyAt(duskAt(-3.5));
    expect(low.haze[0]).toBeGreaterThan(low.haze[2]); // warm horizon
    expect(twi.glow[0]).toBeGreaterThan(twi.glow[2]); // orange band
    expect(twi.glowAmount).toBeGreaterThan(0.5);
    expect(twi.zenith[2]).toBeGreaterThan(twi.zenith[0] * 2); // deep blue
    let prev = Infinity;
    for (const el of range(8, -10, 0.25)) {
      const s = skyAt(duskAt(el));
      const v = lum(s.zenith) + lum(s.haze);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
  it('fades the sun out below the horizon and the moon stand-in in deep in twilight, never both', () => {
    expect(sunLightAt(10, 0)).toEqual({ source: 'sun', weight: 1 });
    expect(sunLightAt(-1, duskAt(-1)).source).toBe('none');
    let prev = Infinity;
    for (const el of range(4, -12, 0.05)) {
      const l = lookAt({ elevation: el, azimuth: 250 }).light;
      if (l.source === 'sun') { expect(l.intensity).toBeLessThanOrEqual(prev + 1e-9); prev = l.intensity; }
      if (el < -0.8) expect(l.source).not.toBe('sun');
      if (duskAt(el) <= 0.5) expect(l.source).not.toBe('moon');
    }
    // the light is off where it changes hands
    expect(lookAt({ elevation: -0.8, azimuth: 250 }).light.intensity).toBeLessThan(1e-9);
    expect(lookAt({ elevation: elevationForDusk(0.5), azimuth: 250 }).light.intensity).toBeLessThan(1e-6);
  });
  it('rounds dusk to steps when asked, keeping the ends exact', () => {
    const l = lookAt({ elevation: -3, azimuth: 250 }, { steps: 512 });
    expect(l.dusk * 512).toBe(Math.round(l.dusk * 512));
    expect(Math.abs(l.dusk - duskAt(-3))).toBeLessThanOrEqual(1 / 1024);
    expect(lookAt({ elevation: 20, azimuth: 0 }, { steps: 512 }).dusk).toBe(0);
    expect(lookAt({ elevation: -20, azimuth: 0 }, { steps: 512 }).dusk).toBe(1);
  });
});

describe('createSkyBlend on the legacy sky', () => {
  const city = { shadow: { x: 100, y: 200, half: 1000 } };
  function setup() {
    const scene = new THREE.Scene();
    const sky = createLegacySky();
    let frames = 0;
    sky.init({ scene, city, invalidate: () => frames++ });
    const ground = [0, 1].map(() => [new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial()), 'g']);
    const terrain = ground.map(([mesh]) => ({ mesh }));
    const renderer = { shadowMap: { needsUpdate: false } };
    const ephemeris = { sun: (ms) => ({ azimuth: 250, elevation: 20 - ms / 600000 }) }; // one degree every 10 minutes
    const blend = createSkyBlend({ dome: sky.dome, renderer, invalidate: () => frames++, ephemeris, ground, imagery: () => true });
    return { scene, sky, terrain, renderer, blend, ephemeris };
  }
  // what the map's own apply() leaves, as plain numbers
  const snapshot = ({ scene, sky, terrain }) => ({
    fog: scene.fog.color.getHex(), hemi: [sky.hemi.color.getHex(), sky.hemi.groundColor.getHex(), sky.hemi.intensity],
    sun: [sky.sun.color.getHex(), sky.sun.intensity, sky.sun.shadow.intensity], night: night.value, street: terrain.map((t) => t.mesh.material.emissiveIntensity),
  });

  it('is the map\'s own day and night looks at the ends, and hands the sky back as it found it', () => {
    const s = setup();
    for (const isNight of [false, true]) {
      s.sky.apply({ night: isNight, imagery: true, terrain: s.terrain });
      const mapLook = snapshot(s);
      const domeMaterial = s.sky.dome.material, sunAt = s.sky.sun.position.clone();
      s.blend.set(lookAt({ elevation: isNight ? -30 : 40, azimuth: 250 }), 0);
      expect(s.blend.held).toBe(true);
      expect(s.sky.dome.material).not.toBe(domeMaterial);
      expect(snapshot(s)).toEqual(mapLook);
      // the dome's colours: the legacy dome's own at the ends, with the band off
      const u = s.sky.dome.material.uniforms;
      expect(u.horizon.value.getHex()).toBe(domeMaterial.uniforms.horizon.value.getHex());
      expect(u.zenith.value.getHex()).toBe(domeMaterial.uniforms.zenith.value.getHex());
      expect(u.glowAmount.value).toBe(0);
      s.blend.release();
      expect(s.sky.hold).toBe(null);
      expect(s.sky.dome.material).toBe(domeMaterial);
      expect(s.sky.sun.position.equals(sunAt)).toBe(true);
    }
  });

  it('routes the app\'s apply() to the blend while held, and leaves it alone after', () => {
    const s = setup();
    s.blend.set(lookAt({ elevation: -3, azimuth: 250 }), 0);
    const held = snapshot(s);
    s.sky.apply({ night: false, imagery: false, terrain: s.terrain }); // e.g. the imagery setting changed while driving
    expect(snapshot(s).night).toBe(held.night);
    expect(snapshot(s).street[1]).toBeCloseTo(held.street[1] * 0.3, 9);
    s.blend.release();
    s.sky.apply({ night: false, imagery: true, terrain: s.terrain });
    expect(night.value).toBe(0);
    expect(s.scene.fog.color.getHex()).toBe(DAY.haze);
  });

  it('points the light along the sun and refreshes the shadow map only when the rounded sun moves', () => {
    const s = setup();
    const target = s.sky.sun.target.position;
    s.blend.set(lookAt({ elevation: 20, azimuth: 250 }), 0);
    const d = s.sky.sun.position.clone().sub(target).normalize();
    expect(d.distanceTo(sceneDirection(250, 20))).toBeLessThan(1e-9);
    s.renderer.shadowMap.needsUpdate = false;
    const before = s.blend.stats().shadowRefreshes;
    s.blend.set(lookAt({ elevation: 20, azimuth: 250 }), SUN_STEP_MS * 0.4); // same rounded step
    expect(s.renderer.shadowMap.needsUpdate).toBe(false);
    s.blend.set(lookAt({ elevation: 19.8, azimuth: 250 }), SUN_STEP_MS); // the next step
    expect(s.renderer.shadowMap.needsUpdate).toBe(true);
    expect(s.blend.stats().shadowRefreshes).toBe(before + 1);
    // the same time from either direction gives the same light
    const at = (ms) => { s.blend.set(lookAt({ elevation: 18, azimuth: 250 }), ms); return s.sky.sun.position.clone(); };
    const first = at(13 * SUN_STEP_MS + 1000);
    at(20 * SUN_STEP_MS);
    expect(at(13 * SUN_STEP_MS + 1000).equals(first)).toBe(true);
    // shadows fade out low in the sky, and the map is not redrawn for shadows nobody sees
    s.blend.set(lookAt({ elevation: 6, azimuth: 250 }), 30 * SUN_STEP_MS);
    expect(s.sky.sun.shadow.intensity).toBeGreaterThan(0);
    expect(s.sky.sun.shadow.intensity).toBeLessThan(1);
    s.blend.set(lookAt({ elevation: 1, azimuth: 250 }), 40 * SUN_STEP_MS);
    expect(s.sky.sun.shadow.intensity).toBe(0);
    const n = s.blend.stats().shadowRefreshes;
    s.blend.set(lookAt({ elevation: 0.5, azimuth: 250 }), 41 * SUN_STEP_MS);
    expect(s.blend.stats().shadowRefreshes).toBe(n);
    // at night the moon stand-in shines from the map's fixed place
    s.blend.release();
    const fixed = s.sky.sun.position.clone();
    s.blend.set(lookAt({ elevation: -30, azimuth: 250 }), 0);
    expect(s.sky.sun.position.equals(fixed)).toBe(true);
    s.blend.release();
  });
});

describe('the drive materials take a continuous night', () => {
  it('road: setNight(number) scales the glow, the boolean still works, setLook reads lights', async () => {
    const { createRoadMaterials } = await import('../../../src/drive/roadnet/material.js');
    const m = createRoadMaterials();
    m.setNight(true);
    const full = [m.road.emissiveIntensity, m.roadNear.emissiveIntensity];
    m.setNight(0.5);
    expect(m.road.emissiveIntensity).toBeCloseTo(full[0] / 2, 12);
    expect(m.roadNear.emissiveIntensity).toBeCloseTo(full[1] / 2, 12);
    m.setLook(lookAt({ elevation: 20, azimuth: 0 }));
    expect(m.road.emissiveIntensity + m.roadNear.emissiveIntensity).toBe(0);
    m.setLook(lookAt({ elevation: -20, azimuth: 0 }));
    expect([m.road.emissiveIntensity, m.roadNear.emissiveIntensity]).toEqual(full);
    m.setNight(false);
    expect(m.road.emissiveIntensity).toBe(0);
    m.dispose();
  });
  it('nightWeight maps booleans and clamps numbers', async () => {
    const { nightWeight } = await import('../../../src/drive/roadside/batch.js');
    expect([true, false, 0, 1, 0.25, -1, 2, NaN].map(nightWeight)).toEqual([1, 0, 0, 1, 0.25, 0, 1, 0]);
  });
});
