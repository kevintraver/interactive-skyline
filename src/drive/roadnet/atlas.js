/**
 * The road texture atlas, shared by the mesher (which writes UVs into it) and the material (which
 * draws it). Pure; draws through any object with `fillStyle` and `fillRect`, so tests can run it
 * under Node with a recording stub.
 *
 * Across (u) the atlas is a row of regions; along (v) the mesh's texture coordinate counts marking
 * cycles, 12.192 m (40 ft) each, keyed on chainage: v = s / CYCLE. The canvas holds V_CYCLES cycles
 * one under the other and the material samples it with a repeat of 1 / V_CYCLES along v, so the
 * asphalt repeats every 48.8 m, not every 12.2 m, while every cycle carries the same markings.
 * Anything drawn that is longer than a few metres (stains, patches) stays inside its own cycle and
 * fades out before the cycle's edge, because a chunk's v starts on any whole cycle: the cycles may
 * come in any order from one chunk to the next, and must meet without a seam whatever the order.
 *
 * Lines sit inside 1 m wide marking regions that the mesher maps to 1 m wide strips centred on
 * each lane boundary, so a line is the same 0.15 m whatever the lane or shoulder width, and every
 * region's border is plain asphalt or dirt. That keeps mipmaps from bleeding one region's line into
 * another, which is what makes the lines hold up at grazing angles together with anisotropic
 * filtering.
 *
 * The first eleven regions are the original layout. The ones after them are variants the mesher
 * picks through `tileFor`: the right-hand lane with more wear, concrete pavement (decks, and runs
 * the road data tags concrete) with its own marking regions, and the expansion joint at each end of
 * a bridge.
 */

export const CYCLE = 12.192; // m: a 10 ft line and a 30 ft gap (MUTCD)
export const DASH = 3.048; // m
export const LINE_W = 0.15; // m: 6 in normal line
export const MARK_W = 1.0; // m: width of a marking strip, centred on its boundary
export const V_CYCLES = 4; // marking cycles stacked along the canvas; the material repeats 1 / V_CYCLES
export const JOINT = 0.3; // m: the expansion joint across the road at each end of a bridge
export const SLAB = CYCLE / 3; // m: transverse joint spacing on concrete pavement (4.06 m; the plan assumes about 4.6)
export const ATLAS_W = 1376;
export const ATLAS_H = 1024;

/** Regions in atlas pixels [u0, u1). Marking regions span MARK_W metres. */
export const REGIONS = {
  lane: [0, 96],
  broken: [96, 160], // white line centred, broken
  solid: [160, 224], // white line centred, solid
  yellow: [224, 288], // lane side at u0; line from the middle 0.15 m towards u1 (the shoulder); rumble strip beyond
  white: [288, 352], // likewise
  shoulder: [352, 448],
  dirt: [448, 512],
  concrete: [512, 576], // decks, parapets, piers, abutments
  gore: [576, 640], // the painted area between a carriageway and a ramp: shoulder asphalt, white chevrons
  steel: [640, 704], // galvanized guardrail, posts and cable barrier
  reflector: [704, 768], // barrier reflectors: white sheeting in the left half, yellow in the right
  // variants (tileFor)
  laneR: [768, 864], // the right-hand lane: deeper wheel paths, more oil
  laneC: [864, 960], // concrete pavement, transverse joints every SLAB
  shoulderC: [960, 1056],
  brokenC: [1056, 1120],
  solidC: [1120, 1184],
  yellowC: [1184, 1248],
  whiteC: [1248, 1312],
  joint: [1312, 1376], // a bridge's expansion joint: plain along v, so any 0.3 m of it reads the same
};

/** Kinds written to the mesh's `kind` attribute. */
export const KIND = { lane: 0, marking: 1, shoulder: 2, embankment: 3, structure: 4, barrier: 5, reflector: 6 };

const PLAIN = new Set(['lane', 'shoulder', 'dirt', 'concrete', 'gore', 'steel', 'laneR', 'laneC', 'shoulderC', 'joint']);
const INSET = 6; // px each side of a plain region that the mesher never addresses, so mips never reach a neighbour

/** u for a fraction t (0..1) across region `name`; plain regions are inset so mips never reach a neighbour. */
export function regionU(name, t) {
  const [a, b] = REGIONS[name];
  const inset = PLAIN.has(name) ? INSET : 0;
  return (a + inset + t * (b - a - 2 * inset)) / ATLAS_W;
}

const CONCRETE_OF = { lane: 'laneC', laneR: 'laneC', shoulder: 'shoulderC', broken: 'brokenC', solid: 'solidC', yellow: 'yellowC', white: 'whiteC' };
/**
 * The region a pavement piece of `region` draws from.
 * @param {string} region the piece's own region (rowPieces)
 * @param {{ concrete?: boolean, joint?: boolean, right?: boolean }} [at] concrete: the pavement is
 *   concrete here; joint: this is a bridge's expansion joint; right: the piece is the right-hand lane
 */
export function tileFor(region, { concrete = false, joint = false, right = false } = {}) {
  if (!(region in CONCRETE_OF)) return region;
  if (joint) return 'joint';
  const r = right && region === 'lane' ? 'laneR' : region;
  return concrete ? CONCRETE_OF[r] : r;
}

/**
 * How the pavement is surfaced over a stretch whose middle is at s: concrete on any bridge and where
 * the road's `surface` runs say concrete, and the expansion joint within JOINT of a bridge's end.
 * @param {{ bridges?: { s0: number, s1: number }[], surface?: { s0: number, kind: string }[] }} road
 */
export function surfaceAt(road, s) {
  let concrete = false, joint = false;
  for (const b of road.bridges || []) {
    if (s > b.s0 && s < b.s1) {
      concrete = true;
      if (b.s1 - b.s0 > 4 * JOINT && (s < b.s0 + JOINT || s > b.s1 - JOINT)) joint = true;
    }
  }
  if (!concrete) {
    let kind = 'asphalt';
    for (const r of road.surface || []) if (r.s0 <= s) kind = r.kind;
    concrete = kind === 'concrete';
  }
  return { concrete, joint };
}

/** Chainages where surfaceAt changes, for the mesher to cut rows at. */
export function surfaceCuts(road) {
  const out = [];
  for (const r of road.surface || []) out.push(r.s0);
  for (const b of road.bridges || []) if (b.s1 - b.s0 > 4 * JOINT) out.push(b.s0 + JOINT, b.s1 - JOINT);
  return out;
}

// Sun-faded desert asphalt; specks kept low in contrast so they read as texture, not blotches.
// The dirt is the average of the aerial photo within 200 m of I-15 (about #969593), so an embankment
// reads as graded ground and not as a painted strip beside it.
// Concrete is a weathered light grey a little warmer and lighter than the shoulder, so decks and
// piers read as structure beside the asphalt without glaring in the desert sun. Concrete pavement is
// a touch darker than that, from tyres. Paint is worn: off-white and a sun-bleached yellow.
const DAY = { lane: '#6a6863', laneSpeck: ['#64625d', '#706e69', '#5f5d58'], shoulder: '#7b766d', shoulderSpeck: ['#747067', '#827d73'],
  dirt: '#989692', dirtSpeck: ['#908e8a', '#a09e99', '#8c8a86'], white: '#dedcd4', yellow: '#d9ae35',
  concrete: '#aaa59b', concreteSpeck: ['#a29d93', '#b1aca2', '#9c978e'], steel: '#a9afb2', steelSpeck: ['#9fa5a8', '#b3b8bb'],
  reflWhite: '#f4f4ef', reflYellow: '#f2c230',
  pave: '#9e9a91', paveSpeck: ['#96928a', '#a6a299', '#918d85'], paveShoulder: '#a49f95', jointSeal: '#57544f', joint: '#4a4a48',
  wear: 1, oil: 'rgba(28,24,20,', light: 'rgba(255,252,244,', dark: 'rgba(20,18,16,' };
// The night paint: markings stand out (they are retroreflective), asphalt barely, dirt not at all. It is not drawn on the
// road: the headlights part reads its marking mask from it (lights/markingMask.js).
const NIGHT = { lane: '#3a3a3a', laneSpeck: ['#363636', '#3e3e3e'], shoulder: '#323231', shoulderSpeck: ['#2e2e2e', '#363635'],
  dirt: '#000000', dirtSpeck: [], white: '#ecebe4', yellow: '#eabd42', concrete: '#1c1c1b', concreteSpeck: [], steel: '#151617', steelSpeck: [],
  // reflectors like the markings
  reflWhite: '#ffffff', reflYellow: '#ffc840',
  pave: '#454543', paveSpeck: ['#404040', '#4a4a48'], paveShoulder: '#3e3e3c', jointSeal: '#262626', joint: '#1a1a1a',
  wear: 0.6, oil: 'rgba(0,0,0,', light: 'rgba(255,255,255,', dark: 'rgba(0,0,0,' };

/** The paint colours, for tests that find the lines among the fills. */
export const PAINT = { day: { white: DAY.white, yellow: DAY.yellow }, night: { white: NIGHT.white, yellow: NIGHT.yellow } };

/** Small deterministic generator, so the texture is the same every load. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** '#rrggbb' scaled by f (f > 1 lightens towards white by f - 1). */
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (f <= 1 ? c * f : c + (255 - c) * (f - 1)));
  return `#${ch.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

const gauss = (x, mu, sig) => Math.exp(-0.5 * ((x - mu) / sig) ** 2);

/**
 * Specks over [u0, u1) x [0, h), `keep(u)` the chance a speck at u is kept (smooth wheel paths).
 * @param {(u: number) => number} [keep]
 */
function specks(ctx, [u0, u1], colors, count, rand, h, keep) {
  if (!colors.length) return;
  for (let i = 0; i < count; i++) {
    const color = colors[(rand() * colors.length) | 0];
    const sz = 1 + ((rand() * 2) | 0);
    const u = u0 + rand() * (u1 - u0 - sz), v = rand() * (h - sz);
    if (keep && rand() > keep(u)) continue;
    ctx.fillStyle = color;
    ctx.fillRect(u, v, sz, sz);
  }
}

/**
 * Wheel paths, crown and oil across a lane region, as a function of t across the lane region (the
 * lane less the half metre of marking strip on each side: for a 3.66 m lane the wheels run 0.93 m
 * and 2.73 m from the left line, t = 0.16 and 0.84).
 */
export const WEAR = { paths: [0.162, 0.838], pathSigma: 0.07, crown: [0.3, 0.7], oil: 0.5, oilSigma: 0.04 };
export function wearAt(t) {
  const path = Math.max(gauss(t, WEAR.paths[0], WEAR.pathSigma), gauss(t, WEAR.paths[1], WEAR.pathSigma));
  const crown = t > WEAR.crown[0] && t < WEAR.crown[1] ? Math.sin(((t - WEAR.crown[0]) / (WEAR.crown[1] - WEAR.crown[0])) * Math.PI) : 0;
  return { path, crown: crown * (1 - gauss(t, WEAR.oil, WEAR.oilSigma * 1.6)), oil: gauss(t, WEAR.oil, WEAR.oilSigma) };
}

/**
 * Draw the atlas into a 2D context of ATLAS_W x ATLAS_H pixels.
 * @param {{ fillStyle: string, fillRect: Function }} ctx
 * @param {{ night?: boolean, seed?: number }} [opts] night: draw the emissive map instead
 */
export function drawRoadAtlas(ctx, { night = false, seed = 7 } = {}) {
  const p = night ? NIGHT : DAY;
  const W = ATLAS_W, H = ATLAS_H;
  const CH = H / V_CYCLES; // pixels per cycle along v
  const pxV = CH / CYCLE; // pixels per metre along v
  const rand = rng(seed);
  const pxM = (name) => (REGIONS[name][1] - REGIONS[name][0]) / MARK_W; // pixels per metre across a marking region
  const fill = (color, u0, v0, w, h) => { ctx.fillStyle = color; ctx.fillRect(u0, v0, w, h); };
  const span = (name) => REGIONS[name][1] - REGIONS[name][0];
  const area = (r) => ((r[1] - r[0]) * H) / 120;
  const rgba = (base, a) => `${base}${a.toFixed(3)})`;
  // t across a plain region for pixel column u
  const tOf = (name, u) => Math.min(1, Math.max(0, (u - REGIONS[name][0] - INSET) / (span(name) - 2 * INSET)));

  /**
   * A soft patch inside one cycle: stacked rectangles that fade towards the edges, kept away from
   * the cycle's top and bottom so the cycles meet without a seam in any order.
   */
  const patch = (u0, u1, cyc, v0, len, base, alpha) => {
    const top = cyc * CH + Math.max(4, Math.min(CH - len * pxV - 4, v0 * pxV));
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const f = k / steps;
      const du = (u1 - u0) * f * 0.25, dv = len * pxV * f * 0.25;
      fill(rgba(base, alpha / steps), u0 + du, top + dv, u1 - u0 - 2 * du, len * pxV - 2 * dv);
    }
  };

  /** Long-period variation over a plain region: faint lighter and darker patches, a few per cycle. */
  const variation = (name, count, alpha) => {
    const [a, b] = REGIONS[name];
    for (let c = 0; c < V_CYCLES; c++) {
      for (let i = 0; i < count; i++) {
        const w = (0.25 + rand() * 0.6) * (b - a), u0 = a + rand() * (b - a - w);
        const len = 1.5 + rand() * 6.5;
        patch(u0, u0 + w, c, rand() * (CYCLE - len), len, rand() < 0.5 ? p.dark : p.light, alpha * (0.5 + rand()));
      }
    }
  };

  /** Sealed cracks: thin dark lines across a region, one in some cycles, wandering a little. */
  const cracks = (name, chance) => {
    const [a, b] = REGIONS[name];
    for (let c = 0; c < V_CYCLES; c++) {
      if (rand() > chance) continue;
      let v = c * CH + 8 + rand() * (CH - 16);
      for (let u = a + INSET; u < b - INSET; u += 4) { v += (rand() - 0.5) * 1.5; fill(rgba(p.dark, night ? 0.06 : 0.11), u, v, 4, 1); }
    }
  };

  /**
   * A lane: base, wheel paths darker and smoother, the crown between them lighter and rougher, oil
   * down the middle. `amount` scales the wear (the right-hand lane carries the trucks).
   */
  const lane = (name, base, speckColors, amount, concrete) => {
    const [a, b] = REGIONS[name];
    const w = amount * p.wear;
    for (let u = a; u < b; u++) {
      const t = tOf(name, u);
      const { path, crown, oil } = wearAt(t);
      const f = 1 - 0.07 * w * path + 0.035 * w * crown - 0.05 * w * oil * (concrete ? 0.5 : 1);
      fill(shade(base, f), u, 0, 1, H);
    }
    // smooth paths: fewer specks there; a rougher crown: more
    specks(ctx, [a, b], speckColors, area([a, b]), rand, H, (u) => {
      const { path, crown } = wearAt(tOf(name, u));
      return Math.min(1, 1 - 0.75 * Math.min(1, w) * path + 0.3 * crown);
    });
    // oil drips: short dark streaks near the middle, each inside its cycle
    const oils = Math.round(12 * amount);
    for (let c = 0; c < V_CYCLES; c++) {
      for (let i = 0; i < oils; i++) {
        const t = WEAR.oil + (rand() - 0.5) * 0.16 * (1 + rand());
        const u = a + INSET + t * (b - a - 2 * INSET);
        const len = (0.2 + rand() * 1.4) * pxV, wd = 1 + rand() * 3;
        const v = c * CH + 2 + rand() * (CH - len - 4);
        fill(rgba(p.oil, (night ? 0.04 : 0.07) * Math.min(1.5, amount) * (concrete ? 0.7 : 1)), u - wd / 2, v, wd, len);
      }
    }
    // tyre polish: a long faint band down each wheel path, broken into pieces per cycle
    for (const t0 of WEAR.paths) {
      const u = a + INSET + t0 * (b - a - 2 * INSET), wd = 0.1 * (b - a);
      for (let c = 0; c < V_CYCLES; c++) patch(u - wd / 2, u + wd / 2, c, 0.5 + rand(), CYCLE - 2, p.dark, 0.05 * w);
    }
    variation(name, 3, night ? 0.015 : 0.03);
    if (!concrete) cracks(name, 0.25);
  };

  /** Concrete transverse joints every SLAB, across [u0, u1). */
  const slabs = (u0, u1) => {
    for (let c = 0; c < V_CYCLES; c++) {
      for (let k = 0; k < Math.round(CYCLE / SLAB); k++) {
        const v = c * CH + k * SLAB * pxV;
        fill(p.jointSeal, u0, v, u1 - u0, 1);
        fill(rgba(p.light, 0.08), u0, v + 1, u1 - u0, 1); // the slab edge catches the light
      }
    }
  };

  /** A marking region's ground: lane-side colour, then shoulder colour beyond the middle for edge regions. */
  const markingGround = (name, laneColor, shoulderColor, laneSpeck, shoulderSpeck, edge) => {
    const [a, b] = REGIONS[name], mid = a + (b - a) / 2;
    if (edge) {
      fill(laneColor, a, 0, mid - a, H); fill(shoulderColor, mid, 0, b - mid, H);
      specks(ctx, [a, mid], laneSpeck, area([a, mid]), rand, H);
      specks(ctx, [mid, b], shoulderSpeck, area([mid, b]), rand, H);
    } else {
      fill(laneColor, a, 0, b - a, H);
      specks(ctx, [a, b], laneSpeck, area([a, b]), rand, H);
    }
  };

  /**
   * Milled shoulder rumble strips just outside an edge line: grooves 7 in along at 12 in centres
   * (40 to a cycle), from 0.03 m beyond the line to the region's edge (0.29 m of the 16 in, which is
   * all a 1 m marking strip has room for).
   */
  const rumble = (name) => {
    const [a, b] = REGIONS[name], px = pxM(name), mid = a + (b - a) / 2;
    const u0 = mid + (LINE_W + 0.03) * px, u1 = b - 1;
    const per = CH / 40, groove = (0.1778 / 0.3048) * per;
    for (let k = 0; k < 40 * V_CYCLES; k++) {
      const v = k * per;
      fill(rgba(p.dark, night ? 0.2 : 0.26), u0, v, u1 - u0, groove * 0.6); // the shaded far wall and floor
      fill(rgba(p.dark, night ? 0.1 : 0.12), u0, v + groove * 0.6, u1 - u0, groove * 0.4);
      fill(rgba(p.light, night ? 0.03 : 0.07), u0, v + groove, u1 - u0, Math.min(1, per - groove)); // the lit lip
    }
  };

  /** Worn paint: the line, then a scatter of asphalt showing through and a little dirt. */
  const line = (color, u, v, w, h, groundSpeck) => {
    fill(color, u, v, w, h);
    const n = Math.round((w * h) / 40);
    for (let i = 0; i < n; i++) {
      const x = u + rand() * (w - 1), y = v + rand() * (h - 1);
      fill(rand() < 0.6 ? groundSpeck[(rand() * groundSpeck.length) | 0] ?? color : shade(color, 0.92), x, y, 1, 1);
    }
  };

  // --- asphalt: lanes, marking regions, shoulder
  lane('lane', p.lane, p.laneSpeck, 0.6, false);
  lane('laneR', p.lane, p.laneSpeck, 1.15, false);
  for (const name of ['broken', 'solid']) markingGround(name, p.lane, p.lane, p.laneSpeck, p.laneSpeck, false);
  for (const name of ['yellow', 'white']) markingGround(name, p.lane, p.shoulder, p.laneSpeck, p.shoulderSpeck, true);
  fill(p.shoulder, REGIONS.shoulder[0], 0, span('shoulder'), H);
  specks(ctx, REGIONS.shoulder, p.shoulderSpeck, area(REGIONS.shoulder) * 1.3, rand, H);
  variation('shoulder', 3, night ? 0.02 : 0.05);
  cracks('shoulder', 0.3);
  fill(p.dirt, REGIONS.dirt[0], 0, span('dirt'), H);
  specks(ctx, REGIONS.dirt, p.dirtSpeck, area(REGIONS.dirt) * 3, rand, H);

  // --- concrete pavement
  lane('laneC', p.pave, p.paveSpeck, 0.5, true);
  for (const name of ['brokenC', 'solidC']) markingGround(name, p.pave, p.pave, p.paveSpeck, p.paveSpeck, false);
  for (const name of ['yellowC', 'whiteC']) markingGround(name, p.pave, p.paveShoulder, p.paveSpeck, p.paveSpeck, true);
  fill(p.paveShoulder, REGIONS.shoulderC[0], 0, span('shoulderC'), H);
  specks(ctx, REGIONS.shoulderC, p.paveSpeck, area(REGIONS.shoulderC), rand, H);
  variation('shoulderC', 2, night ? 0.02 : 0.04);
  slabs(REGIONS.laneC[0], REGIONS.whiteC[1]);
  // the expansion joint: dark seal between steel edges, the same all along v
  {
    const [a, b] = REGIONS.joint;
    fill(p.joint, a, 0, b - a, H);
    for (let u = a + INSET; u < b - INSET; u += 7) fill(shade(p.joint, 1.25), u, 0, 2, H); // the fingers' glint
  }

  // --- structure, gore, barriers
  fill(p.concrete, REGIONS.concrete[0], 0, span('concrete'), H);
  specks(ctx, REGIONS.concrete, p.concreteSpeck, area(REGIONS.concrete) * 2, rand, H);
  fill(p.shoulder, REGIONS.gore[0], 0, span('gore'), H);
  specks(ctx, REGIONS.gore, p.shoulderSpeck, area(REGIONS.gore) * 2, rand, H);
  // chevrons: a white band slanting across the gore once per cycle, 0.6 m wide along the road
  {
    const [g0, g1] = REGIONS.gore;
    const band = 0.6 * pxV;
    const rows = 64;
    for (let c = 0; c < V_CYCLES; c++) {
      for (let r = 0; r < rows; r++) {
        const u0 = g0 + INSET + ((g1 - g0 - 2 * INSET) * r) / rows, w = (g1 - g0 - 2 * INSET) / rows + 0.5;
        const v0 = c * CH + ((CH * 0.25 + (r / rows) * CH * 0.35) % CH);
        fill(p.white, u0, v0, w, band);
      }
    }
  }
  fill(p.steel, REGIONS.steel[0], 0, span('steel'), H);
  specks(ctx, REGIONS.steel, p.steelSpeck, area(REGIONS.steel) * 2, rand, H);
  {
    const [r0, r1] = REGIONS.reflector, mid = (r0 + r1) / 2;
    fill(p.reflWhite, r0, 0, mid - r0, H);
    fill(p.reflYellow, mid, 0, r1 - mid, H);
  }

  // --- rumble strips, then lines last, over everything
  for (const name of ['yellow', 'white', 'yellowC', 'whiteC']) rumble(name);
  const centre = (name) => REGIONS[name][0] + span(name) / 2;
  for (const [sfx, ground] of [['', p.laneSpeck], ['C', p.paveSpeck]]) {
    const lw = LINE_W * pxM('broken' + sfx);
    for (let c = 0; c < V_CYCLES; c++) line(p.white, centre('broken' + sfx) - lw / 2, c * CH, lw, DASH * pxV, ground);
    line(p.white, centre('solid' + sfx) - lw / 2, 0, lw, H, ground);
    line(p.yellow, centre('yellow' + sfx), 0, lw, H, ground);
    line(p.white, centre('white' + sfx), 0, lw, H, ground);
  }
  return { W, H };
}
