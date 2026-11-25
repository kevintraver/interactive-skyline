// Two of the drive's valley-wide parts, run without a drive (plan 03, section 7.11: "drawn in flight too where plan 2
// has built them"): the valley's traffic as ribbons of head and tail light (src/drive/traffic/valley.js, D6.6) and the
// red obstruction lights on tall buildings (src/drive/lights/obstruction.js, D5.6). Both need no route; each takes
// the drive's part context (src/drive/parts.js), of which they read only a few members, given here from the flight's.
//
// Left in the drive, and why:
//   - the lamps part (src/drive/lights/index.js): its sprites are what src/flight/ground/lamps.js draws, culled for the
//     air; its pools, poles and switching tables are built around the car (a 2 km pool map, poles along the route);
//   - screens and the Sphere's light on the ground (src/drive/screens): their light lands on the drive's road and
//     roadside materials (ctx.eachSurface, ctx.materials), which the flight does not draw; the Sphere's own LED skin is
//     the map's and is lit in flight already;
//   - billboards (src/drive/roadside/billboards.js): stand along the drive's routes (ctx.roads) and choose their glow
//     by the car's position (frame.pose);
//   - the traffic part's vehicles: they follow a route's lanes.

/**
 * The part context for the valley-wide parts.
 * @param {{ fetchFile: (name: string) => Promise<Response>, nodes: object, city: object, heightAt: (x: number, y: number) => number,
 *   base: number, earthR: number, renderer?: object, camera?: object, invalidate?: () => void, quality?: object,
 *   tall?: object[], events?: object, group: import('three').Group, light: { ambientLux: number, extinctionM: number } }} o
 *   light: read when the parts ask (the ambient illuminance and the extinction length of the frame)
 */
export function flightPartContext({ fetchFile, nodes, city, heightAt, base, earthR, renderer = null, camera = null, invalidate = () => {},
  quality = null, tall = [], events = null, group, light }) {
  return {
    async optional(name) {
      try {
        const r = await fetchFile(name);
        return r.ok ? r.json() : null;
      } catch { return null; }
    },
    async get(name) {
      const r = await fetchFile(name);
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return r;
    },
    env: {
      nodes, city,
      lighting: { ambientLux: () => light.ambientLux },
      // the parts' sprites and ribbons take `visibilityM` as the length d is divided by (exp(-d / V)): the extinction length
      weather: { state: () => ({ visibilityM: light.extinctionM }) },
    },
    terrain: { surfaceAt: heightAt },
    base, earthR, group,
    app: { renderer, camera, invalidate, plan01: { quality }, tall, events },
  };
}

/**
 * Load the two parts (either may be null when its data is missing; a failure is reported and leaves it out).
 * @param {ReturnType<typeof flightPartContext>} ctx
 */
export async function loadDriveParts(ctx) {
  const load = async (what, fn) => {
    try { return await fn(); } catch (err) { console.warn(`Fly: the ${what} could not be built.`, err); return null; }
  };
  const [valley, obstruction] = await Promise.all([
    load('valley traffic', () => import('../../drive/traffic/valley.js').then((m) => m.createValleyPart(ctx))),
    load('obstruction lights', () => import('../../drive/lights/obstruction.js').then((m) => m.createObstructionPart(ctx))),
  ]);
  return { valley, obstruction };
}

/**
 * The map's removable towers (src/city/buildings.js `tall`), found in the scene: each tower mesh carries its entry
 * in userData.entry. Filled in place, tallest first, so a part holding the array sees it change.
 */
export function collectTall(scene, into = []) {
  into.length = 0;
  scene.traverse((o) => { const e = o.userData?.entry; if (e && e.mesh === o && e.data?.v) into.push(e); });
  into.sort((a, b) => maxTop(b.data) - maxTop(a.data));
  return into;
}
const maxTop = (d) => d.v.reduce((m, v) => Math.max(m, v.t), -Infinity);
