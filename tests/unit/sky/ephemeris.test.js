// T1.2: the ephemeris against JPL Horizons and the US Naval Observatory (plan 01, section 8.2, ephemeris rows).
// The fixtures are committed (scripts/fetch_test_fixtures.py); nothing here touches the network.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Vector3 } from 'three';
import { SearchLocalSolarEclipse, MakeTime, Observer } from 'astronomy-engine';
import { createEphemeris, dirFromAzAlt, azAltFromDir, discOverlap, phaseOf } from '../../../src/sky/ephemeris.js';
import { ROOT } from '../../helpers/staticServer.js';

const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures', f), 'utf8'));
const jdToMs = (jd) => Math.round((jd - 2440587.5) * 86400000);
const BODIES = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn'];
/** Angle between two directions given as azimuth and altitude, in degrees (azimuth error shrinks with cos(alt)). */
function separation(az1, alt1, az2, alt2) {
  const a = dirFromAzAlt(az1, alt1), b = dirFromAzAlt(az2, alt2);
  return (Math.acos(Math.min(1, a.dot(b))) * 180) / Math.PI;
}
const worst = (list) => list.reduce((m, x) => (x.err > m.err ? x : m), { err: -1 });

for (const city of ["lv", "slc"]) {
  describe(`ephemeris ${city} against JPL Horizons`, () => {
    const fx = read(`horizons/${city}-bodies.json`);
    const eph = createEphemeris(fx.observer);
    const states = fx.instantsJdUt.map((jd) => eph.at(jdToMs(jd)));
    const body = (s, name) => (name === 'sun' || name === 'moon' ? s[name] : s.planets[name]);

    it(`covers ${fx.instantsJdUt.length} instants from 1940 to 2040`, () => {
      expect(fx.instantsJdUt.length).toBeGreaterThanOrEqual(100);
      expect(new Date(jdToMs(fx.instantsJdUt[0])).getUTCFullYear()).toBeLessThan(1942);
      expect(new Date(jdToMs(fx.instantsJdUt.at(-1))).getUTCFullYear()).toBeGreaterThan(2030);
    });

    for (const name of BODIES) {
      it(`${name}: airless direction within 0.01 deg`, () => {
        const errs = fx.bodies[name].airless.map(([az, alt], i) => {
          const b = body(states[i], name);
          return { err: separation(az, alt, b.azDeg, b.trueAltDeg), i };
        });
        const w = worst(errs);
        expect(w.err, `worst at JD ${fx.instantsJdUt[w.i]}`).toBeLessThan(0.01);
      });
    }

    for (const name of ['sun', 'moon']) {
      it(`${name}: refracted altitude within 0.05 deg above 2 deg, 0.2 deg at the horizon`, () => {
        const above = [], horizon = [];
        fx.bodies[name].refracted.forEach(([az, alt], i) => {
          const b = body(states[i], name);
          if (alt > 2) above.push({ err: Math.abs(alt - b.altDeg), i });
          else if (alt > -1) horizon.push({ err: Math.abs(alt - b.altDeg), i });
        });
        expect(above.length).toBeGreaterThan(20);
        expect(worst(above).err).toBeLessThan(0.05);
        if (horizon.length) expect(worst(horizon).err).toBeLessThan(0.2);
      });
    }

    it('moon: illuminated fraction, magnitude, angular diameter, sub-observer point', () => {
      const illum = [], mag = [], diam = [], lon = [], lat = [];
      fx.bodies.moon.airless.forEach(([, , apmag, illu, angDiam, subLon, subLat], i) => {
        const m = states[i].moon;
        illum.push({ err: Math.abs(m.phaseFraction * 100 - illu), i });
        // Horizons gives no magnitude near new moon ("n.a."); astronomy-engine's is geocentric
        if (apmag !== null && illu > 5) mag.push({ err: Math.abs(m.magnitude - apmag), i });
        diam.push({ err: Math.abs((2 * m.angularRadiusRad * 180 / Math.PI * 3600) / angDiam - 1), i });
        // astronomy-engine's libration is geocentric; Horizons' sub-observer point is topocentric
        lon.push({ err: Math.abs((((m.libration.lonDeg - subLon) % 360) + 540) % 360 - 180), i });
        lat.push({ err: Math.abs(m.libration.latDeg - subLat), i });
      });
      expect(worst(illum).err, 'illuminated fraction, percentage points').toBeLessThan(0.5);
      expect(worst(mag).err, 'magnitude').toBeLessThan(0.1);
      expect(worst(diam).err, 'angular diameter, relative').toBeLessThan(0.005);
      expect(worst(lon).err, 'libration in longitude, deg').toBeLessThan(1.2);
      expect(worst(lat).err, 'libration in latitude, deg').toBeLessThan(1.2);
    });

    it('rise, set and twilights within 60 s of the times derived from Horizons', () => {
      const days = read(`horizons/${city}-sun-days.json`).days;
      const errs = [];
      for (const d of days) {
        const ev = eph.events(d.dayStartUtcMs);
        for (const [k, t] of Object.entries(d.events)) {
          if (t === null) { expect(ev[k], `${d.date} ${k}`).toBeNull(); continue; }
          errs.push({ err: Math.abs(ev[k] - t) / 1000, what: `${d.date} ${k}` });
        }
      }
      expect(errs.length).toBeGreaterThan(days.length * 6);
      const w = worst(errs);
      expect(w.err, w.what).toBeLessThan(60);
    });

    it('sunrise, sunset and civil twilight within 60 s of the Naval Observatory', () => {
      const usno = read(`usno/${city}-sun-days.json`);
      const days = read(`horizons/${city}-sun-days.json`).days;
      const errs = [];
      usno.days.forEach((d, i) => {
        const ev = eph.events(days[i].dayStartUtcMs);
        for (const [k, t] of Object.entries(d.events)) errs.push({ err: Math.abs(ev[k] - t) / 1000, what: `${d.date} ${k}` });
      });
      expect(errs.length).toBeGreaterThanOrEqual(usno.days.length * 4 - 2);
      const w = worst(errs);
      expect(w.err, w.what).toBeLessThan(60);
    });
  });
}

describe('ephemeris: axes and helpers', () => {
  it('maps azimuth 90 to +x, 0 to -z, 180 to +z, altitude 90 to +y', () => {
    const close = (v, x, y, z) => expect(v.distanceTo(new Vector3(x, y, z))).toBeLessThan(1e-12);
    close(dirFromAzAlt(90, 0), 1, 0, 0);
    close(dirFromAzAlt(0, 0), 0, 0, -1);
    close(dirFromAzAlt(180, 0), 0, 0, 1);
    close(dirFromAzAlt(123, 90), 0, 1, 0);
    const back = azAltFromDir(dirFromAzAlt(245, 32));
    expect(back.azDeg).toBeCloseTo(245, 10);
    expect(back.altDeg).toBeCloseTo(32, 10);
  });

  it('a body\'s direction agrees with its azimuth and altitude', () => {
    const eph = createEphemeris({ lat: 36.1147, lon: -115.1728, elevationM: 620 });
    const s = eph.at(Date.UTC(2026, 2, 23, 23, 8));
    const { azDeg, altDeg } = azAltFromDir(s.sun.dir);
    expect(azDeg).toBeCloseTo(s.sun.azDeg, 9);
    expect(altDeg).toBeCloseTo(s.sun.altDeg, 9);
  });

  it('the "classic afternoon" instant puts the Sun at azimuth 245.00, altitude 32.05 (section 5.6)', () => {
    const eph = createEphemeris({ lat: 36.1147, lon: -115.1728, elevationM: 620 });
    const s = eph.at(Date.UTC(2026, 2, 23, 23, 8));
    expect(Math.abs(s.sun.azDeg - 245)).toBeLessThan(0.05);
    expect(Math.abs(s.sun.altDeg - 32.05)).toBeLessThan(0.05);
  });

  it('eqjToScene sends the celestial pole to the north at the latitude\'s altitude', () => {
    const eph = createEphemeris({ lat: 36.1147, lon: -115.1728, elevationM: 620 });
    const pole = new Vector3(0, 0, 1).applyMatrix3(eph.eqjToScene(Date.UTC(2026, 0, 1)));
    const { azDeg, altDeg } = azAltFromDir(pole);
    expect(Math.min(azDeg, 360 - azDeg)).toBeLessThan(0.5); // precession since J2000 moves it a little
    expect(Math.abs(altDeg - 36.1147)).toBeLessThan(0.5);
  });

  it('the Moon\'s orientation puts its near side toward the observer', () => {
    const eph = createEphemeris({ lat: 36.1147, lon: -115.1728, elevationM: 620 });
    const m = eph.at(Date.UTC(2026, 5, 1, 6)).moon;
    // moon-fixed +x is the mean sub-Earth point: it should face back toward us, within libration (< 10 deg)
    const nearSide = new Vector3(1, 0, 0).applyMatrix3(m.orientation);
    expect(nearSide.dot(m.dir.clone().negate())).toBeGreaterThan(Math.cos((10 * Math.PI) / 180));
  });

  it('memoises to one second of simulation time', () => {
    const eph = createEphemeris({ lat: 36.1147, lon: -115.1728, elevationM: 620 });
    const t = Date.UTC(2026, 0, 1, 12);
    expect(eph.at(t + 100)).toBe(eph.at(t + 400));
    expect(eph.at(t + 900)).not.toBe(eph.at(t + 100));
  });

  it('disc overlap: none, total, annular, half', () => {
    expect(discOverlap(1, 1, 2.5)).toBe(0);
    expect(discOverlap(1, 1.05, 0)).toBe(1);
    expect(discOverlap(1, 0.9, 0)).toBeCloseTo(0.81, 10);
    expect(discOverlap(1, 1, 0)).toBe(1);
    expect(discOverlap(1, 1, 1e-9)).toBeCloseTo(1, 6);
  });

  it('twilight phases', () => {
    expect([10, -0.5, -3, -9, -15, -30].map(phaseOf)).toEqual(['day', 'day', 'civil', 'nautical', 'astronomical', 'night']);
  });
});

describe('the annular eclipse of 14 October 2023 at Las Vegas', () => {
  const eph = createEphemeris({ lat: 36.1147, lon: -115.1728, elevationM: 620 });
  it('peaks at 16:26 UTC within a minute, obscuration 0.82 within 0.01', () => {
    const e = SearchLocalSolarEclipse(MakeTime(new Date(Date.UTC(2023, 9, 13))), new Observer(36.1147, -115.1728, 620));
    expect(Math.abs(e.peak.time.date.getTime() - Date.UTC(2023, 9, 14, 16, 26)) / 1000).toBeLessThan(60);
    expect(Math.abs(e.obscuration - 0.82)).toBeLessThan(0.01);
    // and the ephemeris' own eclipsedFraction at the peak, from the two discs
    expect(Math.abs(eph.at(e.peak.time.date.getTime()).sun.eclipsedFraction - 0.82)).toBeLessThan(0.01);
    expect(eph.at(Date.UTC(2023, 9, 14, 20)).sun.eclipsedFraction).toBe(0);
  });
});
