// The app's coordinate frame, shared by everything the drive builds.
// Pure maths with no three.js import, so it runs under Node and in workers.
// Twin: scripts/lib/frame.py. Change both together; tests/fixtures/frame.json holds them to pyproj.
//
// Scene axes: x east, y up, z south. "Map" coordinates are (x east, y north) in metres from the
// city origin, so the map point (x, y) at scene height Y is the scene position (x, Y, -y).

import { EFFECTIVE_RADIUS, curveDrop } from '../core/earth.js';

// Shared with src/core/earth.js (plan 01), the source of truth for the map's ground: the refraction-adjusted
// radius and the curve drop are the same double and the same function. The transverse Mercator below is not
// shared: earth.js uses Krüger's series to 4th order, this one to 6th (nanometres at the end of the routes),
// and the two differ in the last bits, so the drive keeps its own, held to pyproj by tests/fixtures/frame.json.

/** Earth radius with standard refraction: what the eye sees, not the geoid. earth.js's EFFECTIVE_RADIUS. */
export const EARTH_R = EFFECTIVE_RADIUS;

/** How far the ground has fallen below the tangent plane at the origin (earth.js). */
export { curveDrop };

/** True vertical at a map position, in scene axes. `out` is any object with set(x, y, z) and normalize(). */
export const localUp = (x, z, out) => out.set(x, EARTH_R, z).normalize();

/**
 * Rotation taking the scene axes to the level frame at scene (x, z) (plan 03, section 5.5): +y goes to localUp, and
 * north (-z) to the level direction in the vertical plane through localUp and -z (grid north, levelled). A flight
 * 250 km out is levelled to the curved datum this way; levelled to the XZ plane its horizon would be 2 degrees off.
 * `out` is any object with set(x, y, z, w), such as a three.js Quaternion.
 */
export function levelQuaternion(x, z, out) {
  const l = Math.hypot(x, EARTH_R, z);
  const ux = x / l, uy = EARTH_R / l, uz = z / l;
  // south: +z with its component along up removed (north is its opposite)
  let sx = -uz * ux, sy = -uz * uy, sz = 1 - uz * uz;
  const ls = Math.hypot(sx, sy, sz);
  sx /= ls; sy /= ls; sz /= ls;
  // east = up x south (that is, north x up)
  const ex = uy * sz - uz * sy, ey = uz * sx - ux * sz, ez = ux * sy - uy * sx;
  // the rotation matrix has columns east, up, south; to a quaternion as three.js does (Shepperd's method)
  const m11 = ex, m12 = ux, m13 = sx, m21 = ey, m22 = uy, m23 = sy, m31 = ez, m32 = uz, m33 = sz;
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return out.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return out.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return out.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return out.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
}

// WGS84
const A_AXIS = 6378137;
const F = 1 / 298.257223563;
const E = Math.sqrt(F * (2 - F));
const N = F / (2 - F);
const N2 = N * N, N3 = N2 * N, N4 = N3 * N, N5 = N4 * N, N6 = N5 * N;
// rectifying radius, and the Krueger series to n^6 (Karney 2011, eqs. 14, 35, 36): nanometres out to thousands of km
const RECT = (A_AXIS / (1 + N)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
const ALPHA = [
  N / 2 - (2 / 3) * N2 + (5 / 16) * N3 + (41 / 180) * N4 - (127 / 288) * N5 + (7891 / 37800) * N6,
  (13 / 48) * N2 - (3 / 5) * N3 + (557 / 1440) * N4 + (281 / 630) * N5 - (1983433 / 1935360) * N6,
  (61 / 240) * N3 - (103 / 140) * N4 + (15061 / 26880) * N5 + (167603 / 181440) * N6,
  (49561 / 161280) * N4 - (179 / 168) * N5 + (6601661 / 7257600) * N6,
  (34729 / 80640) * N5 - (3418889 / 1995840) * N6,
  (212378941 / 319334400) * N6,
];
const BETA = [
  N / 2 - (2 / 3) * N2 + (37 / 96) * N3 - (1 / 360) * N4 - (81 / 512) * N5 + (96199 / 604800) * N6,
  (1 / 48) * N2 + (1 / 15) * N3 - (437 / 1440) * N4 + (46 / 105) * N5 - (1118711 / 3870720) * N6,
  (17 / 480) * N3 - (37 / 840) * N4 - (209 / 4480) * N5 + (5569 / 90720) * N6,
  (4397 / 161280) * N4 - (11 / 504) * N5 - (830251 / 7257600) * N6,
  (4583 / 161280) * N5 - (108847 / 3991680) * N6,
  (20648693 / 638668800) * N6,
];
const RAD = Math.PI / 180;

/** tan of the conformal latitude, from tan of the geodetic latitude. */
const confTan = (tau) => {
  const s = Math.sinh(E * Math.atanh((E * tau) / Math.hypot(1, tau)));
  return tau * Math.hypot(1, s) - s * Math.hypot(1, tau);
};

/** Geodetic latitude's tan from the conformal one's, by Newton's method (Karney 2011, eqs. 19-21). */
function geoTan(taup) {
  let tau = taup / (1 - E * E);
  for (let k = 0; k < 6; k++) {
    const tp = confTan(tau);
    const d = ((taup - tp) / Math.hypot(1, tp)) * ((1 + (1 - E * E) * tau * tau) / ((1 - E * E) * Math.hypot(1, tau)));
    tau += d;
    if (Math.abs(d) < 1e-14 * Math.max(1, Math.abs(tau))) break;
  }
  return tau;
}

/** Krueger forward: (xi, eta) on the unit rectifying sphere for a latitude and a longitude from the central meridian. */
function forward(lat, dlon) {
  const taup = confTan(Math.tan(lat));
  const xip = Math.atan2(taup, Math.cos(dlon));
  const etap = Math.asinh(Math.sin(dlon) / Math.hypot(taup, Math.cos(dlon)));
  let xi = xip, eta = etap;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
  }
  return [xi, eta];
}

/**
 * The frame of one city: a transverse Mercator on WGS84 about its origin (k = 1), and its height base.
 * Matches `+proj=tmerc +lat_0 +lon_0 +k=1 +x_0=0 +y_0=0 +ellps=WGS84` in terrain.json.
 * @param {{ origin: { lat: number, lon: number }, base: number }} city
 */
export function createFrame(city) {
  const { origin, base } = city;
  const lon0 = origin.lon * RAD;
  const xi0 = forward(origin.lat * RAD, 0)[0];
  return {
    base,
    origin: { lat: origin.lat, lon: origin.lon },
    /** Scene Y of a height above sea level `h` at map (x, y). */
    sceneY: (h, x, y) => h - base - curveDrop(x, y),
    /** Map metres (x east, y north) of a WGS84 position in degrees. */
    toLocal(lat, lon) {
      let dlon = lon * RAD - lon0;
      dlon = Math.atan2(Math.sin(dlon), Math.cos(dlon)); // wrap to (-pi, pi]
      const [xi, eta] = forward(lat * RAD, dlon);
      return { x: RECT * eta, y: RECT * (xi - xi0) };
    },
    /** WGS84 degrees of a map position. */
    toGeodetic(x, y) {
      const xi = y / RECT + xi0, eta = x / RECT;
      let xip = xi, etap = eta;
      for (let j = 1; j <= 6; j++) {
        xip -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
        etap -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
      }
      const s = Math.sinh(etap), c = Math.cos(xip);
      const taup = Math.sin(xip) / Math.hypot(s, c);
      const lat = Math.atan(geoTan(taup));
      const lon = lon0 + Math.atan2(s, c);
      return { lat: lat / RAD, lon: lon / RAD };
    },
  };
}
