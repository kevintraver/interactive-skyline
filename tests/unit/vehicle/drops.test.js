// Drops on the windshield (plan 02, D8.2), through the JavaScript mirror of the GPU's rules (drops.js): the arrival
// rate against the rain rate x the glass's projected area along the relative wind, the hashed process's own count,
// running up the glass at speed and down at rest, the wipers clearing what they sweep, determinism across seeks, and
// nothing when dry.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DROP, glassOf, projectedArea, arrivalRate, runSpeed, siteLayout, siteArrivals, createBinWindow, evalSite, glassDrops, hash3,
} from '../../../src/drive/vehicle/drops.js';
import { wiperSchedule, wipePhase, passAgoAt } from '../../../src/drive/vehicle/wipers.js';
import { WIPERS } from '../../../src/drive/vehicle/veil.js';
import { relativeRain, CLASS_SPEED } from '../../../src/drive/weather/rainMirror.js';
import { weatherFor } from '../../../src/drive/env.js';

const meta = JSON.parse(readFileSync(new URL('../../../public/models/drive/cabin.json', import.meta.url), 'utf8'));
const glass = glassOf(meta.windshield.corners);
const T0 = Date.parse('2026-11-22T02:30:00Z') / 1000;
/** A car heading north (scene -z) on level ground at speed v (m/s). */
const poseAt = (v) => ({ forward: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, speed: v });

/** The glass's state at simulation time t for rain R and a constant speed v. */
function world({ R, v, siteM = 0.02 }) {
  const state = weatherFor(R);
  const layout = siteLayout(glass, siteM);
  const rel = relativeRain(state, poseAt(v));
  const lambda = (arrivalRate(R, rel.velocityCar, glass, rel.fallMps) * DROP.BIN_S) / layout.count;
  const win = createBinWindow(() => ({ lambda, vy: runSpeed(v) }));
  const sched = wiperSchedule(R);
  const at = (t) => ({ layout, win: { ...win.at(t, 'k'), data: win.at(t, 'k').data.slice() }, wipe: { phase: wipePhase(t, sched), sched }, wipers: WIPERS });
  return { state, layout, lambda, at, sched, rel };
}

describe('the glass', () => {
  it('is the windshield opening: 1.665 m wide, 0.82 m up the glass, raked 36 degrees from the horizontal', () => {
    expect(glass.W).toBeCloseTo(1.665, 3);
    expect(glass.H).toBeCloseTo(0.818, 3); // along the slanted side edge
    expect(glass.area).toBeCloseTo(((1.665 + 1.545) / 2) * 0.816, 3);
    const rake = (Math.atan2(glass.normalCar[2], glass.normalCar[1]) * 180) / Math.PI;
    expect(rake).toBeCloseTo(36, 0);
  });
});

describe('the arrival rate', () => {
  const rates = [0.5, 1, 4, 12, 30];
  const speeds = [0, 5, 13.4, 22, 31.3, 36];
  it('is proportional to rain rate x projected area along the relative wind (x relative speed / fall speed), within 20%', () => {
    let k0 = null;
    for (const R of rates) {
      for (const v of speeds) {
        const rel = relativeRain(weatherFor(R), poseAt(v));
        const model = R * projectedArea(glass, rel.velocityCar) * (rel.speedMps / CLASS_SPEED[2]);
        const rate = arrivalRate(R, rel.velocityCar, glass, rel.fallMps);
        const k = rate / model;
        k0 ??= k;
        expect(k / k0, `R ${R} v ${v}`).toBeGreaterThan(0.8);
        expect(k / k0, `R ${R} v ${v}`).toBeLessThan(1.2);
      }
    }
    // and in absolute terms it is the water the glass meets, in 2 mm drops: 1 mm/h standing still is some tens a second
    const still = arrivalRate(1, relativeRain(weatherFor(1), poseAt(0)).velocityCar, glass, CLASS_SPEED[2]);
    expect(still).toBeGreaterThan(20);
    expect(still).toBeLessThan(80);
  });

  it('more at speed: about 4 to 5 times at 108 km/h than standing, in still air', () => {
    const r = (v) => arrivalRate(4, relativeRain(weatherFor(4, { windMps: 0 }), poseAt(v)).velocityCar, glass, CLASS_SPEED[2]);
    expect(r(30) / r(0)).toBeGreaterThan(3.5);
    expect(r(30) / r(0)).toBeLessThan(6);
    expect(r(20)).toBeGreaterThan(r(10));
  });

  it('the hashed process delivers that rate (counted over all sites and two minutes), within 20%', () => {
    for (const R of [1, 4, 12]) {
      for (const v of [0, 13.4, 31.3]) {
        const { layout, lambda } = world({ R, v });
        const k0 = Math.floor(T0 / DROP.BIN_S), nb = 240;
        let n = 0;
        for (let i = 0; i < layout.count; i++) for (let k = k0; k < k0 + nb; k++) n += siteArrivals(i, k >>> 0, lambda).n;
        const measured = n / (nb * DROP.BIN_S);
        const rel = relativeRain(weatherFor(R), poseAt(v));
        const expected = arrivalRate(R, rel.velocityCar, glass, rel.fallMps);
        expect(measured / expected, `R ${R} v ${v}`).toBeGreaterThan(0.8);
        expect(measured / expected, `R ${R} v ${v}`).toBeLessThan(1.2);
      }
    }
  });

  it('the hash is uniform', () => {
    let s = 0, s2 = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) { const h = hash3(i, 3600000000 + i, 1); s += h; s2 += h * h; }
    expect(s / N).toBeCloseTo(0.5, 1);
    expect(s2 / N - (s / N) ** 2).toBeCloseTo(1 / 12, 2);
  });
});

describe('motion', () => {
  it('runners go down at rest and up above about 60 km/h', () => {
    expect(runSpeed(0)).toBeLessThan(0);
    expect(runSpeed(10)).toBeLessThan(0);
    expect(Math.abs(runSpeed(60 / 3.6))).toBeLessThan(1e-9);
    expect(runSpeed(31.3)).toBeGreaterThan(0);
  });

  it('on the glass: at 70 mph the runners have moved up from where they started, standing still down', () => {
    const climb = (v) => {
      const w = world({ R: 4, v });
      const ds = glassDrops(w.at(T0 + 30)).filter((d) => d.kind === 'run');
      return ds.map((d) => d.dir[1]);
    };
    const fast = climb(31.3), still = climb(0);
    expect(fast.length).toBeGreaterThan(10);
    expect(fast.every((y) => y > 0)).toBe(true);
    expect(still.every((y) => y < 0)).toBe(true);
  });

  it('drops grow as they merge and run at speed sooner than standing', () => {
    const fast = glassDrops(world({ R: 12, v: 31.3 }).at(T0 + 30));
    const still = glassDrops(world({ R: 12, v: 0 }).at(T0 + 30));
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const sitN = (ds) => mean(ds.filter((d) => d.kind === 'sit').map((d) => d.n));
    expect(sitN(still)).toBeGreaterThan(sitN(fast));
    expect(Math.max(...still.map((d) => d.r))).toBeGreaterThan(DROP.R0_M * DROP.SIZE_GAIN * 1.5);
  });
});

describe('the wipers clear what they sweep', () => {
  const w = world({ R: 4, v: 20 });
  const sched = w.sched;
  /** The next time after t at which a blade passes (x, y). */
  const nextPass = (x, y, t) => {
    const ago = passAgoAt(x, y, wipePhase(t, sched), sched, WIPERS);
    for (let d = 0.002; d < 3; d += 0.002) {
      const a = passAgoAt(x, y, wipePhase(t + d, sched), sched, WIPERS);
      if (a < ago + d - 1e-6) return t + d - a;
    }
    return Infinity;
  };

  it('a sitting drop inside the swept area dies at the next pass; one outside lives on', () => {
    let tested = 0, outside = 0;
    for (const t of [T0 + 20.11, T0 + 21.37, T0 + 25.9]) {
      const S = w.at(t);
      for (const d of glassDrops(S).filter((x) => x.kind === 'sit')) {
        const ago = passAgoAt(d.x, d.y, S.wipe.phase, sched, WIPERS);
        if (Number.isFinite(ago)) {
          if (tested > 60) continue;
          const tp = nextPass(d.x, d.y, t);
          const before = w.at(tp - 0.01), after = w.at(tp + 0.01);
          // born counts from the window's start, which moves: compare by place and absolute birth time
          const abs = (S2, e) => e && S2.win.k0 * DROP.BIN_S + e.born;
          const bornAbs = S.win.k0 * DROP.BIN_S + d.born;
          const find = (S2) => evalSite(d.site, S2).find((e) => e.kind === 'sit' && Math.abs(abs(S2, e) - bornAbs) < 1e-6);
          if (!find(before)) continue; // it ran before the blade came
          expect(find(after), `site ${d.site} after the pass`).toBeFalsy();
          tested++;
        } else if (outside < 40) {
          const tp = t + sched.periodS; // a full cycle later: every swept point has been passed
          const bornAbs = S.win.k0 * DROP.BIN_S + d.born;
          const S2 = w.at(tp);
          const renew = evalSite(d.site, S2).find((e) => e.kind === 'sit');
          // still there (bigger or the same) unless it ran or its site renewed in between
          if (renew) {
            const abs2 = S2.win.k0 * DROP.BIN_S + renew.born;
            if (Math.abs(abs2 - bornAbs) < 1e-6) { expect(renew.n).toBeGreaterThanOrEqual(d.n); outside++; }
          }
        }
      }
    }
    expect(tested).toBeGreaterThan(20);
    expect(outside).toBeGreaterThan(10);
  });

  it('just after a pass the swept glass is nearly clear, outside it is not', () => {
    const S = w.at(T0 + 40);
    const ds = glassDrops(S);
    const swept = ds.filter((d) => Number.isFinite(passAgoAt(d.x, d.y, S.wipe.phase, sched, WIPERS)));
    for (const d of swept) expect(passAgoAt(d.x, d.y, S.wipe.phase, sched, WIPERS)).toBeGreaterThan(S.win.tw - d.born - 1e-9);
    expect(ds.length - swept.length).toBeGreaterThan(50);
  });
});

describe('determinism', () => {
  const key = (ds) => ds.map((d) => `${d.site}:${d.kind}:${d.x.toFixed(6)},${d.y.toFixed(6)}:${d.r.toFixed(6)}:${d.alpha.toFixed(4)}`).join('|');
  it('the same time gives the same drops after seeking away and back, forward and backward', () => {
    const R = 12;
    const layout = siteLayout(glass, 0.02);
    // a speed that varies with time, as a journey's does: the source is a pure function of the bin
    let calls = 0;
    const source = (k) => { calls++; const v = 15 + 12 * Math.sin(k * 0.05); const rel = relativeRain(weatherFor(R), poseAt(v)); return { lambda: (arrivalRate(R, rel.velocityCar, glass, rel.fallMps) * DROP.BIN_S) / layout.count, vy: runSpeed(v) }; };
    const win = createBinWindow(source);
    const sched = wiperSchedule(R);
    const at = (t) => { const w = win.at(t, 'one'); return glassDrops({ layout, win: { ...w, data: w.data.slice() }, wipe: { phase: wipePhase(t, sched), sched }, wipers: WIPERS }); };
    const t = T0 + 123.456;
    const first = key(at(t));
    expect(first.length).toBeGreaterThan(0);
    at(t + 1000); // away, forward
    expect(key(at(t))).toBe(first);
    at(t - 3600); // away, backward
    expect(key(at(t))).toBe(first);
    for (let k = 0; k < 50; k++) at(t - 5 + k * 0.1); // played up to it
    expect(key(at(t))).toBe(first);
    // and a fresh window (an empty cache) agrees
    const fresh = createBinWindow(source).at(t, 'x');
    expect(key(glassDrops({ layout, win: { ...fresh, data: fresh.data.slice() }, wipe: { phase: wipePhase(t, sched), sched }, wipers: WIPERS }))).toBe(first);
    expect(calls).toBeGreaterThan(0);
  });
});

describe('dry', () => {
  it('no arrivals, no drops, wipers off', () => {
    const w = world({ R: 0, v: 30 });
    expect(w.lambda).toBe(0);
    expect(glassDrops(w.at(T0 + 50))).toEqual([]);
    expect(w.sched.mode).toBe('off');
  });
});
