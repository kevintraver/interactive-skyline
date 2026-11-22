// Where the Sun, the Moon and the planets are, seen from the city (plan 01, sections 5.4 and 7.6; task T1.2).
// A thin wrapper on astronomy-engine (MIT, VSOP87 and a truncated ELP), checked against JPL Horizons in
// tests/unit/sky/ephemeris.test.js. No renderer and no DOM; three.js only for its Vector3 and Matrix3.
//
// Scene axes: +x east, +y up, -z north. A direction from azimuth (clockwise from north) and altitude is
//   x = sin(az) cos(alt),  y = sin(alt),  z = -cos(az) cos(alt)
// the formula the fixed sun has always used (src/sky/legacySky.js).
import { Body, Observer, MakeTime, Equator, Horizon, Illumination, Libration, RotationAxis, Rotation_EQJ_HOR, RotateVector,
  Vector as AVector, SearchRiseSet, SearchAltitude, SearchHourAngle } from 'astronomy-engine';
import { Vector3, Matrix3 } from 'three';

const AU_M = 149597870700;
const SUN_RADIUS_M = 695700e3;
const MOON_RADIUS_M = 1737.4e3;
const PLANET_RADIUS_M = { mercury: 2439.7e3, venus: 6051.8e3, mars: 3389.5e3, jupiter: 69911e3, saturn: 58232e3 };
const PLANETS = { mercury: Body.Mercury, venus: Body.Venus, mars: Body.Mars, jupiter: Body.Jupiter, saturn: Body.Saturn };
const DEG = Math.PI / 180;
const DAY_MS = 86400000;
/** Altitudes of the events the scrubber marks: the Sun's centre at these angles (rise and set: refraction and
 * semidiameter, astronomy-engine's own model, close to the conventional -0.833 deg). */
export const TWILIGHT = { civil: -6, nautical: -12, astronomical: -18 };

/** Unit vector toward azimuth `azDeg`, altitude `altDeg`, in scene axes. */
export function dirFromAzAlt(azDeg, altDeg, out = new Vector3()) {
  const az = azDeg * DEG, alt = altDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
}

/** Azimuth and altitude of a scene-axes direction. */
export function azAltFromDir(v) {
  const alt = Math.asin(Math.max(-1, Math.min(1, v.y / v.length()))) / DEG;
  const az = ((Math.atan2(v.x, -v.z) / DEG) + 360) % 360;
  return { azDeg: az, altDeg: alt };
}

/** Fraction of the solar disc's area covered by the Moon's: two discs of angular radii `rs`, `rm` whose centres
 * are `d` apart (any one unit). */
export function discOverlap(rs, rm, d) {
  if (d >= rs + rm) return 0;
  if (d <= Math.abs(rm - rs)) return rm >= rs ? 1 : (rm * rm) / (rs * rs);
  const a = rs * rs * Math.acos((d * d + rs * rs - rm * rm) / (2 * d * rs));
  const b = rm * rm * Math.acos((d * d + rm * rm - rs * rs) / (2 * d * rm));
  const c = 0.5 * Math.sqrt((-d + rs + rm) * (d + rs - rm) * (d - rs + rm) * (d + rs + rm));
  return (a + b - c) / (Math.PI * rs * rs);
}

// Horizontal frame of Rotation_EQJ_HOR: x north, y west, z up. Scene: x = -y, y = z, z = -x.
const horToScene = (v, out) => out.set(-v.y, v.z, -v.x);

/** The 3x3 matrix of an astronomy-engine rotation, applied to scene axes after it. */
function rotationToScene(rotation, out = new Matrix3()) {
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(([x, y, z]) =>
    horToScene(RotateVector(rotation, new AVector(x, y, z, rotation.t)), new Vector3()));
  return out.set(cols[0].x, cols[1].x, cols[2].x, cols[0].y, cols[1].y, cols[2].y, cols[0].z, cols[1].z, cols[2].z);
}

/**
 * @param {{ lat: number, lon: number, elevationM: number }} observer the city origin
 * @returns {{ at(timeMs: number): import('../contracts.d.ts').CelestialState, events(dayStartMs: number): import('../contracts.d.ts').DayEvents,
 *   eqjToScene(timeMs: number): Matrix3, timeOfSunAltitude(altDeg: number, dayMs: number, which: 'rising' | 'setting'): number | null }}
 */
export function createEphemeris({ lat, lon, elevationM }) {
  const observer = new Observer(lat, lon, elevationM);

  function body(b, time, radiusM) {
    const eq = Equator(b, time, observer, true, true);
    const app = Horizon(time, observer, eq.ra, eq.dec, 'normal');
    const geo = Horizon(time, observer, eq.ra, eq.dec);
    const distanceM = eq.dist * AU_M;
    return {
      dir: dirFromAzAlt(app.azimuth, app.altitude), azDeg: app.azimuth, altDeg: app.altitude, trueAltDeg: geo.altitude,
      distanceM, angularRadiusRad: Math.asin(Math.min(1, radiusM / distanceM)), magnitude: 0, eq,
    };
  }

  function moonOrientation(time) {
    // moon-fixed -> EQJ from the IAU rotation model: Rz(ra + 90) Rx(90 - dec) Rz(W), then EQJ -> horizontal -> scene
    const axis = RotationAxis(Body.Moon, time);
    const rz = (a) => new Matrix3().set(Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1);
    const rx = (a) => new Matrix3().set(1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a));
    const fixedToEqj = rz((axis.ra * 15 + 90) * DEG).multiply(rx((90 - axis.dec) * DEG)).multiply(rz(axis.spin * DEG));
    return rotationToScene(Rotation_EQJ_HOR(time, observer)).multiply(fixedToEqj);
  }

  let cacheKey = NaN, cached = null;
  /** Everything at one instant, memoised to one second of simulation time. */
  function at(timeMs) {
    const key = Math.round(timeMs / 1000);
    if (key === cacheKey) return cached;
    const time = MakeTime(new Date(key * 1000));
    const sun = body(Body.Sun, time, SUN_RADIUS_M);
    const moon = body(Body.Moon, time, MOON_RADIUS_M);
    sun.magnitude = Illumination(Body.Sun, time).mag;
    moon.magnitude = Illumination(Body.Moon, time).mag;
    // the Moon's phase as seen from the city, not from the Earth's centre (astronomy-engine's Illumination is
    // geocentric and differs from Horizons' Illu% by up to 0.8 points; this agrees to 0.01), from airless directions
    const toMoon = dirFromAzAlt(moon.azDeg, moon.trueAltDeg).multiplyScalar(moon.distanceM);
    const moonToSun = dirFromAzAlt(sun.azDeg, sun.trueAltDeg).multiplyScalar(sun.distanceM).sub(toMoon);
    const phaseAngle = moonToSun.angleTo(toMoon.negate());
    // topocentric separation of the two discs, for a solar eclipse
    const sep = Math.acos(Math.max(-1, Math.min(1, sun.dir.dot(moon.dir))));
    sun.eclipsedFraction = discOverlap(sun.angularRadiusRad, moon.angularRadiusRad, sep);
    const lib = Libration(time);
    Object.assign(moon, {
      phaseFraction: (1 + Math.cos(phaseAngle)) / 2, phaseAngleDeg: phaseAngle / DEG,
      libration: { lonDeg: lib.elon, latDeg: lib.elat }, orientation: moonOrientation(time),
      umbra: 0, // lunar eclipses arrive with T8.1
    });
    const planets = {};
    for (const [name, b] of Object.entries(PLANETS)) {
      const p = planets[name] = body(b, time, PLANET_RADIUS_M[name]);
      p.magnitude = Illumination(b, time).mag;
      delete p.eq;
    }
    delete sun.eq;
    delete moon.eq;
    cacheKey = key;
    cached = { timeMs: key * 1000, sun, moon, planets };
    return cached;
  }

  const ms = (t) => (t ? t.date.getTime() : null);
  const within = (t, dayStartMs) => (t !== null && t >= dayStartMs && t < dayStartMs + DAY_MS ? t : null);

  /** When the Sun's centre reaches `altDeg` on the day starting at `dayMs`, rising or setting; null if it does not. */
  function timeOfSunAltitude(altDeg, dayMs, which) {
    const t = SearchAltitude(Body.Sun, observer, which === 'rising' ? +1 : -1, MakeTime(new Date(dayMs)), 1, altDeg);
    return within(ms(t), dayMs);
  }

  /** Rise, set, transit and twilights in [dayStartMs, dayStartMs + 24 h), for the scrubber. Missing events are null. */
  function events(dayStartMs) {
    const start = MakeTime(new Date(dayStartMs));
    const riseSet = (b, dir) => within(ms(SearchRiseSet(b, observer, dir, start, 1)), dayStartMs);
    const noon = SearchHourAngle(Body.Sun, observer, 0, start);
    return {
      astronomicalDawn: timeOfSunAltitude(TWILIGHT.astronomical, dayStartMs, 'rising'),
      nauticalDawn: timeOfSunAltitude(TWILIGHT.nautical, dayStartMs, 'rising'),
      civilDawn: timeOfSunAltitude(TWILIGHT.civil, dayStartMs, 'rising'),
      sunrise: riseSet(Body.Sun, +1),
      noon: within(ms(noon.time), dayStartMs),
      sunset: riseSet(Body.Sun, -1),
      civilDusk: timeOfSunAltitude(TWILIGHT.civil, dayStartMs, 'setting'),
      nauticalDusk: timeOfSunAltitude(TWILIGHT.nautical, dayStartMs, 'setting'),
      astronomicalDusk: timeOfSunAltitude(TWILIGHT.astronomical, dayStartMs, 'setting'),
      moonrise: riseSet(Body.Moon, +1),
      moonset: riseSet(Body.Moon, -1),
    };
  }

  /** J2000 equatorial -> scene axes at `timeMs`, for stars and the Milky Way (phase 4). */
  const eqjToScene = (timeMs) => rotationToScene(Rotation_EQJ_HOR(MakeTime(new Date(timeMs)), observer));

  return { observer: { lat, lon, elevationM }, at, events, eqjToScene, timeOfSunAltitude };
}

/** The twilight phase for a solar altitude (section 11.4, EnvState.sky.phase). */
export function phaseOf(sunAltDeg) {
  if (sunAltDeg > -0.833) return 'day';
  if (sunAltDeg > TWILIGHT.civil) return 'civil';
  if (sunAltDeg > TWILIGHT.nautical) return 'nautical';
  if (sunAltDeg > TWILIGHT.astronomical) return 'astronomical';
  return 'night';
}
