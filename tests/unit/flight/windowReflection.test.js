// The cabin as the glass mirrors it (src/flight/window/reflection.js): the cube holds the cabin's own lamps at full,
// never the outside's light that happened to fill the cabin when it was drawn. The pane rescales the cube by the
// pre-exposure since the capture, so a cube drawn by day with the daylit cabin in it was mirrored forty times over at
// dusk: a white smear across the window (24 Nov 2026, lv-19-dusk at 10,000 ft).
import { describe, it, expect } from 'vitest';
import { Group, Vector3 } from 'three';
import { createCabinReflection } from '../../../src/flight/window/reflection.js';

describe('createCabinReflection().capture', () => {
  it('draws the cabin with its lamps at full and no outside light, then puts the light back', () => {
    const calls = [];
    const light = { cabinLight: 0.3, night: false, windowL: 1900, sunLux: 70000 };
    const mats = {
      get cabinLight() { return light.cabinLight; },
      get outside() { return { windowL: light.windowL, sunLux: light.sunLux }; },
      set(o) { Object.assign(light, o); },
    };
    const parent = new Group(), g = new Group();
    parent.add(g);
    const renderer = {
      coordinateSystem: 2000, xr: { enabled: false }, getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
      setRenderTarget() {}, autoClear: true, getClearAlpha: () => 1, getClearColor: (c) => c, setClearColor() {},
      render: () => calls.push({ ...light }),
    };
    const r = createCabinReflection({ size: 4 });
    expect(r.capture({ renderer, cabin: { group: g, model: { materials: mats } }, position: new Vector3(), night: false })).toBe(true);
    expect(calls.length).toBe(6);
    for (const c of calls) expect([c.cabinLight, c.windowL, c.sunLux]).toEqual([1, 0, 0]);
    expect(light).toEqual({ cabinLight: 0.3, night: false, windowL: 1900, sunLux: 70000 });
    expect(g.parent).toBe(parent);
    r.dispose();
  });
});

describe('createCabinReflection().capture at dusk', () => {
  it("draws the cube on the cabin's night setting now (a share through the twilight), and leaves it so", () => {
    const seen = [];
    const light = { cabinLight: 1, night: 0.4, windowL: 50, sunLux: 0 };
    const mats = {
      get cabinLight() { return light.cabinLight; },
      get night() { return light.night; },
      get outside() { return { windowL: light.windowL, sunLux: light.sunLux }; },
      set(o) { Object.assign(light, o); },
    };
    const g = new Group();
    const renderer = {
      coordinateSystem: 2000, xr: { enabled: false }, getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
      setRenderTarget() {}, autoClear: true, getClearAlpha: () => 1, getClearColor: (c) => c, setClearColor() {},
      render: () => seen.push(light.night),
    };
    const r = createCabinReflection({ size: 4 });
    // the session's flag says day (the Sun is still up by a fraction); the cabin is 40 % into its night setting
    r.capture({ renderer, cabin: { group: g, model: { materials: mats } }, position: new Vector3(), night: false });
    expect(seen).toEqual([0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    expect(light.night).toBe(0.4);
    r.dispose();
  });
});
