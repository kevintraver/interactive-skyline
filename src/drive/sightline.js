// Line of sight from the driver's eye to a building, over the terrain. Pure: the ground is a function.
// Same rule as scripts/lib/sightline.py, which places the reveal: a straight segment in scene space
// (the earth's curvature is already in the ground's scene Y), sampled every 10 m from 2 m past the eye.

/**
 * Whether the segment from `from` to `to` (scene axes: x east, y up, z south) stays above the ground.
 * @param {{ x: number, y: number, z: number }} from  @param {{ x: number, y: number, z: number }} to
 * @param {(x: number, y: number) => number} groundY  scene Y of the ground at map (x east, y north)
 * @param {{ step?: number, skip?: number }} [opts]  sample spacing along the ground, and how far from the eye to start
 * @returns {{ clear: boolean, worst: number }} worst is the smallest clearance found, metres
 */
export function sightOverGround(from, to, groundY, { step = 10, skip = 2 } = {}) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(dist / step));
  let worst = Infinity;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    if (f * dist <= skip) continue;
    const x = from.x + dx * f, z = from.z + dz * f;
    const c = from.y + dy * f - groundY(x, -z);
    if (c < worst) worst = c;
    if (c <= 0) return { clear: false, worst: c };
  }
  return { clear: true, worst };
}
