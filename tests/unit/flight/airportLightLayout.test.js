// The airport's light layout (plan 03, section 7.10; F4.3): every light the FAA record gives each runway end, from the
// standards' geometry, against the airport file and OpenStreetMap's mapped lights; PAPI colours by the viewer's angle;
// the flash limit of three a second.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FT, runwayFrames, createHeightModel } from '../../../src/flight/airport/geometry.js';
import {
  layoutLights, papiColours, lobe, PAPI_OFFSETS_DEG, createFlashSequencer, groupVisible, levelsFor, CAUTION_M,
} from '../../../src/flight/airport/lightLayout.js';
import { STEADY_DIM, MAX_FLASHES_PER_S } from '../../../src/flight/aircraft/lights.js';

const data = JSON.parse(readFileSync(new URL('../../../public/data/lv/airport.json', import.meta.url), 'utf8'));
const flat = () => 640;
const heightAt = createHeightModel(data, flat);
const layout = layoutLights(data, { heightAt });
const generatedOnly = layoutLights(data, { heightAt, mapped: false });
const { ends, runways } = runwayFrames(data);
const of = (pred) => layout.lights.filter(pred);
const DEG = Math.PI / 180;

/** An eye on the approach to `end`: `dist` m before the threshold, on a `angle` degree path crossing at `tchFt`. */
function eyeOnApproach(end, dist, angle = 3, tchFt = 50) {
  const e = ends[end];
  const [x, y] = e.toMap(-dist, 0);
  return [x, y, e.thr[2] + tchFt * FT + dist * Math.tan(angle * DEG)];
}

describe('runway edge lights', () => {
  for (const r of runways) {
    it(`line both sides of ${r.id} at most 200 ft apart, 5 ft outside the edge, from end to end`, () => {
      // spacing as generated: OpenStreetMap's positions move some by up to 5 m
      const fix = generatedOnly.lights.filter((l) => l.kind === 'edge' && l.runway === r.id && l.end === r.ends[0]);
      for (const side of [-1, 1]) {
        const s = fix.filter((l) => Math.sign(r.local(l.x, l.y).t) === side).map((l) => r.local(l.x, l.y));
        s.sort((a, b) => a.s - b.s);
        expect(s[0].s).toBeLessThan(1);
        expect(s[s.length - 1].s).toBeGreaterThan(r.length - 1);
        for (let i = 1; i < s.length; i++) expect(s[i].s - s[i - 1].s).toBeLessThanOrEqual(200 * FT + 0.01);
        for (const q of s) expect(Math.abs(q.t)).toBeCloseTo(r.width / 2 + 5 * FT, 6);
      }
      // OpenStreetMap's mapped position wins within 5 m
      for (const l of of((q) => q.kind === 'edge' && q.runway === r.id)) {
        expect(Math.abs(Math.abs(r.local(l.x, l.y).t) - (r.width / 2 + 5 * FT))).toBeLessThan(5);
      }
    });
  }

  it('show white, then yellow over the last 2,000 ft, toward a landing aircraft, and red in its displaced area', () => {
    const e = ends['26R'];
    const toward = of((l) => l.kind === 'edge' && l.end === '26R');
    expect(CAUTION_M).toBeCloseTo(2000 * FT, 6);
    for (const l of toward) {
      const { s } = e.local(l.x, l.y);
      const want = s < -1 ? 'red' : s > e.toFarEnd - CAUTION_M + 1 ? 'yellow' : s < e.toFarEnd - CAUTION_M - 1 ? 'white' : null;
      if (want) expect(l.colour, `s ${s.toFixed(0)}`).toBe(want);
      // they shine back toward the approach
      expect(l.dir[0] * e.L[0] + l.dir[1] * e.L[1]).toBeCloseTo(-1, 6);
    }
  });

  it('are high intensity except on 1R/19L (medium), as NASR codes them', () => {
    const hi = of((l) => l.kind === 'edge' && l.runway === '08L/26R');
    const med = of((l) => l.kind === 'edge' && l.runway === '01R/19L');
    expect(Math.max(...hi.map((l) => l.candela))).toBeGreaterThan(10 * Math.max(...med.map((l) => l.candela)));
  });
});

describe('threshold and end lights', () => {
  it('show green toward the approach at every landing threshold and red toward the runway at every pavement end', () => {
    for (const [name, e] of Object.entries(ends)) {
      const green = of((l) => l.kind === 'threshold' && l.end === name);
      expect(green.length, name).toBeGreaterThanOrEqual(8);
      for (const l of green) {
        expect(l.colour).toBe('green');
        expect(l.dir[0] * e.L[0] + l.dir[1] * e.L[1]).toBeCloseTo(-1, 6);
        expect(Math.abs(e.local(l.x, l.y).s)).toBeLessThan(5);
      }
      const red = of((l) => l.kind === 'runway-end' && l.end === name);
      expect(red.length, name).toBe(8);
      for (const l of red) {
        expect(l.colour).toBe('red');
        expect(l.dir[0] * e.L[0] + l.dir[1] * e.L[1]).toBeCloseTo(1, 6);
        expect(Math.abs(e.local(l.x, l.y).s + e.displaced)).toBeLessThan(5);
      }
    }
  });
  it('stand outboard of the edges in wing bars where the threshold is displaced', () => {
    const e = ends['19R'];
    const bars = of((l) => l.kind === 'threshold' && l.end === '19R').map((l) => e.local(l.x, l.y));
    expect(bars.every((q) => Math.abs(q.t) > e.width / 2)).toBe(true);
  });
});

describe('approach lights', () => {
  const als = (end) => of((l) => l.kind === 'approach' && l.end === end);
  const flashers = (end) => of((l) => l.kind === 'approach-flasher' && l.end === end);
  it('are generated from each end\'s system code: MALS on 26R, MALSF on 26L and 1L, none elsewhere', () => {
    expect(als('26R').length).toBe(45);
    expect(flashers('26R').length).toBe(0);
    for (const end of ['26L', '1L']) {
      expect(als(end).length).toBe(45);
      expect(flashers(end).length).toBe(3);
    }
    for (const end of ['19R', '19L', '1R', '8L', '8R']) expect(als(end).length + flashers(end).length).toBe(0);
  });
  it('form seven bars every 200 ft to 1,400 ft, the 1,000 ft bar widened, flashers on the outer three', () => {
    const e = ends['26L'];
    const bars = new Map();
    for (const l of als('26L')) {
      const { s } = e.local(l.x, l.y);
      const k = Math.round(-s / (200 * FT));
      bars.set(k, (bars.get(k) || 0) + 1);
    }
    expect([...bars.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, 5], [2, 5], [3, 5], [4, 5], [5, 15], [6, 5], [7, 5]]);
    const f = flashers('26L').map((l) => Math.round(-e.local(l.x, l.y).s / (200 * FT))).sort();
    expect(f).toEqual([5, 6, 7]);
  });
  it('agree with OpenStreetMap\'s 45 mapped lights at 1L: 35 within 5 m, the two inner bars mapped 16 ft farther out', () => {
    const r = layout.residuals.als;
    expect(r.mapped).toBe(45);
    expect(r.matched).toBe(35);
    expect(r.max).toBeLessThan(5);
  });
  it('blaze along the approach and nearly vanish from the side', () => {
    const l = als('26L')[0];
    const ahead = lobe(l, eyeOnApproach('26L', 3000));
    const e = ends['26L'];
    const [x, y] = e.toMap(-400, 1500);
    const side = lobe(l, [x, y, e.thr[2] + 150]);
    expect(ahead / side).toBeGreaterThan(50);
  });
});

describe('runway end identifier lights', () => {
  it('flash in pairs 40 ft outside the edges at the threshold where NASR lists them', () => {
    for (const [name, e] of Object.entries(ends)) {
      const reil = of((l) => l.kind === 'reil' && l.end === name);
      expect(reil.length, name).toBe(e.data.endIdentifierLights ? 2 : 0);
      for (const l of reil) {
        const q = e.local(l.x, l.y);
        expect(Math.abs(q.s)).toBeLessThan(3);
        expect(Math.abs(Math.abs(q.t) - (e.width / 2 + 40 * FT))).toBeLessThan(0.5);
        expect(l.flash.group).toBe(`reil-${name}`);
      }
    }
  });
});

describe('PAPI', () => {
  it('has four units on the left of every end, 30 ft apart, the innermost 50 ft from the edge', () => {
    for (const [name, e] of Object.entries(ends)) {
      const units = of((l) => l.kind === 'papi' && l.end === name).map((l) => ({ l, q: e.local(l.x, l.y) }));
      expect(units.length, name).toBe(4);
      units.sort((a, b) => a.l.papi.unit - b.l.papi.unit);
      units.forEach(({ l, q }, i) => {
        expect(q.t).toBeCloseTo(-(e.width / 2 + 50 * FT + i * 30 * FT), 1);
        expect(l.papi.setting).toBeCloseTo(e.data.papi.angle + PAPI_OFFSETS_DEG[i], 6);
      });
      // all four at one distance from the threshold, between 700 and 2,000 ft (8L's, past a 2,459 ft displacement on a
      // runway falling 1 %, is the farthest at 1,774 ft)
      const s = units.map((u) => u.q.s);
      expect(Math.max(...s) - Math.min(...s)).toBeLessThan(0.01);
      expect(s[0]).toBeGreaterThan(700 * FT);
      expect(s[0]).toBeLessThan(2000 * FT);
    }
  });
  it('sets 3°30′, 3°10′, 2°50′ and 2°30′ from the runway outward on a 3.00° path', () => {
    expect(PAPI_OFFSETS_DEG.map((o) => 3 + o)).toEqual([3.5, 3 + 1 / 6, 3 - 1 / 6, 2.5]);
  });

  /** The eye on a path of `angle` through the PAPI's own aim point, `dist` m before its units. */
  const eyeOnPapiPath = (name, dist, angle) => {
    const e = ends[name];
    const u = of((l) => l.kind === 'papi' && l.end === name);
    const s = e.local(u[0].x, u[0].y).s;
    const [x, y] = e.toMap(s - dist, 0);
    const z = u.reduce((a, l) => a + l.z, 0) / 4;
    return [x, y, z + dist * Math.tan(angle * DEG)];
  };
  it('shows two white and two red on its path, all white high, all red low', () => {
    for (const name of Object.keys(ends)) {
      const g = ends[name].data.papi.angle;
      expect(papiColours(layout, name, eyeOnPapiPath(name, 3000, g)), name).toEqual(['red', 'red', 'white', 'white']);
      expect(papiColours(layout, name, eyeOnPapiPath(name, 3000, g + 0.7))).toEqual(['white', 'white', 'white', 'white']);
      expect(papiColours(layout, name, eyeOnPapiPath(name, 3000, g - 0.7))).toEqual(['red', 'red', 'red', 'red']);
      expect(papiColours(layout, name, eyeOnPapiPath(name, 3000, g + 0.33))).toEqual(['red', 'white', 'white', 'white']);
    }
  });
  it('shows three red from the ILS glide path of the 26s, which crosses the threshold 24 ft under the PAPI\'s', () => {
    for (const name of ['26L', '26R']) {
      expect(papiColours(layout, name, eyeOnApproach(name, 600, 3, 60))).toEqual(['red', 'red', 'red', 'white']);
    }
  });
});

describe('centre-line and touchdown-zone lights', () => {
  it('are not generated at Las Vegas, whose record lists none', () => {
    expect(of((l) => l.kind === 'centreline' || l.kind === 'tdz').length).toBe(0);
  });
  it('are generated where the record lists them, with the standard colour coding', () => {
    const d2 = structuredClone(data);
    d2.ends['26L'].centerlineLights = true;
    d2.ends['8R'].centerlineLights = true;
    d2.ends['26L'].tdzLights = true;
    const lay = layoutLights(d2, { heightAt });
    const e = ends['26L'];
    const cl = lay.lights.filter((l) => l.kind === 'centreline' && l.end === '26L').map((l) => ({ l, s: e.local(l.x, l.y).s }));
    cl.sort((a, b) => a.s - b.s);
    for (let i = 1; i < cl.length; i++) expect(cl[i].s - cl[i - 1].s).toBeCloseTo(50 * FT, 1);
    const far = e.toFarEnd;
    for (const { l, s } of cl) {
      if (far - s < 1000 * FT - 1) expect(l.colour).toBe('red');
      else if (far - s > 3000 * FT + 1) expect(l.colour).toBe('white');
    }
    expect(new Set(cl.filter(({ s }) => far - s > 1000 * FT + 1 && far - s < 3000 * FT - 1).map(({ l }) => l.colour))).toEqual(new Set(['red', 'white']));
    const tdz = lay.lights.filter((l) => l.kind === 'tdz' && l.end === '26L').map((l) => e.local(l.x, l.y));
    // barrettes of three each side every 100 ft from 100 ft to 3,000 ft
    expect(tdz.length).toBe(30 * 6);
    expect(Math.max(...tdz.map((q) => q.s))).toBeLessThanOrEqual(3000 * FT + 0.01);
    expect(lay.lights.filter((l) => l.kind === 'tdz' && l.end !== '26L').length).toBe(0);
  });
});

describe('taxiway lights', () => {
  it('are blue at the edges and green on the centre lines, mapped by OpenStreetMap or generated along its centre lines', () => {
    const edge = of((l) => l.kind === 'taxi-edge');
    const centre = of((l) => l.kind === 'taxi-centre');
    expect(edge.every((l) => l.colour === 'blue')).toBe(true);
    expect(centre.filter((l) => l.colour === 'green').length).toBe(156 + 66);
    expect(of((l) => l.kind === 'taxi-edge' && l.source === 'osm').length).toBe(630);
    expect(of((l) => l.kind === 'taxi-edge' && l.source === 'generated').length).toBeGreaterThan(500);
  });
  it('generated ones stand within 4 m of the pavement and never on a runway', () => {
    for (const l of of((q) => q.kind === 'taxi-edge' && q.source === 'generated')) {
      expect(layout.pavement.on(l.x, l.y, 4)).toBe(true);
      for (const r of runways) {
        const q = r.local(l.x, l.y);
        const onRunway = q.s > -30 && q.s < r.length + 30 && Math.abs(q.t) < r.width / 2 + 10;
        expect(onRunway).toBe(false);
      }
    }
  });
});

describe('beacon and floodlights', () => {
  it('has the beacon on the tower, one white and one green lamp', () => {
    const b = of((l) => l.kind === 'beacon');
    expect(b.map((l) => l.colour).sort()).toEqual(['green', 'white']);
    for (const l of b) {
      expect(l.x).toBeCloseTo(data.beacon.x, 1);
      expect(l.z).toBeCloseTo(data.beacon.z, 1);
    }
  });
  it('puts apron floodlight masts along the aprons\' outer edges about every 70 m', () => {
    const f = of((l) => l.kind === 'flood');
    expect(f.length).toBeGreaterThan(100);
    for (const l of f) expect(layout.pavement.on(l.x, l.y, 6)).toBe(true);
  });
});

describe('the whole field', () => {
  it('stays within section 9.1\'s "about 6,000 light points"', () => {
    expect(layout.lights.length).toBeLessThan(6500);
    expect(layout.lights.length).toBeGreaterThan(2500);
  });
  it('reports how far OpenStreetMap\'s mapped lights are from the generated ones, and never moves one more than 5 m', () => {
    for (const k of ['rwe', 'rwt', 'als']) {
      expect(layout.residuals[k].matched, k).toBeGreaterThan(0);
      expect(layout.residuals[k].max, k).toBeLessThan(5);
    }
    // the PAPI is sited from NASR (angle, crossing height, the runway's slope) and not moved; OpenStreetMap's one node
    // per bar lies within 40 m of every generated bar's middle
    expect(layout.residuals.papi.matched).toBe(8);
    expect(layout.residuals.papi.max).toBeLessThan(40);
  });
  it('gives every light a finite position, a colour, a slot and positive candela', () => {
    for (const l of layout.lights) {
      expect(Number.isFinite(l.x + l.y + l.z)).toBe(true);
      expect(l.candela).toBeGreaterThan(0);
      expect(layout.slots[l.slot]).toBeDefined();
    }
  });
});

describe('intensity steps', () => {
  it('uses the middle step at night, the top step in low visibility, and only the PAPI by day', () => {
    const n = levelsFor({ night: true }), d = levelsFor({ night: false }), lv = levelsFor({ night: true, visibilityM: 3000 });
    expect(n.edge).toBeGreaterThan(0);
    expect(n.edge).toBeLessThan(0.2);
    expect(lv.edge).toBe(1);
    expect(d.edge).toBe(0);
    expect(d.papi).toBe(1);
  });
});

/** Rising edges through half of the peak of the brightest flashing light, over [t0, t1). */
function flashCount(seq, visible, t0, t1, dt = 1 / 240) {
  const out = [];
  let prev = 0;
  for (let t = t0; t < t1; t += dt) {
    const lv = seq.update(t, visible, false);
    const m = Math.max(0, ...lv);
    if (m >= 0.5 && prev < 0.5) out.push(t);
    prev = m;
  }
  return out;
}
const maxInAnySecond = (times) => {
  let worst = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j] < times[i] + 1; j++) n++;
    worst = Math.max(worst, n);
  }
  return worst;
};

describe('flashing', () => {
  it('lists the flashing systems: two MALSF runs, four REIL pairs and the two-colour beacon', () => {
    expect(layout.groups.map((g) => g.id).sort()).toEqual(['beacon-green', 'beacon-white', 'malsf-1L', 'malsf-26L', 'reil-19L', 'reil-19R', 'reil-1R', 'reil-8R'].sort());
    const b = layout.groups.filter((g) => g.id.startsWith('beacon'));
    // 24 to 30 flashes a minute between the two colours
    const perMin = b.reduce((s, g) => s + g.ratePerS * 60, 0);
    expect(perMin).toBeGreaterThanOrEqual(24);
    expect(perMin).toBeLessThanOrEqual(30);
  });
  it('never flashes more than three times a second in total, from anywhere, whatever is in view', () => {
    const seq = createFlashSequencer(layout);
    const eyes = [eyeOnApproach('19R', 5000), eyeOnApproach('26L', 5000), eyeOnApproach('1L', 3000), [2400, -3300, 3000]];
    for (const eye of eyes) {
      const vis = layout.groups.map((g) => groupVisible(layout, g, eye));
      expect(maxInAnySecond(flashCount(seq, vis, 0, 12))).toBeLessThanOrEqual(MAX_FLASHES_PER_S);
    }
    // and all of them at once
    const all = layout.groups.map(() => true);
    expect(maxInAnySecond(flashCount(seq, all, 100, 112))).toBeLessThanOrEqual(MAX_FLASHES_PER_S);
  });
  it('holds the limit while what is in view changes', () => {
    const seq = createFlashSequencer(layout);
    const out = [];
    let prev = 0;
    for (let t = 0; t < 20; t += 1 / 240) {
      const vis = layout.groups.map((g, i) => ((Math.floor(t * 1.7) + i) % 3) !== 0);
      const m = Math.max(0, ...seq.update(t, vis, false));
      if (m >= 0.5 && prev < 0.5) out.push(t);
      prev = m;
    }
    expect(maxInAnySecond(out)).toBeLessThanOrEqual(MAX_FLASHES_PER_S);
  });
  it('runs the 26L flashers at their real twice a second when they and the beacon are all that is in view', () => {
    const seq = createFlashSequencer(layout);
    const vis = layout.groups.map((g) => g.id === 'malsf-26L' || g.id.startsWith('beacon'));
    const times = flashCount(seq, vis, 0, 30);
    expect(times.length / 30).toBeCloseTo(2 + 27 / 60, 0);
  });
  it('the 26L flashers fire in sequence toward the threshold', () => {
    const seq = createFlashSequencer(layout);
    const g = layout.groups.find((x) => x.id === 'malsf-26L');
    const vis = layout.groups.map((x) => x === g);
    const first = [null, null, null];
    for (let t = 0; t < 1; t += 1 / 960) {
      const lv = seq.update(t, vis, false);
      g.slots.forEach((slot, k) => { if (first[k] === null && lv[seq.index(slot)] > 0.5) first[k] = t; });
    }
    expect(first[0]).toBeLessThan(first[1]);
    expect(first[1]).toBeLessThan(first[2]);
  });
  it('burns steady and dim under reduced motion', () => {
    const seq = createFlashSequencer(layout);
    const all = layout.groups.map(() => true);
    for (let t = 0; t < 3; t += 0.01) for (const v of seq.update(t, all, true)) expect(v).toBeCloseTo(STEADY_DIM, 6);
  });
});
