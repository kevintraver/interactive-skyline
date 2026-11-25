// Plan 03, section 4.6 and F7.2: the orbit's controls. The pure half: the radius slider (logarithmic, from the bank
// limit's smallest to 60 km), the altitude slider and its marks, the readouts (bank and lap time, which must equal the
// flown track's, and the speed, which is not a control), the presets, and the changes each control hands back.
import { describe, it, expect } from 'vitest';
import { sliderToRadius, radiusToSlider, snapAltitude, orbitReadouts, matchingPreset, panelChange, RADIUS_STEPS, createOrbitPanel } from '../../../src/flight/ui/orbitPanel.js';
import { orbitParams, createOrbitTrack, PRESETS, ORBIT } from '../../../src/flight/orbit.js';
import { createFrame } from '../../../src/world/frame.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);

describe('the radius slider', () => {
  it('runs from the smallest radius to 60 km, logarithmically, and round-trips', () => {
    expect(sliderToRadius(0, 4.1)).toBeCloseTo(4.1, 9);
    expect(sliderToRadius(RADIUS_STEPS, 4.1)).toBeCloseTo(60, 9);
    // the middle of the slider is the geometric mean, so short radii get as much travel as long ones
    expect(sliderToRadius(RADIUS_STEPS / 2, 4.1)).toBeCloseTo(Math.sqrt(4.1 * 60), 6);
    for (const r of [4.1, 5, 9, 31, 60]) expect(sliderToRadius(radiusToSlider(r, 4.1), 4.1)).toBeCloseTo(r, 9);
    expect(radiusToSlider(2, 4.1)).toBe(0);
    expect(radiusToSlider(100, 4.1)).toBe(RADIUS_STEPS);
  });
});

describe('the altitude slider', () => {
  it('snaps to the marks of 4.6 when close, and to 500 ft otherwise, inside the limits', () => {
    expect(ORBIT.altFt.marks).toEqual([5000, 10000, 18000, 35000]);
    expect(snapAltitude(10180)).toBe(10000);
    expect(snapAltitude(12340)).toBe(12500);
    expect(snapAltitude(3000)).toBe(4500);
    expect(snapAltitude(50000)).toBe(41000);
  });
});

describe('the readouts', () => {
  it('show the bank and lap time the track will fly (4.6), for any radius before it is flown', () => {
    for (const o of [{ altFt: 12000, radiusKm: 9 }, { altFt: 35000, radiusKm: 31 }, { altFt: 6500, radiusKm: 5 }, { altFt: 35000, radiusKm: 1 }]) {
      const p = orbitParams(o);
      const r = orbitReadouts(p);
      const t = createOrbitTrack({ ...o, rollIn: false }, { frame });
      expect(r.bankDeg).toBeCloseTo(t.bankDeg, 6);
      expect(r.lapS).toBeCloseTo(t.lapS, 3);
    }
  });

  it('with a wind, show the steepest bank (downwind) and the lap time of the turn around a point', () => {
    const o = { altFt: 12000, radiusKm: 9, wind: { east: 15, north: 0 } };
    const r = orbitReadouts(orbitParams(o)), t = createOrbitTrack({ ...o, rollIn: false }, { frame });
    let steepest = 0;
    for (let s = 0; s < t.lapS; s += 2) steepest = Math.max(steepest, Math.abs(t.sample(s).roll) * 180 / Math.PI);
    expect(r.bankDeg).toBeCloseTo(steepest, 1);
    expect(Math.abs(r.lapS - t.lapS) / t.lapS).toBeLessThan(1e-3);
  });

  it('say it in words, in the visitor\'s units: the speed is a readout, not a control', () => {
    const r = orbitReadouts(orbitParams({ altFt: 12000, radiusKm: 9 }));
    expect(r.text.altitude).toBe('12,000 ft');
    expect(r.text.radius).toBe('9 km');
    expect(r.text.bank).toMatch(/^Bank \d+°$/);
    expect(r.text.lap).toMatch(/^Lap \d+ min \d+ s$|^Lap \d+ min$/);
    expect(r.text.speed).toMatch(/^230 kt indicated, \d{3} kt true$/);
    const m = orbitReadouts(orbitParams({ altFt: 12000, radiusKm: 9 }), { units: 'm' });
    expect(m.text.altitude).toBe('3,660 m');
    expect(m.text.speed).toMatch(/^426 km\/h indicated, \d{3} km\/h true$/);
  });
});

describe('presets and changes', () => {
  it('know which preset is flying', () => {
    expect(matchingPreset(orbitParams({ altFt: 12000, radiusKm: 9 }))).toBe('valley');
    expect(matchingPreset(orbitParams({ altFt: 35000, radiusKm: 31 }))).toBe('overhead');
    expect(matchingPreset(orbitParams({ altFt: 13000, radiusKm: 9 }))).toBe(null);
  });

  it('hand back the change each control makes', () => {
    const p = orbitParams({ altFt: 12000, radiusKm: 9 });
    expect(panelChange('preset', 'strip', p)).toEqual({ altFt: PRESETS.strip.altFt, radiusKm: PRESETS.strip.radiusKm });
    expect(panelChange('altitude', 10180, p)).toEqual({ altFt: 10000 });
    const r = panelChange('radius', radiusToSlider(20, p.minRadiusKm), p);
    expect(r.radiusKm).toBeCloseTo(20, 9);
    expect(panelChange('outward', true, p)).toEqual({ outward: true });
    expect(panelChange('center', { x: 316, n: 415 }, p)).toEqual({ center: { x: 316, n: 415 } });
  });

  it('keep the radius as asked when the altitude changes, unless the new bank limit raises it', () => {
    const p = orbitParams({ altFt: 6500, radiusKm: 5 });
    expect(panelChange('altitude', 35000, p)).toEqual({ altFt: 35000 });
    expect(orbitParams({ ...p, altFt: 35000 }).radiusKm).toBeGreaterThan(11.6);
  });
});

// ---------------------------------------------------------------------------------------------------- the DOM half

/** Just enough of a document for createOrbitPanel: elements with attributes, children, text and events. */
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = {};
    const el = {
      tagName: tag.toUpperCase(), children: [], attributes: {}, textContent: '', hidden: false, value: '', parent: null,
      set id(v) { this._id = v; byId.set(v, this); }, get id() { return this._id; },
      setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = v; },
      getAttribute(k) { return this.attributes[k] ?? null; },
      append(...kids) { for (const k of kids) { if (typeof k === 'object') { k.parent = this; this.children.push(k); } } },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, ev = {}) { const e = { target: this, stopped: false, stopPropagation() { this.stopped = true; }, ...ev }; for (let n = this; n; n = n.parent) for (const fn of n.__listeners?.[type] || []) fn(e); return e; },
      get __listeners() { return listeners; },
      all() { return [this, ...this.children.flatMap((c) => c.all())]; },
    };
    return el;
  };
  const doc = { createElement: make, getElementById: (id) => byId.get(id) ?? null };
  doc.head = make('head');
  doc.body = make('body');
  return doc;
}

describe('createOrbitPanel', () => {
  const setup = () => {
    const doc = fakeDocument(), changes = [];
    const p = orbitParams({ altFt: 12000, radiusKm: 9, seat: '22F', center: { x: 316, n: 415 } });
    const panel = createOrbitPanel({ parent: doc.body, params: p, stripCenter: { x: 316, n: 415 }, onChange: (c) => changes.push(c), doc });
    const all = panel.el.all();
    const find = (pred) => all.find(pred);
    return { doc, panel, changes, p, all, find };
  };

  it('builds the controls, injects its style once, and shows the readouts and the preset flying', () => {
    const { doc, find, all } = setup();
    expect(doc.head.children.filter((c) => c.id === 'orbitpanel-style')).toHaveLength(1);
    createOrbitPanel({ parent: doc.body, params: orbitParams({}), onChange: () => {}, doc });
    expect(doc.head.children.filter((c) => c.id === 'orbitpanel-style')).toHaveLength(1);
    const ranges = all.filter((n) => n.type === 'range');
    expect(ranges).toHaveLength(2);
    expect(ranges[0].value).toBe('12000');
    expect(ranges[0].getAttribute('aria-valuetext')).toBe('12,000 ft');
    expect(ranges[1].getAttribute('aria-valuetext')).toMatch(/^9 km, bank \d+°, lap /);
    expect(find((n) => n.getAttribute('data-preset') === 'valley').getAttribute('aria-pressed')).toBe('true');
    expect(find((n) => n.getAttribute('role') === 'switch').getAttribute('aria-checked')).toBe('false');
    expect(find((n) => n.textContent === 'Back to the Strip').hidden).toBe(true);
  });

  it('hands back a preset, a released slider and the switch as changes; a moving slider only previews', () => {
    const { find, all, changes } = setup();
    find((n) => n.getAttribute('data-preset') === 'overhead').dispatch('click');
    expect(changes.at(-1)).toEqual({ altFt: 35000, radiusKm: 31 });
    const [alt, rad] = all.filter((n) => n.type === 'range');
    alt.value = '18100';
    alt.dispatch('input');
    expect(changes).toHaveLength(1);
    expect(alt.getAttribute('aria-valuetext')).toBe('18,000 ft');
    alt.dispatch('change');
    expect(changes.at(-1)).toEqual({ altFt: 18000 });
    rad.value = String(RADIUS_STEPS);
    rad.dispatch('change');
    expect(changes.at(-1).radiusKm).toBeCloseTo(60, 9);
    find((n) => n.getAttribute('role') === 'switch').dispatch('click');
    expect(changes.at(-1)).toEqual({ outward: true });
  });

  it('keeps the arrow keys of a focused slider from the mode\'s shortcuts, and follows the orbit when updated', () => {
    const { panel, all, find } = setup();
    const [alt] = all.filter((n) => n.type === 'range');
    expect(alt.dispatch('keydown', { key: 'ArrowRight' }).stopped).toBe(true);
    expect(alt.dispatch('keydown', { key: 'p' }).stopped).toBe(false);
    panel.update(orbitParams({ altFt: 6500, radiusKm: 5, center: { x: 900, n: 100 }, outward: true }), { centerLabel: 'Sphere' });
    expect(alt.value).toBe('6500');
    expect(find((n) => n.getAttribute('role') === 'switch').getAttribute('aria-checked')).toBe('true');
    expect(find((n) => n.textContent === 'Back to the Strip').hidden).toBe(false);
    expect(find((n) => n.textContent === 'Circling Sphere')).toBeTruthy();
  });

  it('says which control made each change, so the mode can cut a preset', () => {
    const doc = fakeDocument(), kinds = [];
    const p = orbitParams({ altFt: 12000, radiusKm: 9, seat: '22F' });
    const panel = createOrbitPanel({ parent: doc.body, params: p, onChange: (c, info) => kinds.push(info?.kind), doc });
    const all = panel.el.all();
    all.find((n) => n.getAttribute('data-preset') === 'strip').dispatch('click');
    const [alt, rad] = all.filter((n) => n.type === 'range');
    alt.value = '13000'; alt.dispatch('change');
    rad.value = '500'; rad.dispatch('change');
    all.find((n) => n.getAttribute('role') === 'switch').dispatch('click');
    expect(kinds).toEqual(['preset', 'altitude', 'radius', 'outward']);
  });

  it('collapses to its title and opens again (on a phone it starts collapsed)', () => {
    const doc = fakeDocument();
    const panel = createOrbitPanel({ parent: doc.body, params: orbitParams({}), onChange: () => {}, doc, collapsed: true });
    const all = panel.el.all();
    const title = all.find((n) => n.getAttribute('class') === 'op-title' || n.className === 'op-title');
    const body = all.find((n) => n.className === 'op-body');
    expect(title.tagName).toBe('BUTTON');
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    title.dispatch('click');
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    panel.setCollapsed(true);
    expect(body.hidden).toBe(true);
    expect(panel.collapsed).toBe(true);
  });
});
