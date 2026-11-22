/**
 * The road texture atlas, shared by the mesher (which writes UVs into it) and the material (which
 * draws it). Pure; draws through any object with `fillStyle` and `fillRect`, so tests can run it
 * under Node with a recording stub.
 *
 * Across (u) the atlas is a row of regions; along (v) it is one marking cycle, 12.192 m (40 ft),
 * repeating, keyed on chainage: v = s / CYCLE. Lines sit inside 1 m wide marking regions that the
 * mesher maps to 1 m wide strips centred on each lane boundary, so a line is the same 0.15 m
 * whatever the lane or shoulder width, and every region's border is plain asphalt or dirt. That
 * keeps mipmaps from bleeding one region's line into another, which is what makes the lines
 * hold up at grazing angles together with anisotropic filtering.
 */

export const CYCLE = 12.192; // m: a 10 ft line and a 30 ft gap (MUTCD)
export const DASH = 3.048; // m
export const LINE_W = 0.15; // m: 6 in normal line
export const MARK_W = 1.0; // m: width of a marking strip, centred on its boundary
export const ATLAS_W = 640;
export const ATLAS_H = 512;

/** Regions in atlas pixels [u0, u1). Marking regions span MARK_W metres. */
export const REGIONS = {
  lane: [0, 96],
  broken: [96, 160], // white line centred, broken
  solid: [160, 224], // white line centred, solid
  yellow: [224, 288], // lane side at u0; line from the middle 0.15 m towards u1 (the shoulder)
  white: [288, 352], // likewise
  shoulder: [352, 448],
  dirt: [448, 512],
  concrete: [512, 576], // decks, parapets, piers, abutments
  gore: [576, 640], // the painted area between a carriageway and a ramp: shoulder asphalt, white chevrons
};

/** Kinds written to the mesh's `kind` attribute. */
export const KIND = { lane: 0, marking: 1, shoulder: 2, embankment: 3, structure: 4 };

/** u for a fraction t (0..1) across region `name`; plain regions are inset so mips never reach a neighbour. */
export function regionU(name, t) {
  const [a, b] = REGIONS[name];
  const inset = name === 'lane' || name === 'shoulder' || name === 'dirt' || name === 'concrete' || name === 'gore' ? 6 : 0;
  return (a + inset + t * (b - a - 2 * inset)) / ATLAS_W;
}

// sun-faded desert asphalt; specks kept low in contrast so they read as texture, not blotches.
// The dirt is the average of the aerial photo within 200 m of I-15 (about #969593), so an embankment
// reads as graded ground and not as a painted strip beside it.
// Concrete is a weathered light grey a little warmer and lighter than the shoulder, so decks and
// piers read as structure beside the asphalt without glaring in the desert sun.
const DAY = { lane: '#6a6863', laneSpeck: ['#64625d', '#706e69', '#5f5d58'], shoulder: '#7b766d', shoulderSpeck: ['#747067', '#827d73'],
  dirt: '#989692', dirtSpeck: ['#908e8a', '#a09e99', '#8c8a86'], white: '#e9e8e2', yellow: '#e3b42c',
  concrete: '#aaa59b', concreteSpeck: ['#a29d93', '#b1aca2', '#9c978e'] };
// Emissive map for the night look: markings stand out (they are retroreflective; this stands in
// for headlights until they exist), asphalt barely, dirt not at all.
const NIGHT = { lane: '#3a3a3a', laneSpeck: ['#363636', '#3e3e3e'], shoulder: '#323231', shoulderSpeck: ['#2e2e2e', '#363635'],
  dirt: '#000000', dirtSpeck: [], white: '#f0f0ea', yellow: '#f0c040', concrete: '#1c1c1b', concreteSpeck: [] };

/** Small deterministic generator, so the texture is the same every load. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function specks(ctx, [u0, u1], colors, count, rand, h) {
  if (!colors.length) return;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(rand() * colors.length) | 0];
    const sz = 1 + ((rand() * 2) | 0);
    ctx.fillRect(u0 + rand() * (u1 - u0 - sz), rand() * (h - sz), sz, sz);
  }
}

/**
 * Draw the atlas into a 2D context of ATLAS_W x ATLAS_H pixels.
 * @param {{ fillStyle: string, fillRect: Function }} ctx
 * @param {{ night?: boolean, seed?: number }} [opts] night: draw the emissive map instead
 */
export function drawRoadAtlas(ctx, { night = false, seed = 7 } = {}) {
  const p = night ? NIGHT : DAY;
  const W = ATLAS_W, H = ATLAS_H;
  const rand = rng(seed);
  const pxM = (name) => (REGIONS[name][1] - REGIONS[name][0]) / MARK_W; // pixels per metre across a marking region
  const fill = (color, u0, v0, w, h) => { ctx.fillStyle = color; ctx.fillRect(u0, v0, w, h); };

  // ground colours; marking regions are lane asphalt on the lane side, shoulder asphalt beyond an edge line
  fill(p.lane, 0, 0, REGIONS.yellow[0], H);
  for (const name of ['yellow', 'white']) {
    const [a, b] = REGIONS[name];
    const mid = a + (b - a) / 2;
    fill(p.lane, a, 0, mid - a, H);
    fill(p.shoulder, mid, 0, b - mid, H);
  }
  fill(p.shoulder, REGIONS.shoulder[0], 0, REGIONS.shoulder[1] - REGIONS.shoulder[0], H);
  fill(p.dirt, REGIONS.dirt[0], 0, REGIONS.dirt[1] - REGIONS.dirt[0], H);
  const area = (r) => ((r[1] - r[0]) * H) / 60;
  specks(ctx, [0, REGIONS.yellow[0]], p.laneSpeck, area([0, REGIONS.yellow[0]]), rand, H);
  specks(ctx, REGIONS.shoulder, p.shoulderSpeck, area(REGIONS.shoulder), rand, H);
  specks(ctx, REGIONS.dirt, p.dirtSpeck, area(REGIONS.dirt) * 3, rand, H);

  fill(p.concrete, REGIONS.concrete[0], 0, REGIONS.concrete[1] - REGIONS.concrete[0], H);
  specks(ctx, REGIONS.concrete, p.concreteSpeck, area(REGIONS.concrete), rand, H);
  fill(p.shoulder, REGIONS.gore[0], 0, REGIONS.gore[1] - REGIONS.gore[0], H);
  specks(ctx, REGIONS.gore, p.shoulderSpeck, area(REGIONS.gore), rand, H);
  // chevrons: a white band slanting across the gore once per cycle, 0.6 m wide along the road
  {
    const [g0, g1] = REGIONS.gore;
    const band = (0.6 / CYCLE) * H;
    const rows = 64;
    for (let r = 0; r < rows; r++) {
      const u0 = g0 + 6 + ((g1 - g0 - 12) * r) / rows, w = (g1 - g0 - 12) / rows + 0.5;
      const v0 = (H * 0.25 + (r / rows) * H * 0.35) % H;
      fill(p.white, u0, v0, w, band);
    }
  }

  // lines last, over the specks
  const lw = LINE_W * pxM('broken');
  const centre = (name) => REGIONS[name][0] + (REGIONS[name][1] - REGIONS[name][0]) / 2;
  fill(p.white, centre('broken') - lw / 2, 0, lw, (DASH / CYCLE) * H);
  fill(p.white, centre('solid') - lw / 2, 0, lw, H);
  fill(p.yellow, centre('yellow'), 0, lw, H);
  fill(p.white, centre('white'), 0, lw, H);
}
