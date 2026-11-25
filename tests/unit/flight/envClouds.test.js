// The cloud a flight draws round itself while plan 01 has none (src/flight/clouds.js): the veil's shells follow
// Koschmieder's law for the visibility at the eye, and the decks are a layer's top seen from above and its base from
// below, never drawn inside it.
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { veilShells, decksFor, createClouds, KOSCHMIEDER, MAX_SHELLS } from '../../../src/flight/clouds.js';
import { createFrame } from '../../../src/world/frame.js';
import { recordedAir } from '../../../src/flight/env.js';
import cities from '../../../data/cities.json' with { type: 'json' };
import wx from '../../../public/data/lv/flights/lv-wx.json' with { type: 'json' };

const city = cities.lv;
const frame = createFrame(city);

/** The transmittance the shells leave at distance d. */
function transmittance(shells, d) {
  let T = 1;
  for (const s of shells) if (s.radius <= d) T *= 1 - s.alpha;
  return T;
}

describe('the veil', () => {
  it('in cloud (110 m): the view is used up within a few hundred metres, the wing (10 to 17 m) still shows', () => {
    const sh = veilShells(KOSCHMIEDER / 110);
    expect(sh.length).toBeLessThanOrEqual(MAX_SHELLS);
    expect(sh.at(-1).alpha).toBe(1);
    expect(sh.at(-1).radius).toBeLessThan(400);
    const atWing = transmittance(sh, 17);
    expect(atWing).toBeGreaterThan(0.35);
    expect(atWing).toBeLessThan(0.85);
    // Koschmieder at 110 m: 2 % contrast left, within the shells' steps
    expect(transmittance(sh, 110)).toBeLessThan(0.15);
  });

  it('under the base at 10 km: a few per cent of the ground 10 km off, most of it at 1 km', () => {
    const sh = veilShells(KOSCHMIEDER / 10400);
    expect(transmittance(sh, 1100)).toBeGreaterThan(0.6);
    expect(transmittance(sh, 12000)).toBeLessThan(0.08);
  });

  it('nothing in clear air, and never more than the cap', () => {
    expect(veilShells(0)).toEqual([]);
    expect(veilShells(KOSCHMIEDER / 50).length).toBeLessThanOrEqual(MAX_SHELLS);
    for (const v of [30, 300, 3000, 30000]) for (const s of veilShells(KOSCHMIEDER / v)) expect(s.alpha).toBeGreaterThan(0);
  });
});

describe('the decks', () => {
  const air = recordedAir(wx);
  const [L] = air.layers;

  it('the overcast\'s top from cruise, nothing inside it, its base from under it', () => {
    expect(decksFor(air.layers, 9000)).toEqual([expect.objectContaining({ side: 'top', heightM: L.topM, cover: 1 })]);
    expect(decksFor(air.layers, (L.baseM + L.topM) / 2)).toEqual([]);
    expect(decksFor(air.layers, L.baseM - 50)).toEqual([expect.objectContaining({ side: 'base', heightM: L.baseM })]);
  });

  it('createClouds places them round the camera: decks on the frame\'s curve, the veil from the visibility', () => {
    let layers = air.layers;
    const fe = { city, frame, sky: () => ({ layers, belowBaseM: air.belowBaseM, source: 'as-flown' }) };
    const scene = new Scene();
    const clouds = createClouds({ fe, scene });
    scene.add(clouds.group);
    const camera = new PerspectiveCamera(60, 1.6, 0.05, 700000);
    // cruise, 60 km east of the airport
    camera.position.set(60000, frame.sceneY(9000, 60000, -5000), 5000);
    camera.updateMatrixWorld();
    let st = clouds.update(camera);
    expect(st.inCloud).toBe(false);
    expect(st.veil).toEqual([]);
    expect(st.decks).toEqual([expect.objectContaining({ side: 'top' })]);
    const deck = clouds.group.children.find((o) => o.name.startsWith('flight-cloud-deck') && o.visible);
    // the deck's centre at the top's height above the eye's ground point, its rim lower by the curve
    expect(deck.position.y).toBeCloseTo(frame.sceneY(L.topM, 60000, -5000), 3);
    const pos = deck.geometry.attributes.position;
    const rimY = pos.getY(pos.count - 1);
    expect(rimY).toBeLessThan(-1000);
    // inside the layer: the white-out, no deck
    camera.position.set(8000, frame.sceneY(1500, 8000, -3000), 3000);
    camera.updateMatrixWorld();
    st = clouds.update(camera);
    expect(st.inCloud).toBe(true);
    expect(st.visibilityM).toBe(110);
    expect(st.decks).toEqual([]);
    const shells = clouds.group.children.filter((o) => o.name.startsWith('flight-cloud-veil') && o.visible);
    expect(shells.length).toBe(st.veil.length);
    expect(shells[0].position.distanceTo(camera.getWorldPosition(new Vector3()))).toBeLessThan(1e-6);
    // under the base: the reported visibility, the base above
    camera.position.set(3000, frame.sceneY(L.baseM - 60, 3000, -2500), 2500);
    camera.updateMatrixWorld();
    st = clouds.update(camera);
    expect(st.inCloud).toBe(false);
    expect(st.visibilityM).toBeCloseTo(air.belowBaseM, 6);
    expect(st.decks).toEqual([expect.objectContaining({ side: 'base' })]);
    // a clear sky draws nothing
    layers = [];
    st = clouds.update(camera);
    expect(st.decks).toEqual([]);
    clouds.dispose();
  });
});
