// The five views of the regional terrain harness (tests/manual/flight-terrain.html) and its unit test
// (tests/unit/flight/terrainIndex.test.js), taken from the recorded arrival lv-19-day (public/data/lv/flights): where the
// aircraft is at each height, its grid heading, and where the passenger looks. Pure; no three.js.
//
//   x, y        map metres (east, north) of the eye
//   altitude    metres above sea level of the eye
//   agl         metres above the ground below, for the far plane (layers.js nearFar), roughly
//   heading     grid heading of the aircraft, degrees clockwise from north
//   yaw, pitch  where the eye looks, degrees: yaw from the heading (right is positive), pitch from level
//   fov         vertical field of view, degrees (a 26 mm lens on a 16:9 view, the passenger's default, is about 48)
import { levelQuaternion } from '../../src/world/frame.js';
import { curveDrop } from '../../src/core/earth.js';

const FT = 0.3048;

export const VIEWS = {
  // t = 0 of the track: cruise at FL300, 250 km north-east, the descent ahead; looking along the arrival
  cruise: { x: 176500, y: 174200, altitude: 30000 * FT, agl: 30000 * FT - 1700, heading: 214, yaw: 0, pitch: -4, fov: 48 },
  // the same place, out of the right window as the passenger does (the right is north-west: the ranges of Nevada)
  'cruise-right': { x: 176500, y: 174200, altitude: 30000 * FT, agl: 30000 * FT - 1700, heading: 214, yaw: 75, pitch: -12, fov: 48 },
  // the fl180 event (t = 945 s), turning onto the downwind over the Muddy Mountains
  fl180: { x: 92700, y: 38000, altitude: 18000 * FT, agl: 18000 * FT - 900, heading: 228, yaw: 75, pitch: -14, fov: 48 },
  // 10,000 ft over Lake Mead: the recorded 10000 event (t = 1,270 s, at 53.7, 12.0 km) is north of the lake, so this
  // view is moved to just south-east of Boulder Basin on the same heading, the lake out of the right window and the
  // valley, Frenchman Mountain and the Spring Mountains beyond it
  'lake-mead': { x: 45000, y: -15000, altitude: 10000 * FT, agl: 10000 * FT - 500, heading: 247, yaw: 70, pitch: -16, fov: 48 },
  // t = 1,625 s, about 3,000 ft above the east valley (Henderson below, the Strip ahead and right)
  'east-valley': { x: 12500, y: 2900, altitude: 560 + 3000 * FT, agl: 3000 * FT, heading: 268, yaw: 70, pitch: -12, fov: 48 },
  // t = 1,775 s, 300 ft above the ground on final to 19R: right is the Strip and the Spring Mountains
  final: { x: 1900, y: -500, altitude: 640 + 300 * FT, agl: 300 * FT, heading: 203, yaw: 70, pitch: -6, fov: 48 },
};

/**
 * Place a three.js camera for a view: at the eye, levelled to the curved datum (levelQuaternion), turned to the heading
 * plus yaw and pitched. `Quaternion` and `Euler` are three's classes (passed in so this module stays pure).
 */
export function placeCamera(camera, v, { base, Quaternion, Euler }) {
  const y = v.altitude - base - curveDrop(v.x, v.y);
  camera.position.set(v.x, y, -v.y);
  const level = levelQuaternion(v.x, -v.y, new Quaternion());
  const RAD = Math.PI / 180;
  const look = new Quaternion().setFromEuler(new Euler(v.pitch * RAD, -(v.heading + v.yaw) * RAD, 0, 'YXZ'));
  camera.quaternion.copy(level).multiply(look);
  camera.fov = v.fov;
  camera.updateMatrixWorld(true);
  return camera;
}
