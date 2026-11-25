// Plan 03, F5.3 and section 8.2's paneState.test.js: the pane's condition over a journey (frost, condensation between
// the panes, water on the outer face) as a function of the track and the air, so that scrubbing in either direction
// gives the same pane.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFrame } from '../../../src/world/frame.js';
import { parseTrack } from '../../../src/flight/track.js';
import { standardAtmosphere, recordedAir } from '../../../src/flight/env.js';
import { createPaneState, PANE, recoveryTempC, faceEquilibriumC } from '../../../src/flight/window/paneState.js';
import { syntheticArrival } from '../../helpers/flightTrack.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);
const synthetic = syntheticArrival();
const track = parseTrack(synthetic.header, synthetic.buffer, { frame });
const ev = (id) => track.events.find((e) => e.id === id).t;
const stdAir = (s) => ({ tempC: standardAtmosphere(s.altMsl).tempC, rainRateMmH: 0, inCloud: false });

/** A track-shaped object that sits still on the ground (or holds one state) for `durationS`. */
function holding(state, durationS = 600) {
  return { durationS, events: [], meta: {}, sample: (t, out = {}) => Object.assign(out, state, { t }) };
}

describe('the pane temperature model (section 7.7)', () => {
  it('recovery temperature at Mach 0.78 in the tropopause is about -33 C, at rest the static temperature', () => {
    // T_r = T_s (1 + r (gamma - 1) / 2 M^2), r = 0.9: 216.65 K x 1.1095 = 240.4 K
    expect(recoveryTempC(-56.5, 0.78)).toBeCloseTo(-32.8, 0);
    expect(recoveryTempC(20, 0)).toBe(20);
  });

  it('the inner face of the outer pane sits far nearer the outside air than the cabin at speed', () => {
    const cruise = faceEquilibriumC({ tempC: -56.5, tas: 230, densityKgM3: 0.38 });
    expect(cruise).toBeLessThan(PANE.frostPointC - 15);
    expect(cruise).toBeGreaterThan(recoveryTempC(-56.5, 230 / 295));
    // standing still on a warm day: between the air and the cabin
    const ground = faceEquilibriumC({ tempC: 30, tas: 0, densityKgM3: 1.1 });
    expect(ground).toBeGreaterThan(24);
    expect(ground).toBeLessThan(30);
  });
});

describe('createPaneState', () => {
  const pane = createPaneState(track, { airAt: stdAir });

  it('a recording that starts at cruise starts with frost from the cold soak before it', () => {
    const s = pane.at(0);
    expect(s.tFaceC).toBeLessThan(PANE.frostPointC - 10);
    expect(s.frost).toBeGreaterThan(0.3);
    expect(s.frost).toBeLessThanOrEqual(1);
  });

  it('none on the ground on a warm day', () => {
    const warm = createPaneState(holding({ altMsl: 640, tas: 0, onGround: true }, 900), { airAt: () => ({ tempC: 30, rainRateMmH: 0 }) });
    for (const t of [0, 300, 900]) {
      const s = warm.at(t);
      expect(s.frost).toBe(0);
      expect(s.fog).toBe(0);
      expect(s.tFaceC).toBeGreaterThan(20);
    }
  });

  it('frost falls monotonically through the descent once the pane warms past the frost point, and is gone well before touchdown', () => {
    // the face lags the air by PANE.tauS (3 minutes, about 6,000 ft at 2,000 ft a minute), so frost may still grow a
    // little below 18,000 ft; once it starts to retreat it never grows again on the descent
    let warm = ev('tod');
    while (pane.at(warm).tFaceC < PANE.frostPointC) warm++;
    const peak = Math.max(...Array.from({ length: Math.ceil(warm - ev('fl180')) + 1 }, (_, i) => pane.at(ev('fl180') + i).frost));
    expect(peak - pane.at(ev('fl180')).frost).toBeLessThan(0.01);
    let prev = Infinity;
    for (let t = warm; t <= track.durationS; t += 1) {
      const f = pane.at(t).frost;
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
    expect(pane.at(ev('10000')).frost).toBeLessThan(pane.at(ev('fl180')).frost);
    expect(pane.at(ev('ft1000')).frost).toBe(0);
  });

  it('the pane passes 0 C on the descent between about 18,000 and 10,000 ft on a standard day', () => {
    const crossing = (() => { for (let t = ev('tod'); t < track.durationS; t++) if (pane.at(t).tFaceC >= 0) return t; return null; })();
    expect(crossing).not.toBeNull();
    const alt = track.sample(crossing).altMsl / 0.3048;
    expect(alt).toBeLessThan(18500);
    expect(alt).toBeGreaterThan(9000);
  });

  it('identical results forwards, backwards and after a seek', () => {
    const times = Array.from({ length: 200 }, (_, i) => (i * 7.3) % track.durationS);
    const forwards = times.slice().sort((a, b) => a - b).map((t) => ({ t, s: pane.at(t) }));
    const again = createPaneState(track, { airAt: stdAir });
    const backwards = times.slice().sort((a, b) => b - a).map((t) => ({ t, s: again.at(t) }));
    for (const { t, s } of forwards) {
      const b = backwards.find((x) => x.t === t).s;
      expect(b).toEqual(s);
      expect(again.at(t)).toEqual(s);
    }
  });

  it('values between whole seconds interpolate the seconds around them', () => {
    const a = pane.at(800), b = pane.at(801), m = pane.at(800.25);
    expect(m.frost).toBeCloseTo(a.frost * 0.75 + b.frost * 0.25, 12);
    expect(m.tFaceC).toBeCloseTo(a.tFaceC * 0.75 + b.tFaceC * 0.25, 12);
  });

  it('clamps outside the journey', () => {
    expect(pane.at(-50)).toEqual(pane.at(0));
    expect(pane.at(1e9)).toEqual(pane.at(track.durationS));
  });
});

describe('water on the outer face', () => {
  const rainBetween = (a, b, mmH = 8) => (s) => ({ ...stdAir(s), rainRateMmH: s.t >= a && s.t < b ? mmH : 0 });

  it('rain wets the pane within seconds; it stays wet for a while after the rain stops, then dries', () => {
    const pane = createPaneState(track, { airAt: rainBetween(1300, 1400) });
    expect(pane.at(1290).wet).toBe(0);
    expect(pane.at(1330).wet).toBeGreaterThan(0.6);
    expect(pane.at(1330).rainRateMmH).toBe(8);
    expect(pane.at(1420).wet).toBeGreaterThan(0.1);
    expect(pane.at(1420).rainRateMmH).toBe(0);
    expect(pane.at(1560).wet).toBeLessThan(0.05);
  });

  it('heavier rain wets it more', () => {
    const light = createPaneState(track, { airAt: rainBetween(1300, 1400, 1) }).at(1350).wet;
    const heavy = createPaneState(track, { airAt: rainBetween(1300, 1400, 20) }).at(1350).wet;
    expect(heavy).toBeGreaterThan(light);
  });

  it('in cloud the pane mists over', () => {
    const pane = createPaneState(track, { airAt: (s) => ({ ...stdAir(s), inCloud: s.t >= 1000 && s.t < 1060 }) });
    expect(pane.at(990).mist).toBe(0);
    expect(pane.at(1050).mist).toBeGreaterThan(0.5);
  });

  it('liquid cloud at speed wets the outer face too, and it dries within a minute or two after leaving it', () => {
    const cloud = (a, b, tempC) => (s) => ({ ...stdAir(s), tempC: tempC ?? stdAir(s).tempC, inCloud: s.t >= a && s.t < b });
    const pane = createPaneState(track, { airAt: cloud(1300, 1400, 6) });
    expect(pane.at(1290).wet).toBe(0);
    expect(pane.at(1390).wet).toBeGreaterThan(0.2);
    expect(pane.at(1390).wet).toBeLessThanOrEqual(PANE.cloudWet + 1e-9);
    expect(pane.at(1430).wet).toBeGreaterThan(0.05);
    expect(pane.at(1560).wet).toBeLessThan(0.02);
    // below freezing the cloud's water would freeze on the glass (rime), which is not modelled: no film
    const cold = createPaneState(track, { airAt: cloud(1300, 1400, -12) });
    expect(cold.at(1390).wet).toBe(0);
    expect(cold.at(1390).mist).toBeGreaterThan(0.5);
  });

  it('rebuild() takes new air (another weather) and gives a new history', () => {
    const pane = createPaneState(track, { airAt: stdAir });
    expect(pane.at(1350).wet).toBe(0);
    pane.rebuild(rainBetween(1300, 1400));
    expect(pane.at(1350).wet).toBeGreaterThan(0.5);
  });
});

describe('condensation between the panes', () => {
  it('the melt on the descent leaves a brief film that clears again before landing', () => {
    const pane = createPaneState(track, { airAt: stdAir });
    let peak = 0, peakT = 0;
    for (let t = ev('tod'); t < track.durationS; t++) { const f = pane.at(t).fog; if (f > peak) { peak = f; peakT = t; } }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(0.8);
    expect(peakT).toBeLessThan(ev('ft1000'));
    expect(pane.at(ev('touchdown')).fog).toBeLessThan(0.02);
  });
});

describe('the as-flown weather of a recorded flight (lv-wx: the overcast at 500 ft, 1 January 2026)', () => {
  const dir = new URL('../../../public/data/lv/flights/', import.meta.url);
  const header = JSON.parse(readFileSync(new URL('lv-wx.json', dir), 'utf8'));
  const bin = readFileSync(new URL('lv-wx.bin', dir));
  const wx = parseTrack(header, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), { frame });
  const [from, to] = header.weather.inCloud.at(-1);
  const air = recordedAir(header);

  it('mists over in the cloud from its top to its base, as the record has it, and not before', () => {
    const pane = createPaneState(wx, { airAt: (s) => air.at(s.altMsl) });
    expect(pane.at(from - 30).mist).toBe(0);
    expect(pane.at(from + 30).mist).toBeGreaterThan(0.9);
    expect(pane.at(to - 10).mist).toBeGreaterThan(0.9);
    expect(pane.at(from + 30).inCloud).toBe(true);
    expect(pane.at(to + 5).inCloud).toBe(false);
    // the glass carries water out of the base: wet and still misted on short final, drying toward touchdown
    expect(pane.at(to + 10).wet).toBeGreaterThan(0.2);
    expect(pane.at(header.touchdownT).mist).toBeLessThan(pane.at(to).mist);
    expect(pane.at(header.touchdownT).rainRateMmH).toBe(0);
  });

  it('without airAt the pane reads the same record from the header', () => {
    const a = createPaneState(wx, { airAt: (s) => air.at(s.altMsl) });
    const b = createPaneState(wx);
    for (const t of [0, from + 60, to + 10, header.touchdownT]) expect(b.at(t)).toEqual(a.at(t));
  });
});

describe('the default air', () => {
  it('without airAt, temperatures come from the header atmosphere and there is no rain', () => {
    const pane = createPaneState(track);
    const s = pane.at(0);
    expect(s.frost).toBeGreaterThan(0.3);
    expect(s.rainRateMmH).toBe(0);
    expect(s.wet).toBe(0);
  });
});
