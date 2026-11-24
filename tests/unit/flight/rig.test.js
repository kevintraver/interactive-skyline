// The rig (plan 03, sections 7.8 and 8.2; F3.4): channel values to part transforms from the real rig.json, and the
// wing's flex. Every part at every row of its table equals the table; between rows it interpolates; the spoilers take
// the larger of their two angles; both wings move alike; flex is zero at the root.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  sampleTable, partPose, rigPoses, channelsOf, flexShape, flexTip, spanFraction, groundPitchCorrection,
} from '../../../src/flight/aircraft/rig.js';

const rig = JSON.parse(readFileSync(new URL('../../../public/models/aircraft/rig.json', import.meta.url), 'utf8'));
const part = (node) => rig.parts.find((p) => p.node === node);
const DETENTS = [0, 1, 2, 5, 10, 15, 25, 30, 40];
const clean = { flap: 0, slat: 0, gear: 0, speedbrake: 0, groundSpoiler: 0, reverser: 0, aileron: 0 };

describe('sampleTable', () => {
  const rows = [{ at: 0, t: [0, 0, 0], r: 0 }, { at: 1, t: [0, -0.1, 0.2], r: 10 }, { at: 5, t: [0, -0.5, 1], r: 30 }];
  it('returns a row exactly at its value', () => {
    expect(sampleTable(rows, 1)).toEqual({ t: [0, -0.1, 0.2], r: 10 });
    expect(sampleTable(rows, 5)).toEqual({ t: [0, -0.5, 1], r: 30 });
  });
  it('interpolates linearly between rows', () => {
    const p = sampleTable(rows, 3);
    expect(p.r).toBeCloseTo(20, 10);
    expect(p.t[1]).toBeCloseTo(-0.3, 10);
    expect(p.t[2]).toBeCloseTo(0.6, 10);
  });
  it('holds the end rows beyond the table, and treats a missing value as the first row', () => {
    expect(sampleTable(rows, -2)).toEqual({ t: [0, 0, 0], r: 0 });
    expect(sampleTable(rows, 9)).toEqual({ t: [0, -0.5, 1], r: 30 });
    expect(sampleTable(rows, NaN)).toEqual({ t: [0, 0, 0], r: 0 });
  });
});

describe('rig.json, every part at every row of its table', () => {
  it('has 39 moving parts, each with a unit axis and at least one table', () => {
    expect(rig.parts.length).toBe(39);
    for (const p of rig.parts) {
      expect(Math.hypot(...p.axis), p.node).toBeCloseTo(1, 4);
      expect(Object.keys(p.tables).length, p.node).toBeGreaterThan(0);
    }
  });

  it('gives each row exactly, through the state channels', () => {
    for (const p of rig.parts) {
      for (const [channel, rows] of Object.entries(p.tables)) {
        for (const row of rows) {
          const ch = { ...clean, [channel]: row.at };
          const pose = partPose(p, ch);
          // the other table of a spoiler is at 0, so the row's own angle is the larger
          expect(pose.r, `${p.node} ${channel} ${row.at}`).toBeCloseTo(row.r, 9);
          pose.t.forEach((v, i) => expect(v, `${p.node} ${channel} ${row.at} t${i}`).toBeCloseTo(row.t[i], 9));
        }
      }
    }
  });

  it('moves the main flaps at every detent, further each time, and the aft flaps from 10', () => {
    let last = -1;
    for (const f of DETENTS) {
      const pose = partPose(part('FlapInboard_R'), { ...clean, flap: f });
      expect(pose.r).toBeGreaterThanOrEqual(last);
      if (f > 0) expect(pose.r).toBeGreaterThan(0);
      last = pose.r;
      const aft = partPose(part('FlapInboardAft_R'), { ...clean, flap: f });
      if (f < 10) expect(aft.r).toBe(0); else expect(aft.r).toBeGreaterThan(0);
    }
    expect(partPose(part('FlapInboard_R'), { ...clean, flap: 40 }).r).toBe(30);
    expect(partPose(part('FlapOutboard_L'), { ...clean, flap: 15 }).r).toBe(11);
    // 7.5 lever units is halfway between 5 and 10
    expect(partPose(part('FlapInboard_R'), { ...clean, flap: 7.5 }).r).toBeCloseTo(6.5, 9);
  });

  it('extends the slats at 1 and fully at 2; the Krueger flaps open at 1 and stay', () => {
    const s0 = partPose(part('Slat1_R'), { ...clean, slat: 0 });
    const s1 = partPose(part('Slat1_R'), { ...clean, slat: 1 });
    const s2 = partPose(part('Slat1_R'), { ...clean, slat: 2 });
    expect(s0.r).toBe(0);
    expect(s1.r).toBeGreaterThan(0);
    expect(s2.r).toBeGreaterThan(s1.r);
    expect(s2.t[2]).toBeLessThan(s1.t[2]); // forward (-Z) further at full extend
    const k1 = partPose(part('Krueger1_L'), { ...clean, slat: 1 }), k2 = partPose(part('Krueger1_L'), { ...clean, slat: 2 });
    expect(k1.r).toBe(115);
    expect(k2.r).toBe(115);
  });

  it('retracts the gear up at 0 and down at 1', () => {
    for (const n of ['MainGear_L', 'MainGear_R', 'NoseGear']) {
      expect(partPose(part(n), { ...clean, gear: 1 }).r).toBe(0);
      expect(partPose(part(n), { ...clean, gear: 0 }).r).toBeGreaterThan(80);
    }
  });

  it('raises spoilers by the larger of the speed brake and ground spoiler angles', () => {
    const p = part('Spoiler3_R');
    const sb = partPose(p, { ...clean, speedbrake: 1 }).r;
    const gs = partPose(p, { ...clean, groundSpoiler: 1 }).r;
    expect(sb).toBeGreaterThan(0);
    expect(gs).toBeGreaterThan(sb);
    expect(partPose(p, { ...clean, speedbrake: 1, groundSpoiler: 1 }).r).toBe(gs);
    expect(partPose(p, { ...clean, speedbrake: 1, groundSpoiler: 0.2 }).r).toBe(sb);
    // the ground-only panels stay down with the speed brake in flight
    expect(partPose(part('Spoiler1_R'), { ...clean, speedbrake: 1 }).r).toBe(0);
    expect(partPose(part('Spoiler6_L'), { ...clean, groundSpoiler: 1 }).r).toBe(60);
  });

  it('opens the reverser sleeves aft', () => {
    for (const n of ['ReverserSleeve_L', 'ReverserSleeve_R']) {
      const pose = partPose(part(n), { ...clean, reverser: 1 });
      expect(pose.t[2]).toBeGreaterThan(0.5);
      expect(partPose(part(n), clean).t).toEqual([0, 0, 0]);
    }
  });

  it('moves both wings from one table: the left side is the right mirrored', () => {
    for (const p of rig.parts.filter((x) => x.node.endsWith('_R'))) {
      const l = part(p.node.replace(/_R$/, '_L'));
      expect(l, p.node).toBeTruthy();
      expect(l.tables).toEqual(p.tables);
      // a mirror in x maps a point (x, y, z) to (-x, y, z) and a rotation axis to (x, -y, -z)
      expect(l.pivot[0]).toBeCloseTo(-p.pivot[0], 6);
      expect(l.pivot[1]).toBeCloseTo(p.pivot[1], 6);
      expect(l.pivot[2]).toBeCloseTo(p.pivot[2], 6);
      if (p.node.startsWith('Reverser')) continue; // it only slides: its axis is unused
      expect(l.axis[0]).toBeCloseTo(p.axis[0], 6);
      expect(l.axis[1]).toBeCloseTo(-p.axis[1], 6);
      expect(l.axis[2]).toBeCloseTo(-p.axis[2], 6);
    }
  });
});

describe('rigPoses', () => {
  it('poses every part from an AircraftState, the aileron at rest', () => {
    const poses = rigPoses(rig, { flap: 30, slat: 2, gear: 1, speedbrake: 0, groundSpoiler: 1, reverser: 1 });
    expect(poses.size).toBe(39);
    expect(poses.get('FlapInboard_R').r).toBe(24);
    expect(poses.get('Spoiler6_R').r).toBe(60);
    expect(poses.get('Aileron_L').r).toBe(0);
    expect(poses.get('MainGear_R').r).toBe(0);
    expect(poses.get('ReverserSleeve_R').t[2]).toBeCloseTo(0.62, 9);
  });

  it('reuses the map it is given', () => {
    const out = new Map();
    const a = rigPoses(rig, clean, out);
    expect(a).toBe(out);
    const first = out.get('Slat2_L');
    rigPoses(rig, { ...clean, slat: 2 }, out);
    expect(out.get('Slat2_L')).toBe(first);
    expect(first.r).toBe(24);
  });

  it('reads missing channels as their rest value, and a slat channel from the flap when there is none', () => {
    const ch = channelsOf({ flap: 15 }, rig);
    expect(ch.slat).toBe(2);
    expect(ch.gear).toBe(0);
    expect(channelsOf({ flap: 1 }, rig).slat).toBe(1);
    expect(channelsOf({ flap: 0 }, rig).slat).toBe(0);
    expect(channelsOf({ flap: 15, slat: 1 }, rig).slat).toBe(1);
  });
});

describe('flex', () => {
  it('is zero at the root, the tip deflection at the tip, and smooth and rising between', () => {
    expect(flexShape(0)).toBe(0);
    expect(flexShape(1)).toBeCloseTo(1, 12);
    let last = 0;
    for (let e = 0.05; e <= 1.0001; e += 0.05) { const w = flexShape(e); expect(w).toBeGreaterThan(last); last = w; }
    // zero slope at the root: a cantilever
    expect(flexShape(1e-4) / 1e-4).toBeLessThan(1e-3);
    expect(flexShape(-0.3)).toBe(0);
    expect(flexShape(1.4)).toBeCloseTo(1, 12);
  });

  it('measures the span from the root to the tip of rig.json', () => {
    expect(spanFraction(rig.flex.rootY, rig)).toBe(0);
    expect(spanFraction(-rig.flex.rootY, rig)).toBe(0);
    expect(spanFraction(rig.flex.tipY, rig)).toBeCloseTo(1, 12);
    expect(spanFraction(-rig.flex.tipY, rig)).toBeCloseTo(1, 12);
    expect(spanFraction(0.5, rig)).toBe(0);
  });

  const cruise = { onGround: false, roll: 0, ias: 130, groundSpoiler: 0, turbulence: 0 };
  it('bends the tip up by the 1 g deflection in level flight, more in a turn', () => {
    expect(flexTip(cruise, rig, 0)).toBeCloseTo(rig.flex.tipDeflection1g, 9);
    const turn = flexTip({ ...cruise, roll: (30 * Math.PI) / 180 }, rig, 0);
    expect(turn).toBeCloseTo(rig.flex.tipDeflection1g / Math.cos((30 * Math.PI) / 180), 9);
  });

  it('drops the tip when the ground spoilers rise at touchdown', () => {
    const td = { onGround: true, roll: 0, ias: 70, groundSpoiler: 0, turbulence: 0 };
    const before = flexTip(td, rig, 0);
    const after = flexTip({ ...td, groundSpoiler: 1 }, rig, 0);
    expect(before).toBeGreaterThan(0.4);
    expect(after).toBeLessThan(before * 0.3);
    // parked: the wing rests on its own shape, which is the model's
    expect(flexTip({ ...td, ias: 0, groundSpoiler: 1 }, rig, 0)).toBeCloseTo(0, 9);
  });

  it('shakes with turbulence on presentation time, not at all under reduced motion', () => {
    const bumpy = { ...cruise, turbulence: 1 };
    const values = Array.from({ length: 40 }, (_, i) => flexTip(bumpy, rig, i * 0.037));
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread).toBeGreaterThan(0.02);
    expect(spread).toBeLessThan(0.3);
    for (let i = 0; i < 10; i++) expect(flexTip(bumpy, rig, i * 0.1, { reducedMotion: true })).toBeCloseTo(rig.flex.tipDeflection1g, 9);
    for (let i = 0; i < 10; i++) expect(flexTip(bumpy, rig, i * 0.1, { shake: false })).toBeCloseTo(rig.flex.tipDeflection1g, 9);
    // a pure function of its inputs
    expect(flexTip(bumpy, rig, 1.234)).toBe(flexTip(bumpy, rig, 1.234));
  });
});

describe('groundPitchCorrection', () => {
  const g = rig.groundPitchDeg * (Math.PI / 180);
  it('lowers the nose onto its wheel when the track says the aircraft is level on the runway', () => {
    expect(groundPitchCorrection({ onGround: true, pitch: 0, gear: 1 }, rig)).toBeCloseTo(g, 9);
  });
  it('leaves a raised nose alone: the flare, the touchdown on the main wheels and the derotation', () => {
    const up = (2 * Math.PI) / 180;
    expect(groundPitchCorrection({ onGround: true, pitch: up, gear: 1 }, rig)).toBe(0);
    expect(groundPitchCorrection({ onGround: false, pitch: 0, gear: 1 }, rig)).toBe(0);
  });
  it('is continuous between them', () => {
    let last = groundPitchCorrection({ onGround: true, pitch: 0, gear: 1 }, rig);
    for (let d = 0.05; d <= 2; d += 0.05) {
      const c = groundPitchCorrection({ onGround: true, pitch: (d * Math.PI) / 180, gear: 1 }, rig);
      expect(Math.abs(c - last)).toBeLessThan(0.002);
      last = c;
    }
  });
});
