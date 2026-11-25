// The airport's light layout (plan 03, section 7.10; F4.3), pure and without three.js: every light the FAA record gives
// each runway end, generated from the standards' geometry, plus the taxiway lights OpenStreetMap maps, the beacon and
// apron floodlights. Each light is one record:
//
//   { kind, x, y, z, colour, candela, dir, elev, hHalf, vHalf, omni, slot, category, runway, end, fixture, flash, papi,
//     inPavement, source }
//
//   x, y, z    map metres (x east, y north) and metres above sea level: the lamp itself, above the ground it stands on
//   colour     'white', 'yellow', 'red', 'green', 'blue' or 'papi' (red below the unit's setting, white above)
//   candela    peak intensity at the top brightness step, on the beam's axis
//   dir        [dx, dy] the horizontal direction the beam points (toward the viewers it serves), or null for a light
//              that shines all round
//   elev       the beam axis' elevation above the horizontal, radians; hHalf, vHalf: half-intensity half-widths of the
//              beam across and up (radians); omni: the share of the peak shone in every direction above the horizon
//   slot       index into `slots`: the light's brightness step and, for a flasher, its place in the flash sequence
//   flash      null or { group, seq }: the flash group (runs, pairs, the beacon) and the light's order in its run
//   papi       null or { unit (0 nearest the runway), setting (degrees) }
//   fixture    lights that share a fitting share this id (a bidirectional edge light is two records, one per direction)
//
// Sources. Geometry from FAA Order JO 6850.2C and AC 150/5340-30J (section 7.10's table), brightness from the
// photometric minimums of AC 150/5345-46E and typical LED fittings; each number not in the airport file is marked
// ESTIMATED with what it rests on. OpenStreetMap's individually mapped lights move a generated light of the same kind
// when one lies within 5 m (section 7.10), and `residuals` says by how much.
//
// Flashing. Flashers keep presentation time (wall clock, frozen while paused), never journey time, and obey the rule of
// the aircraft's own lights (src/flight/aircraft/lights.js): at most three flashes a second in total, counted on the
// brightest flashing light in view, and steady at STEADY_DIM under reduced motion. A sequenced run (MALSF) is one
// flash: its three lamps' pulses overlap into one travelling flash, as the eye takes it. createFlashSequencer() hands
// the flash slots out one at a time at no more than three a second, shared among the groups in view in proportion to
// their real rates; when the groups in view flash less than that in total, each runs at its real rate.

import { FT, runwayFrames, createPavementIndex } from './geometry.js';
import { MAX_FLASHES_PER_S, STEADY_DIM } from '../aircraft/lights.js';

const DEG = Math.PI / 180;
/** The caution zone of an instrument runway's edge lights: yellow over the last 2,000 ft (or half the runway). */
export const CAUTION_M = 2000 * FT;
/** A unit's setting relative to the path, from the unit nearest the runway outward: +30', +10', -10', -30'. */
export const PAPI_OFFSETS_DEG = Object.freeze([0.5, 1 / 6, -1 / 6, -0.5]);
/** Red to white through this many degrees either side of a unit's setting. ESTIMATED: "a few arc-minutes" (7.10);
 * AC 150/5345-28H allows a transition of at most 3'. */
export const PAPI_TRANSITION_DEG = 1.5 / 60;
/** The distance within which OpenStreetMap's mapped light wins over a generated one (section 7.10). */
export const MAPPED_SNAP_M = 5;

/**
 * Peak candela of each fitting at the top step. ESTIMATED from the photometric minimums of AC 150/5345-46E (L-862
 * high-intensity edge 10,000 cd white in the main beam; L-861 medium-intensity 50 cd all round; L-861T taxiway edge
 * 2 cd blue; L-852 centre line 20 to 100 cd green), AC 150/5345-28H (L-880 PAPI, white over 15,000 cd), AC 150/5345-
 * 51B (L-849 identifier and sequenced flashers, 5,000 to 15,000 cd effective) and AC 150/5345-12F (L-801A beacon,
 * 100,000 cd), rounded toward typical LED fittings. A colour filter's transmission takes the rest: yellow 40 %, red and
 * green 15 to 20 % of white.
 */
export const CANDELA = Object.freeze({
  edgeHigh: 15000, edgeMedium: 200, threshold: 3000, thresholdInset: 2500, end: 1500,
  approach: 8000, approachInset: 3000, flasher: 15000, reil: 8000, papiWhite: 20000,
  centreline: 5000, tdz: 5000, taxiEdge: 25, taxiCentre: 60, beacon: 100000, flood: 30000,
});
const FILTER = { white: 1, yellow: 0.4, red: 0.18, green: 0.2, blue: 1 };

/**
 * Brightness steps by category: the share of the top step each category burns at. Tower-selected intensity is not
 * recorded (7.10): by night in clear air the middle step, in low visibility the top step; by day in clear air only the
 * PAPI (which runs day and night) at its day setting. ESTIMATED: the five steps of a high-intensity system are about
 * 100, 25, 5, 1.2 and 0.25 % (AC 150/5345-10H's constant-current regulator, 6.6 to 2.8 A); three-step systems 100, 30
 * and 10 %. The beacon and the floodlights do not dim; the beacon runs sunset to sunrise (NASR's schedule).
 */
export function levelsFor({ night = true, visibilityM = 80000 } = {}) {
  const low = visibilityM < 5000;
  if (low) return { edge: 1, threshold: 1, approach: 1, flasher: 1, reil: 1, papi: 1, centreline: 1, tdz: 1, taxi: 1, beacon: 1, flood: night ? 1 : 0 };
  if (night) return { edge: 0.05, threshold: 0.05, approach: 0.3, flasher: 0.3, reil: 0.3, papi: 0.05, centreline: 0.05, tdz: 0.05, taxi: 0.3, beacon: 1, flood: 1 };
  return { edge: 0, threshold: 0, approach: 0, flasher: 0, reil: 0, papi: 1, centreline: 0, tdz: 0, taxi: 0, beacon: 0, flood: 0 };
}
export const CATEGORIES = Object.freeze(['edge', 'threshold', 'approach', 'flasher', 'reil', 'papi', 'centreline', 'tdz', 'taxi', 'beacon', 'flood']);

/**
 * Beams (radians). ESTIMATED from the standards' isocandela diagrams: an elevated edge light's main beam is about
 * +-5.5 deg across and 0 to 7 deg up (L-862), with a little all round; approach bars aim up the approach (L-850 and
 * PAR-38 lamps, +-10 deg); the PAPI's beam is +-10 deg across and 0 to 9 deg up; identifier lights aim 10 deg up and
 * 15 deg outward (L-849); floodlights aim steeply down.
 */
const BEAM = {
  edgeHigh: { elev: 4 * DEG, hHalf: 5.5 * DEG, vHalf: 3.5 * DEG, omni: 0.004 },
  edgeMedium: { elev: 4 * DEG, hHalf: 90 * DEG, vHalf: 8 * DEG, omni: 0.3 },
  threshold: { elev: 4 * DEG, hHalf: 6.5 * DEG, vHalf: 4 * DEG, omni: 0.01 },
  inset: { elev: 4 * DEG, hHalf: 6 * DEG, vHalf: 3 * DEG, omni: 0 },
  approach: { elev: 6 * DEG, hHalf: 10 * DEG, vHalf: 6 * DEG, omni: 0.002 },
  reil: { elev: 10 * DEG, hHalf: 15 * DEG, vHalf: 6 * DEG, omni: 0 },
  papi: { elev: 3 * DEG, hHalf: 10 * DEG, vHalf: 5 * DEG, omni: 0 },
  centre: { elev: 4 * DEG, hHalf: 8 * DEG, vHalf: 3 * DEG, omni: 0 },
  taxi: { elev: 5 * DEG, hHalf: 4, vHalf: 10 * DEG, omni: 0.5 },
  beacon: { elev: 5 * DEG, hHalf: 4, vHalf: 4 * DEG, omni: 0 },
  flood: { elev: -65 * DEG, hHalf: 4, vHalf: 22 * DEG, omni: 0.002 },
};

/** Heights of the lamps above the ground they stand on, metres. ESTIMATED: elevated edge and threshold fittings
 * 14 in (L-862 is at most 14 in tall), inset fittings flush, PAPI lamps 2 ft, approach and identifier lights on
 * frangible stands 2 ft at least, floodlight masts 25 m (high-mast apron lighting, 20 to 30 m). */
const HEIGHT = { elevated: 0.35, inset: 0.02, papi: 0.6, stand: 0.6, mast: 25 };

const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const rotate = ([x, y], a) => [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];

/**
 * The candela a light sends toward an eye at map [x, y, z] (at the top step; the CPU twin of lightField.js's vertex
 * stage): its main beam as an elliptical Gaussian about its axis, half intensity at hHalf across and vHalf up, plus its
 * all-round share above its horizon.
 */
export function lobe(l, eye) {
  const ex = eye[0] - l.x, ey = eye[1] - l.y, ez = eye[2] - l.z;
  const h = Math.hypot(ex, ey);
  const el = Math.atan2(ez, h);
  let dh = 0;
  if (l.dir) dh = Math.atan2(Math.abs(ex * l.dir[1] - ey * l.dir[0]), ex * l.dir[0] + ey * l.dir[1]);
  const a = dh / l.hHalf, b = (el - l.elev) / l.vHalf;
  const main = Math.exp(-Math.LN2 * (a * a + b * b));
  const above = Math.min(1, Math.max(0, (el + 0.1) / 0.1));
  return l.candela * (main + l.omni * above);
}

/** A PAPI unit's colour toward an eye: 'white' above its setting, 'red' below (the transition is PAPI_TRANSITION_DEG). */
export function papiColour(l, eye) {
  const h = Math.hypot(eye[0] - l.x, eye[1] - l.y);
  const el = Math.atan2(eye[2] - l.z, h) / DEG;
  return el >= l.papi.setting ? 'white' : 'red';
}

/** The four units' colours of an end's PAPI toward an eye, from the unit nearest the runway outward. */
export function papiColours(layout, end, eye) {
  return layout.lights.filter((l) => l.kind === 'papi' && l.end === end).sort((a, b) => a.papi.unit - b.papi.unit).map((l) => papiColour(l, eye));
}

/**
 * The full light layout of an airport.
 * @param {object} data airport.json
 * @param {{ heightAt: (x: number, y: number) => number, mapped?: boolean }} o heightAt: the ground (geometry.js's
 *   height model: the runway's profile on the runway, the terrain elsewhere); mapped: let OpenStreetMap's lights move
 *   generated ones and add the taxiway lights it maps (default true)
 * @returns {{ lights: object[], slots: object[], groups: object[], residuals: object, pavement: object, counts: object }}
 */
export function layoutLights(data, { heightAt, mapped = true } = {}) {
  const { ends, runways } = runwayFrames(data);
  const pavement = createPavementIndex(data);
  const lights = [];
  let fixtureId = 0;
  const add = (l) => { lights.push({ flash: null, papi: null, inPavement: false, source: 'generated', runway: null, end: null, ...l }); };
  const beamOf = (b) => ({ elev: b.elev, hHalf: b.hHalf, vHalf: b.vHalf, omni: b.omni });

  for (const r of runways) {
    const [na, nb] = r.ends;
    const ea = ends[na], eb = ends[nb];
    const high = (r.data.edgeLightIntensity || 'high') !== 'medium';
    // ---- edge lights: from pavement end to pavement end at most 200 ft apart, on each stretch between the pavement
    // ends and the landing thresholds, 5 ft outside the edge (ESTIMATED: the standard allows 2 to 10 ft; OpenStreetMap
    // maps them 5 ft out at 1L and 19R)
    const breaks = [0, ea.displaced, r.length - eb.displaced, r.length].filter((v, i, a) => i === 0 || v > a[i - 1] + 1);
    const stations = [0];
    for (let i = 1; i < breaks.length; i++) {
      const n = Math.ceil((breaks[i] - breaks[i - 1]) / (200 * FT) - 1e-9);
      for (let k = 1; k <= n; k++) stations.push(breaks[i - 1] + ((breaks[i] - breaks[i - 1]) * k) / n);
    }
    const off = r.width / 2 + 5 * FT;
    const caution = Math.min(CAUTION_M, r.length / 2);
    for (const sA of stations) {
      for (const side of [-1, 1]) {
        const x = r.a[0] + r.u[0] * sA + r.u[1] * off * side, y = r.a[1] + r.u[1] * sA - r.u[0] * off * side;
        const z = r.zAt(sA) + HEIGHT.elevated;
        const fixture = fixtureId++;
        for (const e of [ea, eb]) {
          const s = e.local(x, y).s;
          const colour = s < -0.5 ? 'red' : s > e.toFarEnd - caution + 0.01 ? 'yellow' : 'white';
          const b = high ? BEAM.edgeHigh : BEAM.edgeMedium;
          add({
            kind: 'edge', category: 'edge', x, y, z, colour, candela: (high ? CANDELA.edgeHigh : CANDELA.edgeMedium) * FILTER[colour],
            dir: [-e.L[0], -e.L[1]], ...beamOf(b), runway: r.id, end: e.id, fixture,
          });
        }
      }
    }
  }

  for (const [name, e] of Object.entries(ends)) {
    const d = e.data;
    const half = e.width / 2;
    const out = [-e.L[0], -e.L[1]], inward = [e.L[0], e.L[1]];
    const place = (s, t) => e.toMap(s, t);
    const ground = (x, y) => heightAt(x, y);
    // ---- runway end lights at the pavement end, red toward the runway; where the threshold is not displaced the same
    // fittings show green toward the approach. ESTIMATED: two groups of four 10 ft apart each side, from 5 ft inside to
    // 25 ft outside... the standard's configuration for a 150 ft runway; OpenStreetMap maps them so at 1L (52 to 89 ft
    // from the centre line), 10 ft beyond the pavement end.
    const sEnd = -e.displaced - 5 * FT;
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const t = side * (half - 25 * FT + k * 10 * FT + 5 * FT);
        const [x, y] = place(sEnd, t);
        const z = e.zAt(-e.displaced) + HEIGHT.elevated;
        const fixture = fixtureId++;
        add({ kind: 'runway-end', category: 'threshold', x, y, z, colour: 'red', candela: CANDELA.end, dir: inward, ...beamOf(BEAM.threshold), runway: e.runway.id, end: name, fixture });
        if (e.displaced < 1) add({ kind: 'threshold', category: 'threshold', x, y, z, colour: 'green', candela: CANDELA.threshold, dir: out, ...beamOf(BEAM.threshold), runway: e.runway.id, end: name, fixture });
      }
    }
    if (e.displaced >= 1) {
      // ---- a displaced threshold: wing bars of four green lights outboard of each edge, 10 ft apart from 5 ft outside
      // (ESTIMATED from OpenStreetMap at 1L: 80 to 110 ft from the centre line), and where an approach light system
      // leads to it, a row of inset green lights 10 ft apart across the runway (OpenStreetMap at 1L: 16 of them)
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const [x, y] = place(-1 * FT, side * (half + 5 * FT + k * 10 * FT));
          add({ kind: 'threshold', category: 'threshold', x, y, z: e.zAt(0) + HEIGHT.elevated, colour: 'green', candela: CANDELA.threshold, dir: out, ...beamOf(BEAM.threshold), runway: e.runway.id, end: name, fixture: fixtureId++ });
        }
      }
      if (d.approachLightSystem) {
        for (let t = -half + 5 * FT; t <= half - 5 * FT + 0.01; t += 10 * FT) {
          const [x, y] = place(-6 * FT, t);
          add({ kind: 'threshold', category: 'threshold', x, y, z: e.zAt(-6 * FT) + HEIGHT.inset, colour: 'green', candela: CANDELA.thresholdInset, dir: out, ...beamOf(BEAM.inset), runway: e.runway.id, end: name, fixture: fixtureId++, inPavement: true });
        }
      }
    }

    // ---- approach lights from the system code and its length (NASR), JO 6850.2C: MALS is seven bars of five steady
    // lights every 200 ft to 1,400 ft, the 1,000 ft bar widened by five-light bars either side; MALSF adds sequenced
    // flashers on the outer three bars. ESTIMATED from OpenStreetMap's 45 mapped lights at 1L: lights 2.5 ft apart in a
    // bar, the side bars' inner lights 23.5 ft from the centre line. Inside the pavement (a displaced area) they are
    // inset; beyond it on stands, no lower than the threshold where the ground falls away (up to 20 m).
    const als = d.approachLightSystem;
    if (als && als.system === 'MALS') {
      const length = (als.lengthFt || 1400) * FT;
      const bars = Math.round(length / (200 * FT));
      for (let k = 1; k <= bars; k++) {
        const s = -k * 200 * FT;
        const ts = [-5, -2.5, 0, 2.5, 5].map((v) => v * FT);
        if (Math.abs(k * 200 - 1000) < 1) for (const side of [-1, 1]) for (let j = 0; j < 5; j++) ts.push(side * (23.5 + j * 2.5) * FT);
        for (const t of ts) {
          const [x, y] = place(s, t);
          const inset = -s < e.displaced;
          const z = inset ? e.zAt(s) + HEIGHT.inset : Math.max(ground(x, y) + HEIGHT.stand, Math.min(e.thr[2], ground(x, y) + 20));
          add({ kind: 'approach', category: 'approach', x, y, z, colour: 'white', candela: inset ? CANDELA.approachInset : CANDELA.approach, dir: out, ...beamOf(BEAM.approach), runway: e.runway.id, end: name, fixture: fixtureId++, inPavement: inset });
        }
        if (als.flashers && k > bars - 3) {
          const [x, y] = place(s, 0);
          const inset = -s < e.displaced;
          const z = (inset ? e.zAt(s) + HEIGHT.inset : Math.max(ground(x, y) + HEIGHT.stand, Math.min(e.thr[2], ground(x, y) + 20))) + 0.3;
          add({ kind: 'approach-flasher', category: 'flasher', x, y, z, colour: 'white', candela: CANDELA.flasher, dir: out, ...beamOf(BEAM.approach), runway: e.runway.id, end: name, fixture: fixtureId++, inPavement: inset, flash: { group: `malsf-${name}`, seq: bars - k } });
        }
      }
    }

    // ---- runway end identifier lights: a synchronised pair, 40 ft outside each edge at the threshold, aimed 10 deg up
    // and 15 deg outward (L-849)
    if (d.endIdentifierLights) {
      for (const side of [-1, 1]) {
        const [x, y] = place(0, side * (half + 40 * FT));
        const dir = rotate(out, side * -15 * DEG);
        add({ kind: 'reil', category: 'reil', x, y, z: ground(x, y) + HEIGHT.stand, colour: 'white', candela: CANDELA.reil, dir, ...beamOf(BEAM.reil), runway: e.runway.id, end: name, fixture: fixtureId++, flash: { group: `reil-${name}`, seq: 0 } });
      }
    }

    // ---- PAPI: four units 30 ft apart on the side NASR gives, the innermost 50 ft from the edge, sited where the path
    // at its published angle, crossing the threshold at its published height, meets the units (on the runway's slope)
    if (d.papi && d.papi.lights) {
      const g = d.papi.angle * DEG;
      const tch = (d.papi.crossingHeightFt || d.thresholdCrossingHeightFt || 50) * FT;
      let s = tch / Math.tan(g);
      for (let i = 0; i < 20; i++) s = (e.thr[2] + tch - (e.zAt(s) + HEIGHT.papi)) / Math.tan(g);
      const side = d.papi.side === 'right' ? 1 : -1;
      for (let k = 0; k < d.papi.lights; k++) {
        const [x, y] = place(s, side * (half + 50 * FT + k * 30 * FT));
        add({
          kind: 'papi', category: 'papi', x, y, z: e.zAt(s) + HEIGHT.papi, colour: 'papi', candela: CANDELA.papiWhite, dir: out, ...beamOf(BEAM.papi),
          runway: e.runway.id, end: name, fixture: fixtureId++, papi: { unit: k, setting: d.papi.angle + (PAPI_OFFSETS_DEG[k] ?? 0) },
        });
      }
    }

    // ---- centre-line and touchdown-zone lights, only where the record lists them (none at Las Vegas). Centre line:
    // every 50 ft from 75 ft past the threshold, white, then alternating red and white from 3,000 ft before the far end
    // and red over the last 1,000 ft (AC 150/5340-30J). Touchdown zone: barrettes of three lights 5 ft apart either side
    // of the centre line, the inner lights 36 ft from it, every 100 ft from 100 ft to 3,000 ft or half the runway.
    if (d.centerlineLights) {
      let i = 0;
      for (let s = 75 * FT; s < e.toFarEnd - 1; s += 50 * FT, i++) {
        const left = e.toFarEnd - s;
        const colour = left < 1000 * FT ? 'red' : left < 3000 * FT ? (i % 2 ? 'red' : 'white') : 'white';
        const [x, y] = place(s, 0);
        add({ kind: 'centreline', category: 'centreline', x, y, z: e.zAt(s) + HEIGHT.inset, colour, candela: CANDELA.centreline * FILTER[colour], dir: out, ...beamOf(BEAM.centre), runway: e.runway.id, end: name, fixture: fixtureId++, inPavement: true });
      }
    }
    if (d.tdzLights) {
      const last = Math.min(3000 * FT, e.toOpposite / 2);
      for (let s = 100 * FT; s <= last + 0.01; s += 100 * FT) {
        for (const side of [-1, 1]) {
          for (let j = 0; j < 3; j++) {
            const [x, y] = place(s, side * (36 + j * 5) * FT);
            add({ kind: 'tdz', category: 'tdz', x, y, z: e.zAt(s) + HEIGHT.inset, colour: 'white', candela: CANDELA.tdz, dir: out, ...beamOf(BEAM.centre), runway: e.runway.id, end: name, fixture: fixtureId++, inPavement: true });
          }
        }
      }
    }
  }

  // ---- OpenStreetMap's mapped lights: runway lights move generated ones of their kind within 5 m; taxiway lights are
  // taken as mapped
  const residuals = {};
  const mappedOf = (kind) => (data.lights || []).filter((g) => g.kind === kind);
  if (mapped) {
    const snap = (osmKind, kinds) => {
      const pts = [];
      for (const g of mappedOf(osmKind)) for (let i = 0; i < g.xy.length; i += 2) pts.push([g.xy[i], g.xy[i + 1]]);
      const fixtures = new Map();
      for (const l of lights) if (kinds.includes(l.kind) && !fixtures.has(l.fixture)) fixtures.set(l.fixture, [l.x, l.y]);
      const pairs = [];
      for (const [f, [x, y]] of fixtures) {
        pts.forEach(([px, py], k) => {
          const dd = Math.hypot(px - x, py - y);
          if (dd <= MAPPED_SNAP_M) pairs.push([dd, f, k]);
        });
      }
      pairs.sort((a, b) => a[0] - b[0]);
      const usedF = new Set(), usedP = new Set(), moved = new Map(), ds = [];
      for (const [dd, f, k] of pairs) {
        if (usedF.has(f) || usedP.has(k)) continue;
        usedF.add(f); usedP.add(k); moved.set(f, pts[k]); ds.push(dd);
      }
      for (const l of lights) {
        const p = moved.get(l.fixture);
        if (p && kinds.includes(l.kind)) { l.x = p[0]; l.y = p[1]; l.source = 'osm-position'; }
      }
      residuals[osmKind] = {
        mapped: pts.length, generated: fixtures.size, matched: ds.length,
        mean: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null, max: ds.length ? Math.max(...ds) : null,
      };
    };
    snap('rwe', ['edge']);
    snap('rwt', ['threshold', 'runway-end']);
    snap('als', ['approach', 'approach-flasher']);
    // the PAPI is sited from NASR's angle and crossing height, not moved: OpenStreetMap maps one node per bar, and a
    // bar moved to it would no longer give the published path. The distance to the node is reported.
    const papiNodes = [];
    for (const g of mappedOf('papi')) for (let i = 0; i < g.xy.length; i += 2) papiNodes.push([g.xy[i], g.xy[i + 1]]);
    const dPapi = [];
    for (const name of Object.keys(ends)) {
      const units = lights.filter((l) => l.kind === 'papi' && l.end === name);
      if (!units.length) continue;
      const cx = units.reduce((a, l) => a + l.x, 0) / units.length, cy = units.reduce((a, l) => a + l.y, 0) / units.length;
      const best = Math.min(...papiNodes.map(([x, y]) => Math.hypot(x - cx, y - cy)));
      if (best < 150) dPapi.push(best);
    }
    residuals.papi = { mapped: papiNodes.length, generated: Object.keys(ends).length, matched: dPapi.length, mean: dPapi.length ? dPapi.reduce((a, b) => a + b, 0) / dPapi.length : null, max: dPapi.length ? Math.max(...dPapi) : null, moved: false };

    for (const g of [...mappedOf('txe'), ...mappedOf('txc')]) {
      const kind = g.kind === 'txe' ? 'taxi-edge' : 'taxi-centre';
      const colour = g.colour || (g.kind === 'txe' ? 'blue' : 'green');
      const dir = g.dir === null || g.dir === undefined ? null : [Math.sin(g.dir * DEG), Math.cos(g.dir * DEG)];
      for (let i = 0; i < g.xy.length; i += 2) {
        const x = g.xy[i], y = g.xy[i + 1];
        add({
          kind, category: 'taxi', x, y, z: heightAt(x, y) + (kind === 'taxi-edge' ? HEIGHT.elevated : HEIGHT.inset), colour,
          candela: (kind === 'taxi-edge' ? CANDELA.taxiEdge : CANDELA.taxiCentre) * (colour === 'yellow' ? 0.5 : 1), dir,
          ...beamOf(dir ? { ...BEAM.taxi, hHalf: 30 * DEG, omni: 0.1 } : BEAM.taxi), fixture: fixtureId++, inPavement: kind === 'taxi-centre', source: 'osm',
        });
      }
    }
  }

  // ---- taxiway edge lights where OpenStreetMap maps none: blue, every 200 ft along its centre lines, 2 ft outside the
  // FAA pavement's edge either side (AC 150/5340-30J: at most 200 ft apart on straights, within 10 ft of the edge),
  // where the edge is within 30 m of the centre line (an apron's taxilane has none), away from the runways, and not
  // within 60 m of a mapped taxiway light (that stretch is mapped). ESTIMATED: OpenStreetMap maps the edge lights of
  // only a few taxiways at Las Vegas; most of its taxiways have them.
  const taxiMapped = lights.filter((l) => l.source === 'osm');
  const bucket = new Map();
  const bkey = (x, y) => `${Math.floor(x / 60)},${Math.floor(y / 60)}`;
  for (const l of taxiMapped) { const k = bkey(l.x, l.y); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(l); }
  const nearMapped = (x, y, r) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const l of bucket.get(`${Math.floor(x / 60) + i},${Math.floor(y / 60) + j}`) || []) if (Math.hypot(l.x - x, l.y - y) < r) return true;
    }
    return false;
  };
  const nearRunway = (x, y, margin) => runways.some((r) => {
    const q = r.local(x, y);
    return q.s > -margin - 30 && q.s < r.length + margin + 30 && Math.abs(q.t) < r.width / 2 + margin;
  });
  const placed = [];
  const tooClose = (x, y) => placed.some((p) => Math.abs(p[0] - x) < 20 && Math.abs(p[1] - y) < 20 && Math.hypot(p[0] - x, p[1] - y) < 20);
  for (const tw of data.taxiways || []) {
    if (tw.kind !== 'taxiway') continue;
    const line = tw.line;
    let carry = 0;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i], ay = line[i + 1], bx = line[i + 2], by = line[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
      for (let s = carry; s < len; s += 200 * FT) {
        const x = ax + ux * s, y = ay + uy * s;
        if (nearRunway(x, y, 40) || nearMapped(x, y, 60) || !pavement.on(x, y)) continue;
        for (const side of [-1, 1]) {
          const nx = uy * side, ny = -ux * side;
          let edge = null;
          for (let d = 1; d <= 30; d += 0.5) if (!pavement.on(x + nx * d, y + ny * d)) { edge = d; break; }
          if (edge === null) continue;
          const px = x + nx * (edge + 2 * FT), py = y + ny * (edge + 2 * FT);
          if (nearRunway(px, py, 10) || tooClose(px, py)) continue;
          placed.push([px, py]);
          add({ kind: 'taxi-edge', category: 'taxi', x: px, y: py, z: heightAt(px, py) + HEIGHT.elevated, colour: 'blue', candela: CANDELA.taxiEdge, dir: null, ...beamOf(BEAM.taxi), fixture: fixtureId++ });
        }
      }
      carry = (((carry - len) % (200 * FT)) + 200 * FT) % (200 * FT);
    }
  }

  // ---- the beacon: a white and a green lamp at the beacon (on the tower at Las Vegas), flashing alternately
  if (data.beacon) {
    const b = data.beacon;
    const z = Number.isFinite(b.z) ? b.z : heightAt(b.x, b.y) + 15;
    const perMin = b.flashesPerMinute ? (b.flashesPerMinute[0] + b.flashesPerMinute[1]) / 2 : 27;
    const colours = b.colours?.length ? b.colours : ['white', 'green'];
    for (const c of colours) {
      add({ kind: 'beacon', category: 'beacon', x: b.x, y: b.y, z, colour: c, candela: CANDELA.beacon * (FILTER[c] ?? 1), dir: null, ...beamOf(BEAM.beacon), fixture: fixtureId, flash: { group: `beacon-${c}`, seq: 0, ratePerS: perMin / 60 / colours.length } });
    }
    fixtureId++;
  }

  const maxHalfWidth = Math.max(...runways.map((r) => r.width / 2));
  // ---- apron floodlights: masts along the aprons' outer edges every 70 m, 3 m outside the edge (section 7.10:
  // ESTIMATED, no public record), not within 150 m of a runway's centre line
  for (const ap of data.pavement?.apron || []) {
    const ring = ap.ring;
    const n = ring.length / 2;
    let carry = 35;
    for (let i = 0; i < n; i++) {
      const ax = ring[2 * i], ay = ring[2 * i + 1], bx = ring[2 * ((i + 1) % n)], by = ring[2 * ((i + 1) % n) + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
      // counter-clockwise ring: outward is to the right of the edge
      const nx = uy, ny = -ux;
      for (let s = carry; s < len; s += 70) {
        const x = ax + ux * s + nx * 3, y = ay + uy * s + ny * 3;
        if (pavement.on(ax + ux * s + nx * 10, ay + uy * s + ny * 10) || nearRunway(x, y, 150 - maxHalfWidth)) continue;
        add({ kind: 'flood', category: 'flood', x, y, z: heightAt(x, y) + HEIGHT.mast, colour: 'white', candela: CANDELA.flood, dir: null, ...beamOf(BEAM.flood), fixture: fixtureId++ });
      }
      carry = (((carry - len) % 70) + 70) % 70;
    }
  }

  // ---- slots: one per category (its brightness step), then one per flashing light's place in its group's sequence
  const slots = CATEGORIES.map((c) => ({ id: c, category: c, flash: null }));
  const groups = [];
  const groupIndex = new Map();
  for (const l of lights) {
    if (!l.flash) { l.slot = CATEGORIES.indexOf(l.category); continue; }
    let g = groupIndex.get(l.flash.group);
    if (!g) {
      const kind = l.kind === 'approach-flasher' ? 'run' : l.kind === 'beacon' ? 'beacon' : 'pair';
      // FAA rates: sequenced flashers twice a second (JO 6850.2C), identifier lights 120 a minute (L-849)
      const ratePerS = l.flash.ratePerS ?? 2;
      g = { id: l.flash.group, kind, category: l.category, ratePerS, slots: [], lights: [] };
      groupIndex.set(l.flash.group, g);
      groups.push(g);
    }
    while (g.slots.length <= l.flash.seq) {
      slots.push({ id: `${g.id}#${g.slots.length}`, category: l.category, flash: { group: g.id, seq: g.slots.length } });
      g.slots.push(slots.length - 1);
    }
    l.slot = g.slots[l.flash.seq];
    g.lights.push(lights.indexOf(l));
  }

  const counts = {};
  for (const l of lights) {
    const k = l.runway ? `${l.kind}:${l.runway}` : l.kind;
    counts[k] = (counts[k] || 0) + 1;
  }
  return { lights, slots, groups, residuals, pavement, counts, firstFlashSlot: CATEGORIES.length };
}


/** Whether a flash group is in view from an eye: some light of it sends at least 1 % of its peak toward the eye, from
 * within 40 km. */
export function groupVisible(layout, g, eye) {
  for (const i of g.lights) {
    const l = layout.lights[i];
    if (Math.hypot(eye[0] - l.x, eye[1] - l.y, eye[2] - l.z) > 40000) continue;
    if (lobe(l, eye) >= 0.01 * l.candela) return true;
  }
  return false;
}

/** One pulse: a half sine `w` seconds long from x = 0. */
const pulse = (x, w) => (x >= 0 && x < w ? Math.sin((Math.PI * x) / w) : 0);
const PHI = (Math.sqrt(5) - 1) / 2;

/**
 * Hands flash slots to the groups in view, at most MAX_FLASHES_PER_S a second in total. update(t, visible,
 * reducedMotion) returns each flash slot's level (0..1), in the order of layout.slots from firstFlashSlot; index(slot)
 * gives a slot's place in it. Slot k (every 1 / M seconds, M = min(3, the visible groups' real rates summed)) goes to
 * the group a low-discrepancy sequence picks in proportion to the groups' real rates. A run's lamps pulse PULSE_S long,
 * SEQ_STEP_S apart, so their pulses overlap into one travelling flash. Should the groups in view change, a new slot
 * that would make a fourth flash within a second is skipped.
 * @param {{ groups: object[], slots: object[], firstFlashSlot: number }} layout
 */
export function createFlashSequencer(layout, { max = MAX_FLASHES_PER_S, pulseS = 0.09, seqStepS = 0.04 } = {}) {
  const first = layout.firstFlashSlot;
  const n = layout.slots.length - first;
  const out = new Float32Array(n);
  let starts = [], lastT = -Infinity, lastEvent = null, suppressed = false;
  return {
    index: (slot) => slot - first,
    levels: out,
    update(t, visible, reducedMotion = false) {
      out.fill(0);
      if (reducedMotion) { out.fill(STEADY_DIM); return out; }
      if (t < lastT || t - lastT > 2) { starts = []; lastEvent = null; }
      lastT = t;
      const vis = layout.groups.filter((g, i) => visible[i]);
      const total = vis.reduce((s, g) => s + g.ratePerS, 0);
      if (!total) return out;
      // 4 % under the limit, so that sampling at any frame rate never sees a fourth flash inside one second
      const M = Math.min(max * 0.96, total);
      const k = Math.floor(t * M);
      const tau = t - k / M;
      let u = (k * PHI) % 1, acc = 0, g = vis[vis.length - 1];
      for (const c of vis) { acc += c.ratePerS / total; if (u < acc) { g = c; break; } }
      const key = `${M.toFixed(6)}:${k}:${g.id}`;
      if (key !== lastEvent) {
        // a new event: allowed only if fewer than `max` began within the last second
        lastEvent = key;
        starts = starts.filter((s) => s > t - 1);
        suppressed = tau >= pulseS + seqStepS * (g.slots.length - 1) || starts.length >= max;
        if (!suppressed) starts.push(t - tau);
      }
      if (suppressed) return out;
      g.slots.forEach((slot, seq) => { out[slot - first] = pulse(tau - seq * seqStepS, pulseS); });
      return out;
    },
  };
}
