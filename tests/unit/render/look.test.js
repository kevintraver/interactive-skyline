// Plan 01's look (src/render/look.js) and its one input for modes whose camera is not in the lit city: setPriorTerms
// (added for the flight's exposure, plan 03, 25 Nov 2026). Without it, or after it is cleared, the prior, the exposure
// and the lights are exactly what they were; with it only the prior moves.
import { describe, it, expect } from 'vitest';
import { Scene, Vector3, Color } from 'three';
import { createLook, SHIPPED_OFFSET_EV } from '../../../src/render/look.js';
import { physicalLights, priorEv100 } from '../../../src/render/photometry.js';
import { exposureFor } from '../../../src/render/exposure.js';
import { exposure as exposureUniform } from '../../../src/render/materials/shared.js';

/** A fake app with the parts the look reads: the legacy sky's classic values and plan 01's state. */
function fakeApp({ keyBody = 'moon', altDeg = 30, ambientLux = 0.0006, street = 1, sunPower = 0.2, moonLux = 0.1 } = {}) {
  const dir = new Vector3(0, Math.sin((altDeg * Math.PI) / 180), -Math.cos((altDeg * Math.PI) / 180));
  const light = () => ({ intensity: 1, color: new Color(1, 1, 1), position: dir.clone(), target: { position: new Vector3() } });
  const sky = { classic: { pinned: false, keyBody, keyWeight: 1, sunPower, street: [0.26], imagery: true }, sun: light(), hemi: light(), terrain: [] };
  const env = {
    mode: 'clock',
    state: { key: { body: keyBody, dir }, sky: { ambientLux }, lights: { street }, moon: { illuminanceLux: moonLux } },
    nodes: { sync() {}, cityFactor: { value: 1 } },
  };
  const pipeline = { configure() {}, around: [] };
  return { scene: new Scene(), sky, env, renderer: {}, pipeline, clock: null, settings: {}, invalidate() {} };
}
const frame = (nowMs) => ({ nowMs });

describe('the look without a prior override', () => {
  it('computes the prior and the exposure as plan 01 does, bit for bit', () => {
    for (const o of [{}, { keyBody: 'sun', altDeg: 0.2, ambientLux: 300, street: 0.2, sunPower: 1.6 }, { keyBody: 'sun', altDeg: 45, ambientLux: 15000, street: 0, sunPower: 2.7 }]) {
      const app = fakeApp(o);
      const look = createLook(app, { display: 'physical' });
      look.update(frame(0));
      const c = app.sky.classic;
      const terms = { ...physicalLights(c, { pinned: false, moonLux: app.env.state.moon.illuminanceLux, ambientLux: app.env.state.sky.ambientLux, street: app.env.state.lights.street }), keyAltDeg: look.current.keyAltDeg };
      expect(look.current.priorEv).toBe(priorEv100(terms));
      expect(exposureUniform.value).toBe(exposureFor(priorEv100(terms), 'eye', SHIPPED_OFFSET_EV));
      expect(look.current.priorTerms).toBeUndefined();
    }
  });
  it('is exactly as before once an override is cleared', () => {
    const plain = fakeApp(), cleared = fakeApp();
    const a = createLook(plain, { display: 'physical' }), b = createLook(cleared, { display: 'physical' });
    b.setPriorTerms((t) => ({ ...t, cityLux: 0.001, emissionLux: 0 }));
    a.update(frame(0)); b.update(frame(0));
    expect(b.current.priorEv).toBeLessThan(a.current.priorEv - 5); // the override took
    b.setPriorTerms(null);
    a.update(frame(16)); const ka = exposureUniform.value, pa = a.current.priorEv;
    b.update(frame(16)); const kb = exposureUniform.value, pb = b.current.priorEv;
    expect(pb).toBe(pa);
    expect(kb).toBe(ka);
    expect(b.current.priorTerms).toBeUndefined();
    expect(Object.keys(b.current).sort()).toEqual(Object.keys(a.current).sort());
  });
});

describe('setPriorTerms', () => {
  it('hands the terms, the key body and the street state to the override and computes the prior from its answer', () => {
    const app = fakeApp({ street: 0.5 });
    const look = createLook(app, { display: 'physical' });
    let seen = null;
    look.setPriorTerms((t) => { seen = t; return { ...t, cityLux: 0.25, emissionLux: 0 }; });
    look.update(frame(0));
    expect(seen).toMatchObject({ keyBody: 'moon', street: 0.5, cityLux: 0.5, emissionLux: 0.5, ambientLux: 0.0006 });
    expect(look.current.priorEv).toBe(priorEv100({ ...seen, cityLux: 0.25, emissionLux: 0 }));
    expect(exposureUniform.value).toBe(exposureFor(look.current.priorEv, 'eye', SHIPPED_OFFSET_EV));
    expect(look.current.priorTerms).toMatchObject({ cityLux: 0.25, emissionLux: 0 });
  });
  it('moves only the prior: the lights keep their own lux', () => {
    const a = fakeApp(), b = fakeApp();
    const la = createLook(a, { display: 'physical' }), lb = createLook(b, { display: 'physical' });
    lb.setPriorTerms((t) => ({ ...t, cityLux: 0.01, emissionLux: 0 }));
    la.update(frame(0)); lb.update(frame(0));
    for (const k of ['keyLux', 'ambientLux', 'cityLux', 'emissionLux', 'keyAltDeg']) expect(lb.current[k], k).toBe(la.current[k]);
    expect(lb.current.priorEv).toBeLessThan(la.current.priorEv);
  });
  it('gives the city light the override\'s cityLightLux while it draws, plan 01\'s cityLux without one', () => {
    const lit = (fn) => {
      const app = fakeApp();
      const look = createLook(app, { display: 'physical' });
      if (fn) look.setPriorTerms(fn);
      look.update(frame(0));
      app.pipeline.around[0](true);
      const v = { k: exposureUniform.value, i: look.cityLight.intensity };
      app.pipeline.around[0](false);
      expect(look.cityLight.intensity).toBe(0);
      return v;
    };
    const plain = lit(null), same = lit((t) => ({ ...t })), dim = lit((t) => ({ ...t, cityLightLux: 0.001 }));
    expect(same.i).toBe(plain.i);
    expect(dim.i / dim.k).toBeCloseTo((plain.i / plain.k) * 0.001, 12);
  });
  it('does nothing on the classic display', () => {
    const app = fakeApp();
    const look = createLook(app, { display: 'classic' });
    let called = false;
    look.setPriorTerms(() => { called = true; return {}; });
    look.update(frame(0));
    expect(called).toBe(false);
    expect(exposureUniform.value).toBe(1);
  });
});
