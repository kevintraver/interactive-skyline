// Plan 03, F1.3 and section 8.2: the baked track (skyline-flight/1) parsed and sampled. Hermite between the 1 Hz
// samples, shortest-arc angles, clamped at both ends; the city base and the curve drop applied on load.
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { Vector3 } from 'three';
import { createFrame, localUp, curveDrop, EARTH_R } from '../../../src/world/frame.js';
import { parseTrack, loadTrack, LIGHT, FORMAT } from '../../../src/flight/track.js';
import cities from '../../../data/cities.json' with { type: 'json' };
import { syntheticArrival, LAS_19R } from '../../helpers/flightTrack.js';

const frame = createFrame(cities.lv);
const DEG = Math.PI / 180;
const CHANNELS = ['x', 'n', 'h', 's', 'gs', 'vs', 'tas', 'ias', 'hdg', 'pitch', 'roll',
  'flap', 'slat', 'gear', 'speedbrake', 'groundSpoiler', 'reverser', 'lights', 'cabinLight', 'turbulence'];

/** A track in the baked format from per-sample functions of t: { header, buffer }. Missing channels are 0. */
function bake(fns, { samples = 61, dt = 1, header = {} } = {}) {
  const data = new Float32Array(CHANNELS.length * samples);
  CHANNELS.forEach((c, k) => { for (let i = 0; i < samples; i++) data[k * samples + i] = fns[c] ? fns[c](i * dt, i) : 0; });
  return {
    header: { format: FORMAT, id: 'test', recordedStart: '2025-03-15T19:00:00Z', dt, samples, channels: CHANNELS, events: [], ...header },
    buffer: data.buffer,
  };
}
const parse = (b) => parseTrack(b.header, b.buffer, { frame });

// a level left turn at 3 degrees a second, 120 m/s, 1,500 m above sea level, about a centre 20 km east of the origin:
// heading psi(t) = 180 deg + W t, velocity V (sin psi, cos psi) in (east, north), so the position is
// (20000 - (V / W) cos psi, (V / W) sin psi)
const W = -3 * DEG, V = 120, R0 = V / Math.abs(W);
const psi = (t) => Math.PI + W * t;
const turn = {
  x: (t) => 20000 - (V / W) * Math.cos(psi(t)), n: (t) => (V / W) * Math.sin(psi(t)), h: () => 1500,
  s: (t) => V * t, gs: () => V, tas: () => V, ias: () => V * 0.93,
  hdg: (t) => (((psi(t) / DEG) % 360) + 360) % 360,
  roll: () => -32.6, pitch: () => 3,
};

describe('parseTrack', () => {
  it('rejects another format and a buffer of the wrong size', () => {
    const b = bake(turn);
    expect(() => parseTrack({ ...b.header, format: 'skyline-flight/2' }, b.buffer, { frame })).toThrow(/format/);
    expect(() => parseTrack(b.header, b.buffer.slice(4), { frame })).toThrow(/size|length/);
    expect(() => parseTrack(b.header, b.buffer, {})).toThrow(/frame/);
  });

  it('gives duration, length and the header as meta', () => {
    const tr = parse(bake(turn));
    expect(tr.durationS).toBe(60);
    expect(tr.lengthM).toBeCloseTo(7200, 3);
    expect(tr.meta.id).toBe('test');
    expect(tr.recordedStartMs).toBe(Date.parse('2025-03-15T19:00:00Z'));
  });

  it('accepts a typed-array view (a Node Buffer) as well as an ArrayBuffer', () => {
    const b = bake(turn);
    const view = new Uint8Array(b.buffer);
    expect(parseTrack(b.header, view, { frame }).sample(10).position.x).toBe(parse(b).sample(10).position.x);
  });
});

describe('sampling', () => {
  it('returns the samples at sample times, in scene axes with the base and the curve drop applied', () => {
    const b = bake(turn);
    const tr = parse(b);
    for (const t of [0, 1, 17, 59, 60]) {
      const st = tr.sample(t);
      const x = Math.fround(turn.x(t)), n = Math.fround(turn.n(t));
      expect(st.position.x).toBeCloseTo(x, 6);
      expect(st.position.z).toBeCloseTo(-n, 6);
      expect(st.position.y).toBeCloseTo(1500 - 620 - curveDrop(x, n), 6);
      expect(st.altMsl).toBeCloseTo(1500, 6);
      expect(st.s).toBeCloseTo(V * t, 3);
      expect(st.heading).toBeCloseTo(Math.fround(turn.hdg(t)) * DEG, 6);
      expect(st.pitch).toBeCloseTo(3 * DEG, 6);
      expect(st.t).toBe(t);
    }
  });

  it('is continuous in position and velocity across every sample, and velocity is the rate of change of position', () => {
    const tr = parse(bake(turn));
    const a = tr.sample(0), b = tr.sample(0);
    for (let k = 1; k < 60; k++) {
      tr.sample(k - 1e-6, a); const pa = a.position.clone(), va = a.velocity.clone();
      tr.sample(k + 1e-6, b);
      expect(b.position.distanceTo(pa)).toBeLessThan(1e-3);
      expect(b.velocity.distanceTo(va)).toBeLessThan(1e-3);
    }
    for (const t of [3.3, 20.5, 41.9]) {
      const p0 = tr.sample(t - 0.001).position.clone(), p1 = tr.sample(t + 0.001).position.clone();
      const numeric = p1.sub(p0).divideScalar(0.002);
      expect(tr.sample(t).velocity.distanceTo(numeric)).toBeLessThan(1e-3);
      // and between samples the circle is held: speed within 0.5% and radius within 1 m
      const st = tr.sample(t);
      expect(Math.hypot(st.velocity.x, st.velocity.z)).toBeCloseTo(V, -0.3);
      expect(Math.abs(Math.hypot(st.position.x - 20000, st.position.z) - R0)).toBeLessThan(1);
    }
  });

  it('takes the shortest way round through north: 350 to 10 degrees passes 0, not 180', () => {
    const tr = parse(bake({ ...turn, hdg: (t) => [350, 10, 30][Math.min(2, t)] ?? 30 }, { samples: 3 }));
    expect(tr.sample(0.5).heading / DEG).toBeCloseTo(0, 0);
    const mid = tr.sample(0.25).heading / DEG;
    expect(mid > 350 || mid < 1).toBe(true);
    for (let t = 0; t <= 2; t += 0.05) {
      const h = tr.sample(t).heading;
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 * Math.PI);
    }
    // and the other way, 10 to 350
    const back = parse(bake({ ...turn, hdg: (t) => [10, 350, 330][Math.min(2, t)] ?? 330 }, { samples: 3 }));
    expect(Math.min(back.sample(0.5).heading, 2 * Math.PI - back.sample(0.5).heading) / DEG).toBeLessThan(1);
  });

  it('never puts the wheels below the runway after touchdown (a descent that ends on a flat runway)', () => {
    // sinking at 0.8 m/s onto a runway at 665 m: tangents from the neighbours would carry the descent past the kink
    const tr = parse(bake({ ...turn, h: (t) => (t < 30 ? 665 + 0.8 * (30 - t) : 665) }));
    for (let t = 25; t <= 40; t += 0.01) expect(tr.sample(t).altMsl).toBeGreaterThanOrEqual(665 - 1e-4);
    // and the climb out of a level segment does not undershoot it either
    const level = parse(bake({ ...turn, h: (t) => (t < 30 ? 3048 : 3048 + 10 * (t - 30)) }));
    for (let t = 25; t <= 35; t += 0.01) expect(level.sample(t).altMsl).toBeGreaterThanOrEqual(3048 - 1e-4);
  });

  it('keeps the wheels on an upsloping runway after touchdown (the vertical velocity breaks at the touchdown sample)', () => {
    // sinking at 0.8 m/s onto a runway that rises 0.75 m each second along the rollout, touching down at 30 s
    const surface = (t) => 640 + 0.75 * (t - 30);
    const tr = parse(bake({ ...turn, h: (t) => (t < 30 ? 640 + 0.8 * (30 - t) : surface(t)) }, { header: { touchdown: '2025-03-15T19:00:30Z' } }));
    for (let t = 30; t <= 40; t += 0.01) expect(tr.sample(t).altMsl).toBeGreaterThanOrEqual(surface(t) - 1e-3);
    for (let t = 25; t < 30; t += 0.01) expect(tr.sample(t).altMsl).toBeGreaterThanOrEqual(640 - 1e-4);
  });

  it('clamps at both ends', () => {
    const tr = parse(bake(turn));
    expect(tr.sample(-30).position.distanceTo(tr.sample(0).position)).toBe(0);
    expect(tr.sample(1e6).position.distanceTo(tr.sample(60).position)).toBe(0);
    expect(tr.sample(-30).t).toBe(0);
    expect(tr.sample(99).t).toBe(60);
    expect(Number.isFinite(tr.sample(NaN).position.x)).toBe(true);
  });

  it('reuses `out` and allocates nothing new in it', () => {
    const tr = parse(bake(turn));
    const out = tr.sample(0);
    const { position, quaternion, velocity } = out;
    expect(tr.sample(12.5, out)).toBe(out);
    expect(out.position).toBe(position);
    expect(out.quaternion).toBe(quaternion);
    expect(out.velocity).toBe(velocity);
  });

  it('builds the attitude on the level frame: a level aircraft 250 km east has up = localUp there', () => {
    const tr = parse(bake({ x: () => 250000, n: () => 0, h: () => 10668, hdg: () => 270, s: () => 0 }));
    const st = tr.sample(5);
    const up = new Vector3(0, 1, 0).applyQuaternion(st.quaternion);
    expect(up.distanceTo(localUp(st.position.x, st.position.z, new Vector3()))).toBeLessThan(1e-9);
    const nose = new Vector3(0, 0, -1).applyQuaternion(st.quaternion);
    expect(nose.x).toBeLessThan(-0.99); // heading 270 is west
  });

  it('banks with the roll channel: positive roll lowers the right wing', () => {
    const tr = parse(bake({ ...turn, roll: () => 20 }));
    const right = new Vector3(1, 0, 0).applyQuaternion(tr.sample(10).quaternion);
    expect(right.y).toBeLessThan(-0.3);
    expect(tr.sample(10).roll).toBeCloseTo(20 * DEG, 6);
  });

  it('includes the fall of the curved datum in the vertical velocity of a level aircraft', () => {
    // level at 10 km, flying east 230 m/s from 200 km east: the scene y falls at x * v / R
    const tr = parse(bake({ x: (t) => 200000 + 230 * t, n: () => 0, h: () => 10000, s: (t) => 230 * t, hdg: () => 90 }));
    const st = tr.sample(30);
    expect(st.velocity.y).toBeCloseTo(-(st.position.x * 230) / EARTH_R, 3);
    expect(st.vs).toBe(0); // the vertical-speed channel is height above sea level, unaffected
  });

  it('subtracts the wind of the atmosphere profile for the air velocity', () => {
    // wind from the west at 20 m/s (blowing east) at 1,500 m; the aircraft flies east at 120 m/s over the ground
    const tr = parse(bake({ x: (t) => 120 * t, n: () => 0, h: () => 1500, hdg: () => 90, s: (t) => 120 * t },
      { header: { atmosphere: [[600, 20, 10, 0], [2400, 5, 30, 0]] } }));
    const st = tr.sample(20);
    expect(st.airVelocity.x).toBeCloseTo(100, 3);
    expect(st.airVelocity.z).toBeCloseTo(0, 6);
    // above the top of the profile the top level holds
    const high = parse(bake({ x: (t) => 120 * t, h: () => 9000, s: (t) => 120 * t }, { header: { atmosphere: [[600, 20, 10, 0], [2400, 5, 30, 4]] } }));
    expect(high.sample(5).airVelocity.z).toBeCloseTo(4, 3); // wind toward the north is -z, so the air velocity gains +z
  });

  it('steps the light bit field, interpolates the configuration linearly, and knows when the wheels are down', () => {
    const tr = parse(bake({
      ...turn,
      lights: (t) => (t < 30 ? LIGHT.NAV | LIGHT.BEACON : LIGHT.NAV | LIGHT.BEACON | LIGHT.LANDING),
      flap: (t) => (t < 10 ? 0 : Math.min(15, t - 10)),
      gear: (t) => Math.min(1, Math.max(0, (t - 40) / 10)),
    }, { header: { touchdown: '2025-03-15T19:00:45Z' } }));
    expect(tr.sample(29.9).lights).toBe(LIGHT.NAV | LIGHT.BEACON);
    expect(tr.sample(30).lights & LIGHT.LANDING).toBeTruthy();
    expect(tr.sample(29.5).lights & LIGHT.LANDING).toBe(0);
    expect(tr.sample(12.5).flap).toBeCloseTo(2.5, 6);
    expect(tr.sample(45.25).gear).toBeCloseTo(0.525, 6);
    expect(tr.sample(44.9).onGround).toBe(false);
    expect(tr.sample(45).onGround).toBe(true);
    expect(LIGHT).toMatchObject({ NAV: 1, BEACON: 2, STROBE: 4, LANDING: 8, TAXI: 16, TURNOFF: 32, LOGO: 64, WING: 128 });
  });

  it('lists the events with their distance along the track, in time order', () => {
    const tr = parse(bake(turn, { header: { events: [{ t: 40, id: 'gear', label: 'Gear down' }, { t: 5, s: 600, id: 'tod', label: 'Top of descent' }] } }));
    expect(tr.events.map((e) => e.id)).toEqual(['tod', 'gear']);
    expect(tr.events[0].s).toBe(600);
    expect(tr.events[1].s).toBeCloseTo(4800, 3);
  });

  it('finds the time at a distance along the track (the inverse of s)', () => {
    const tr = parse(bake(turn));
    for (const t of [0, 7.25, 33.5, 60]) expect(tr.timeAtS(tr.sample(t).s)).toBeCloseTo(t, 6);
    expect(tr.timeAtS(-5)).toBe(0);
    expect(tr.timeAtS(1e9)).toBe(60);
  });
});

describe('loadTrack', () => {
  it('fetches the header and the binary beside it', async () => {
    const b = bake(turn);
    const fetch = vi.fn(async (url) => ({
      ok: true,
      json: async () => b.header,
      arrayBuffer: async () => b.buffer,
      url,
    }));
    const tr = await loadTrack('/data/lv/flights/test.json', { frame, fetch });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/data/lv/flights/test.json', '/data/lv/flights/test.bin']);
    expect(tr.sample(10).position.x).toBeCloseTo(Math.fround(turn.x(10)), 6);
  });
  it('fails with the address when a file is missing', async () => {
    const fetch = async () => ({ ok: false, status: 404 });
    await expect(loadTrack('/x/y.json', { frame, fetch })).rejects.toThrow(/y\.json.*404/);
  });
});

// The synthetic arrival that everything is developed against before the real bake (tests/helpers/flightTrack.js),
// held to the bake's own quality gates (section 7.2) so that it is a fair stand-in.
describe('the synthetic runway 19R arrival', () => {
  const full = syntheticArrival();
  const tr = parse(full);
  const { threshold: thr, headingDeg, elevationM: elev } = LAS_19R;
  const dir = [Math.sin(headingDeg * DEG), Math.cos(headingDeg * DEG)];
  /** Along-runway distance past the threshold and the offset from the centre line (right positive), map metres. */
  const runwayCoords = (st) => {
    const dx = st.position.x - thr.x, dy = -st.position.z - thr.y;
    return { along: dx * dir[0] + dy * dir[1], across: dx * dir[1] - dy * dir[0] };
  };
  const times = Array.from({ length: Math.round(tr.durationS * 4) + 1 }, (_, k) => k / 4);
  const states = times.map((t) => ({ ...tr.sample(t), position: tr.sample(t).position.clone() }));
  const touchdown = tr.events.find((e) => e.id === 'touchdown');
  // 01L/19R from public/data/lv/airport.json: [metres from the 1L end, elevation]; the 19R threshold is 2,738.9 m along
  const PROFILE = [[0, 664.83], [178.71, 663.28], [2738.9, 636.57], [2977.58, 634.69]];
  const runwayElevation = (pastThreshold) => {
    const d = 2738.9 - pastThreshold;
    const k = PROFILE.findIndex(([a], i) => i > 0 && d <= a);
    const [a0, e0] = PROFILE[k - 1], [a1, e1] = PROFILE[k];
    return e0 + ((e1 - e0) * (d - a0)) / (a1 - a0);
  };

  it('is 27 minutes from cruise to the end of the rollout, with the markers in order', () => {
    expect(tr.durationS).toBe(1620);
    expect(tr.sample(0).altMsl).toBeCloseTo(10668, -1);
    // ids as scripts/bake_flight.py writes them where the two overlap; ft1000 is the plan's '1,000 ft' marker
    expect(tr.events.map((e) => e.id)).toEqual(['cruise', 'tod', 'fl180', '10000', 'gear', 'ft1000', 'threshold', 'touchdown']);
    expect(tr.durationS - touchdown.t).toBe(60);
    expect(full.header.format).toBe('skyline-flight/1');
    expect(full.header.channels).toHaveLength(20);
  });

  it('flies a 3 degree glide path over the last 3 km to 1 km, on the runway heading', () => {
    const onFinal = states.filter((st) => { const { along } = runwayCoords(st); return along > -3000 && along < -1000; });
    const first = onFinal[0], last = onFinal[onFinal.length - 1];
    const angle = Math.atan((first.altMsl - last.altMsl) / (runwayCoords(last).along - runwayCoords(first).along)) / DEG;
    expect(Math.abs(angle - 3)).toBeLessThan(0.1);
    for (const st of onFinal) {
      expect(Math.abs(runwayCoords(st).across)).toBeLessThan(1);
      expect(Math.abs(st.heading / DEG - headingDeg)).toBeLessThan(0.5);
    }
  });

  it('crosses the threshold 12 to 32 m up and touches down 250 to 1,000 m past it, on the centre line, sinking gently', () => {
    const crossing = states.find((st, k) => k > 0 && runwayCoords(st).along >= 0);
    expect(crossing.altMsl - elev).toBeGreaterThan(12);
    expect(crossing.altMsl - elev).toBeLessThan(32);
    const td = tr.sample(touchdown.t);
    const { along, across } = runwayCoords(td);
    expect(along).toBeGreaterThan(250);
    expect(along).toBeLessThan(1000);
    expect(Math.abs(across)).toBeLessThan(8);
    expect(td.altMsl).toBeCloseTo(runwayElevation(along), 1);
    // sink towards the (sloping) runway over the last second, from the heights: the vs channel is height above sea
    // level, and it steps at the touchdown sample
    const wheels = (st) => st.altMsl - runwayElevation(runwayCoords(st).along);
    const sink = wheels(tr.sample(touchdown.t - 1)) - wheels(td);
    expect(sink).toBeGreaterThan(0.3);
    expect(sink).toBeLessThan(1.2);
    expect(td.pitch / DEG).toBeGreaterThan(4);
    expect(td.pitch / DEG).toBeLessThan(7);
    expect(td.onGround).toBe(true);
    expect(tr.sample(touchdown.t - 0.5).onGround).toBe(false);
  });

  it('rolls out on the runway surface: the NASR profile of 01L/19R, rising about 1% to the south', () => {
    expect(elev).toBeCloseTo(636.6, 1); // the 19R threshold, not the field elevation of 665 m (the 1L end)
    let n = 0;
    for (const st of states) {
      if (!st.onGround) continue;
      n++;
      expect(Math.abs(st.altMsl - runwayElevation(runwayCoords(st).along))).toBeLessThan(0.05);
    }
    expect(n).toBeGreaterThan(200);
  });

  it('turns onto final in a coordinated bank, and stays inside the attitude and deceleration gates', () => {
    let maxBank = 0, maxRollRate = 0, maxDecel = 0;
    for (let k = 1; k < states.length; k++) {
      const a = states[k - 1], b = states[k];
      maxBank = Math.max(maxBank, Math.abs(b.roll));
      maxRollRate = Math.max(maxRollRate, Math.abs(b.roll - a.roll) / 0.25);
      maxDecel = Math.max(maxDecel, (a.gs - b.gs) / 0.25);
      expect(b.pitch / DEG).toBeGreaterThan(-6);
      expect(b.pitch / DEG).toBeLessThan(12);
      expect(b.altMsl).toBeGreaterThan(elev - 0.01);
    }
    expect(maxBank / DEG).toBeGreaterThan(10); // there is a turn onto final
    expect(maxBank / DEG).toBeLessThanOrEqual(35);
    expect(maxRollRate / DEG).toBeLessThan(5);
    expect(maxDecel).toBeLessThanOrEqual(3.5);
    // the turn is to the left (from about 295 onto 205), so the bank is negative
    expect(Math.min(...states.map((st) => st.roll))).toBeLessThan(-10 * DEG);
  });

  it('never exceeds a flap placard speed, and has the gear down before the landing flap', () => {
    const PLACARD_KT = [[1, 250], [2, 250], [5, 250], [10, 210], [15, 200], [25, 190], [30, 175], [40, 162]];
    for (const st of states) {
      if (st.flap <= 0) continue;
      const limit = PLACARD_KT.find(([f]) => f >= st.flap - 1e-6)[1] * (1852 / 3600);
      expect(st.ias).toBeLessThanOrEqual(limit);
    }
    // and 250 kt below 10,000 ft
    for (const st of states) if (st.altMsl < 3048 - 1) expect(st.ias).toBeLessThanOrEqual(250 * (1852 / 3600) + 0.1);
    const landingFlap = states.find((st) => st.flap > 15.01);
    expect(landingFlap.gear).toBe(1);
    expect(tr.sample(touchdown.t).flap).toBeCloseTo(30, 3);
    // the landing lights are on below 10,000 ft, the spoilers and reversers deploy only after touchdown
    for (const st of states) {
      if (st.altMsl < 3000) expect(st.lights & LIGHT.LANDING).toBeTruthy();
      if (st.altMsl > 3100) expect(st.lights & LIGHT.LANDING).toBe(0);
      if (!st.onGround) { expect(st.groundSpoiler).toBe(0); expect(st.reverser).toBe(0); }
    }
    expect(tr.sample(touchdown.t + 5).groundSpoiler).toBe(1);
    expect(tr.sample(touchdown.t + 5).reverser).toBe(1);
    expect(tr.sample(tr.durationS).reverser).toBe(0);
  });

  it('cut to its last 10 minutes, ends exactly where the full flight ends', () => {
    const cut = parse(syntheticArrival({ durationS: 600 }));
    expect(cut.durationS).toBe(600);
    for (const dt of [0, 30, 300, 600]) {
      expect(cut.sample(600 - dt).position.distanceTo(tr.sample(1620 - dt).position)).toBeLessThan(0.01);
    }
    // it starts at the 10,000 ft level-off, a few seconds after that marker
    expect(cut.events.map((e) => e.id)).toEqual(['gear', 'ft1000', 'threshold', 'touchdown']);
    expect(cut.sample(0).altMsl).toBeGreaterThan(2500);
    expect(cut.recordedStartMs - tr.recordedStartMs).toBe(1020 * 1000);
  });
});

describe('the committed fixture tests/fixtures/flight/synthetic-19', () => {
  const dir = new URL('../../fixtures/flight/', import.meta.url);
  const header = JSON.parse(readFileSync(new URL('synthetic-19.json', dir), 'utf8'));
  const bin = readFileSync(new URL('synthetic-19.bin', dir));

  it('parses, is the last 10 minutes of the 19R arrival, and is under the 60 KB a baked flight may take', () => {
    const tr = parseTrack(header, bin, { frame });
    expect(tr.durationS).toBe(600);
    expect(header.runway).toBe('19R');
    expect(bin.byteLength + JSON.stringify(header).length).toBeLessThan(60 * 1024);
    expect(tr.events.at(-1).id).toBe('touchdown');
  });

  it('still matches the generator (rerun node tests/fixtures/flight/make_synthetic.mjs if not)', () => {
    const fresh = syntheticArrival({ durationS: 600 });
    expect(JSON.parse(JSON.stringify(fresh.header))).toEqual(header);
    const a = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4), b = new Float32Array(fresh.buffer);
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThan(1e-3);
  });
});
