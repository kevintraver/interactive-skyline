// The planet the app stands on. World units are meters: x = east, y = up, z = south, origin at the city's
// reference point, y = 0 at the city's `base` elevation. Map meters (cities.json, buildings.json) are
// x = east, y = north of the origin. Distant ground is lowered onto one sphere whose radius includes standard
// atmospheric refraction, so the horizon falls where the eye sees it. Pure: no three.js.

export const EARTH_RADIUS = 6371000; // m, mean radius
export const REFRACTION_K = 1 / 7; // standard refraction coefficient
/** Radius of the refraction-adjusted sphere, EARTH_RADIUS / (1 - REFRACTION_K). Written as 7/6 so it is the same
 * double the app has always used. */
export const EFFECTIVE_RADIUS = EARTH_RADIUS * (7 / 6);

/** How far the ground at map offset (x, z) from the origin sits below the tangent plane, in meters. */
export const curveDrop = (x, z) => (x * x + z * z) / (2 * EFFECTIVE_RADIUS);

/** Center of the effective sphere in world coordinates, for a city with `base` elevation (sea level is y = -base). */
export function planetCenter(city) {
  return { x: 0, y: -(city.base + EFFECTIVE_RADIUS), z: 0 };
}

/** Height above sea level, on the effective sphere, of a world position {x, y, z}. */
export function altitudeOf(pos, city) {
  const c = planetCenter(city);
  return Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z) - EFFECTIVE_RADIUS;
}

/** Distance in meters to the horizon seen from `h` meters up (refraction included). */
export const horizonDistance = (h) => Math.sqrt(2 * EFFECTIVE_RADIUS * h);

// Transverse Mercator about the city origin, k0 = 1, on WGS84: the `+proj=tmerc` of each terrain.json.
// Krüger series to fourth order in n (Karney 2011), sub-millimetre within hundreds of kilometres.
const A_WGS84 = 6378137, F = 1 / 298.257223563, N = F / (2 - F);
const A = (A_WGS84 / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);
const ALPHA = [N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140,
  (49561 * N ** 4) / 161280];
const BETA = [N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360,
  N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440,
  (17 * N ** 3) / 480 - (37 * N ** 4) / 840,
  (4397 * N ** 4) / 161280];
const DELTA = [2 * N - (2 * N ** 2) / 3 - 2 * N ** 3 + (116 * N ** 4) / 45,
  (7 * N ** 2) / 3 - (8 * N ** 3) / 5 - (227 * N ** 4) / 45,
  (56 * N ** 3) / 15 - (136 * N ** 4) / 35,
  (4279 * N ** 4) / 630];
const RAD = Math.PI / 180;
const E2N = (2 * Math.sqrt(N)) / (1 + N);

function forward(latDeg, dLonDeg) {
  const phi = latDeg * RAD, lam = dLonDeg * RAD;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - E2N * Math.atanh(E2N * Math.sin(phi)));
  const xi1 = Math.atan2(t, Math.cos(lam)), eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 4; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return { x: A * eta, y: A * xi };
}

/** Latitude and longitude (degrees) to map meters {x: east, y: north} of `origin` ({lat, lon}). */
export function toLocal(lat, lon, origin) {
  const p = forward(lat, lon - origin.lon), o = forward(origin.lat, 0);
  return { x: p.x, y: p.y - o.y };
}

/** Map meters {x: east, y: north} of `origin` back to {lat, lon} in degrees. */
export function toGeodetic(x, y, origin) {
  const xi = (y + forward(origin.lat, 0).y) / A, eta = x / A;
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 4; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  return { lat: phi / RAD, lon: origin.lon + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) / RAD };
}
