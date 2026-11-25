// The airport's shared geometry (plan 03, section 7.10; F4.2 to F4.4): runway frames from the FAA's surveyed ends, the
// pavement polygons as a point-in-pavement index, and the height everything stands on (the runway's published profile
// on the runway, the terrain away from it, eased between).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FT, runwayFrames, createPavementIndex, createHeightModel } from '../../../src/flight/airport/geometry.js';

const data = JSON.parse(readFileSync(new URL('../../../public/data/lv/airport.json', import.meta.url), 'utf8'));

describe('runway frames', () => {
  const { ends, runways } = runwayFrames(data);

  it('has every end of every runway, landing toward the other end', () => {
    expect(Object.keys(ends).sort()).toEqual(['19L', '19R', '1L', '1R', '26L', '26R', '8L', '8R']);
    expect(runways.map((r) => r.id)).toEqual(['01L/19R', '01R/19L', '08L/26R', '08R/26L']);
    // 19R lands toward 205 degrees true (204.9 grid): south-south-west
    const e = ends['19R'];
    expect(Math.atan2(e.L[0], e.L[1]) * 180 / Math.PI + 360).toBeCloseTo(204.914, 2);
    // right of the landing direction is west-north-west for 19R
    expect(e.R[0]).toBeLessThan(0);
  });

  it('puts the threshold where NASR puts it, displaced or not', () => {
    const e = ends['26R'];
    const p = e.toMap(0, 0);
    expect(p[0]).toBeCloseTo(4232.13, 1);
    expect(p[1]).toBeCloseTo(-4248.39, 1);
    // NASR publishes 1,399 ft; between the surveyed points it is 6 cm less
    expect(e.displaced).toBeCloseTo(426.42, 0);
    // the pavement end is behind the threshold by the displacement
    const q = e.toMap(-e.displaced, 0);
    expect(q[0]).toBeCloseTo(4658.49, 0);
  });

  it('follows the published profile between the end elevations', () => {
    const e = ends['19R'];
    expect(e.zAt(0)).toBeCloseTo(636.57, 2);
    expect(e.zAt(-e.displaced)).toBeCloseTo(634.69, 2);
    // 8R/26L has no displaced threshold: a straight line from 657.42 to 624.35 over 3207.72 m
    const w = ends['8R'];
    expect(w.zAt(3207.72 / 2)).toBeCloseTo((657.42 + 624.35) / 2, 2);
    expect(w.toOpposite).toBeCloseTo(3207.72, 1);
  });

  it('agrees with the FAA runway polygons within 3 m (the rectangle is the runway)', () => {
    for (const r of runways) {
      const poly = data.pavement.runway.find((p) => p.id === r.id).ring;
      for (let i = 0; i < poly.length; i += 2) {
        const { s, t } = r.local(poly[i], poly[i + 1]);
        expect(s).toBeGreaterThan(-3);
        expect(s).toBeLessThan(r.length + 3);
        expect(Math.abs(t)).toBeLessThan(r.width / 2 + 3);
      }
    }
  });
});

describe('pavement index', () => {
  const pav = createPavementIndex(data);
  it('says which class of pavement a point is on', () => {
    // the middle of runway 8L/26R
    expect(pav.classAt(2400, -4250)).toBe('runway');
    // the desert well south of the field
    expect(pav.classAt(2400, -5200)).toBe(null);
    // a stand's stop on the apron
    const s = data.stands.find((x) => x.onApron);
    expect(pav.on(s.x, s.y, 3)).toBe(true);
  });
  it('counts the polygons it holds', () => {
    expect(pav.counts).toEqual({ runway: 4, taxiway: 279, apron: 23 });
  });
});

describe('height model', () => {
  const plane = (x, y) => 640 + 0.001 * x - 0.002 * y;
  const h = createHeightModel(data, plane);
  const { ends } = runwayFrames(data);
  it('is the runway profile on the runway, not the terrain', () => {
    const e = ends['26L'];
    const [x, y] = e.toMap(1000, 10);
    expect(h(x, y)).toBeCloseTo(e.zAt(1000), 3);
  });
  it('is the terrain far from any runway', () => {
    expect(h(3000, -2500)).toBeCloseTo(plane(3000, -2500), 6);
  });
  it('eases continuously from the runway edge to the terrain', () => {
    const e = ends['8R'];
    let prev = null;
    for (let t = e.width / 2; t < e.width / 2 + 120; t += 0.5) {
      const [x, y] = e.toMap(1500, -t);
      const z = h(x, y);
      if (prev !== null) expect(Math.abs(z - prev)).toBeLessThan(0.2);
      prev = z;
    }
    expect(FT).toBe(0.3048);
  });
});
