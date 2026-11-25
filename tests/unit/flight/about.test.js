// Plan 03, section 4.2 and F2.6: "About this flight". What the panel says about a recorded flight, from the served
// header alone (public/data/lv/flights/<id>.json): what the flight is, where the track comes from, what is recorded
// and what is inferred, the weather as flown, the quality report with its waivers, the published approach it matches,
// and the data credits for everything on screen while flying. The expected values are the served files' numbers and
// the plan's words, not recomputed the way the code computes them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aboutFlight, aboutHtml, FLY_CREDITS, ADSBLOL_CREDIT } from '../../../src/flight/ui/about.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const header = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/lv/flights', `${id}.json`), 'utf8'));
const TZ = 'America/Los_Angeles';
const CIFP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/flights/lv/cifp-KLAS.json'), 'utf8'));
const AIRPORT = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/lv/airport.json'), 'utf8'));

describe('what the flight is', () => {
  it('gives the real date, the local time of touchdown, the runway and the type as recorded', () => {
    const a = aboutFlight(header('lv-19-dusk'), { tz: TZ });
    expect(a.title).toBe('Runway 19R, from the east');
    expect(a.flight.date).toBe('Monday 9 March 2026');
    expect(a.flight.time).toBe('6:48 pm');
    expect(a.flight.runway).toBe('19R');
    expect(a.flight.type).toBe('737 MAX 8 (recorded type code B38M)');
  });

  it('says plainly when the recorded type is not the 737-800 that is drawn, and says nothing when it is', () => {
    expect(aboutFlight(header('lv-19-day'), { tz: TZ }).flight.typeNote).toMatch(/^This flight was a 737-900\. The aircraft drawn is a 737-800/);
    expect(aboutFlight(header('lv-19-day'), { tz: TZ }).flight.typeNote).toMatch(/2\.6 m longer/);
    expect(aboutFlight(header('lv-19-dusk'), { tz: TZ }).flight.typeNote).toMatch(/^This flight was a 737 MAX 8\. The aircraft drawn is a 737-800/);
    expect(aboutFlight(header('lv-19-night'), { tz: TZ }).flight.typeNote).toBeNull();
  });

  it('names an unknown type code as it was recorded, with the same note', () => {
    const h = { ...header('lv-19-night'), aircraftType: 'A320' };
    const a = aboutFlight(h, { tz: TZ });
    expect(a.flight.type).toBe('recorded type code A320');
    expect(a.flight.typeNote).toMatch(/^This flight was recorded as type A320\. The aircraft drawn is a 737-800/);
  });
});

describe('where the track comes from', () => {
  it('names the archive, its release, the licence with links, and what is deliberately not kept', () => {
    const t = aboutFlight(header('lv-19-dusk'), { tz: TZ }).track;
    expect(t.archive).toBe('adsb.lol globe_history');
    expect(t.release).toBe('v2026.03.10-planes-readsb-staging-0');
    expect(t.licence).toBe('Open Database License (ODbL) 1.0');
    expect(t.links.map((l) => l.href)).toEqual(['https://www.adsb.lol/', 'https://opendatacommons.org/licenses/odbl/1-0/']);
    // section 12.2's line, verbatim
    expect(t.credit).toBe('Flight tracks: contains information from adsb.lol globe_history, made available under the Open Database License (ODbL) 1.0');
    expect(t.notKept).toMatch(/airline, flight number, registration and the transponder.s address are not kept/);
  });
});

describe('what is recorded and what is inferred', () => {
  it('says position, height and speed are recorded, and attitude, flaps, gear, lights and cabin light are inferred', () => {
    const r = aboutFlight(header('lv-19-dusk'), { tz: TZ }).provenance;
    expect(r.recorded).toEqual(['Position', 'Height', 'Ground speed', 'Vertical speed']);
    expect(r.derived).toEqual(expect.arrayContaining(['Heading', 'Bank', 'Airspeed']));
    expect(r.inferred).toEqual(['Pitch', 'Flaps', 'Slats', 'Gear', 'Speed brakes', 'Ground spoilers', 'Reversers', 'Lights', 'Cabin light']);
    expect(r.summary).toMatch(/Recorded: .*position|where the aircraft was/i);
    expect(r.summary).toMatch(/Inferred: .*pitch, flaps/i);
  });

  it('lists the seconds that were reconstructed, and the inferred quantities the bake chose', () => {
    const r = aboutFlight(header('lv-19-dusk'), { tz: TZ }).provenance;
    expect(r.reconstructed).toEqual(['From 1,796 s to 1,799 s: flare: wheel height modelled from 6.0 m to the runway']);
    expect(r.choices).toEqual(expect.arrayContaining(['Weight about 69.7 t (from the approach speed)', 'Landing flap 30', 'Gear down 152 s before touchdown']));
  });

  it('keeps each channel\'s note, so the reader can see how it was made', () => {
    const r = aboutFlight(header('lv-19-dusk'), { tz: TZ }).provenance;
    const pitch = r.notes.find((n) => n.label === 'Pitch');
    expect(pitch.kind).toBe('inferred');
    expect(pitch.note).toMatch(/angle of attack/);
  });
});

describe('the weather as flown', () => {
  it('summarises the airport\'s report nearest touchdown in words, and keeps the report itself', () => {
    const w = aboutFlight(header('lv-19-dusk'), { tz: TZ }).weather;
    expect(w.badge).toBe('Wind');
    expect(w.report).toBe('KLAS 100156Z 16010G21KT 10SM FEW140 23/03 A2983 RMK AO2 SLP088 T02280028');
    expect(w.lines).toEqual([
      'Wind from 160° at 10 kt, gusting 21 kt',
      'Visibility 10 miles or more',
      'Few clouds at 14,000 ft above the airport (base observed, top estimated)',
      'No precipitation',
      '23 °C at the airport',
    ]);
  });

  it('describes an overcast and a low cloud base, and calm air', () => {
    const w = aboutFlight(header('lv-wx'), { tz: TZ }).weather;
    expect(w.badge).toBe('Overcast');
    expect(w.lines).toContain('Calm');
    expect(w.lines).toContain('Visibility 7 miles');
    expect(w.lines).toContain('Overcast at 500 ft above the airport (base observed, top estimated)');
  });

  it('names its sources, observed and estimated', () => {
    const w = aboutFlight(header('lv-19-day'), { tz: TZ }).weather;
    expect(w.about).toMatch(/observed/);
    expect(w.sources.map((s) => s.source)).toEqual(expect.arrayContaining([expect.stringMatching(/Iowa Environmental Mesonet/), expect.stringMatching(/Open-Meteo/)]));
  });
});

describe('the quality report', () => {
  it('lists every gate of the header with its number and limit, in words', () => {
    const q = aboutFlight(header('lv-19-night'), { tz: TZ }).qa;
    expect(q.pass).toBe(true);
    expect(q.gates).toHaveLength(15);
    const g = Object.fromEntries(q.gates.map((x) => [x.id, x]));
    expect(g.glidePathDeg).toMatchObject({ label: 'Glide path angle on final', state: 'pass' });
    expect(g.crossingHeightM.value).toBe('25.8 m');
    expect(g.crossingHeightM.limit).toBe('12 to 32 m');
    expect(g.positionRmsAirM.limit).toBe('at most 12 m');
    expect(g.touchdownOffCentreM.limit).toBe('within 8 m either side');
    expect(g.pitchDeg.value).toBe('−3.6° to 4.9°');
    expect(g.landingLightBy10000ft.value).toBe('yes');
  });

  it('shows the waived gate on the dusk flight as waived, with its number, its limit and the reason', () => {
    const q = aboutFlight(header('lv-19-dusk'), { tz: TZ }).qa;
    const w = q.gates.find((x) => x.id === 'heightRmsLast60sM');
    expect(w.state).toBe('waived');
    expect(w.value).toBe('3.62 m');
    expect(w.limit).toBe('at most 3 m');
    expect(w.reason).toMatch(/noise floor of altitudes reported in 25 ft steps/);
    expect(q.waived).toBe(1);
    expect(q.summary).toBe('14 of 15 checks passed; 1 waived');
    // every other gate passes
    expect(q.gates.filter((x) => x.state === 'pass')).toHaveLength(14);
  });

  it('shows a failed gate as failed', () => {
    const h = header('lv-19-night');
    h.qa = { ...h.qa, pass: false, gates: { ...h.qa.gates, bankDeg: { value: 41.2, maxAbs: 35, pass: false } } };
    const q = aboutFlight(h, { tz: TZ }).qa;
    expect(q.gates.find((x) => x.id === 'bankDeg').state).toBe('fail');
    expect(q.summary).toBe('14 of 15 checks passed; 1 failed');
  });

  it('gives the calibration and the touchdown point', () => {
    const q = aboutFlight(header('lv-19-dusk'), { tz: TZ }).qa;
    expect(q.facts).toEqual(expect.arrayContaining([
      'Heights reported above the ellipsoid; the runway calibration moved them by −29.7 m',
      'Touchdown 364 m past the threshold, 0.3 m off the centre line',
      'Sun 2.0° below the horizon at touchdown',
    ]));
  });
});

describe('the published approach it matches', () => {
  it('names the procedures whose glide path is the nearest published angle for the runway end, as F2.6 compared them', () => {
    const a = aboutFlight(header('lv-19-dusk'), { tz: TZ, cifp: CIFP, airport: AIRPORT }).approach;
    expect(a.flownDeg).toBe(3.37);
    expect(a.nearestDeg).toBe(3.24);
    expect(a.matches.map((m) => m.name)).toEqual(['RNAV (RNP) Z RWY 19R', 'RNAV (GPS) Y RWY 19R']);
    expect(a.sentence).toBe('The final was flown at 3.37°, 0.13° steeper than the 3.24° glide path of the RNAV (RNP) Z RWY 19R and RNAV (GPS) Y RWY 19R approaches (FAA CIFP cycle 2611); the check allows 0.35°.');
    expect(a.papi).toBe('The runway’s PAPI is set to 3.04°, crossing the threshold at 80 ft.');
  });

  it('on runway 26L names the ILS and the PAPI at the same angle', () => {
    const a = aboutFlight(header('lv-26-night'), { tz: TZ, cifp: CIFP, airport: AIRPORT }).approach;
    expect(a.matches.map((m) => m.name)).toEqual(expect.arrayContaining(['ILS Y RWY 26L', 'ILS Z RWY 26L', 'RNAV (RNP) RWY 26L']));
    expect(a.sentence).toMatch(/^The final was flown at 3.06°, 0.06° steeper than the 3.00° glide path of the /);
  });

  it('still says the angle against the nearest published one without the procedure file', () => {
    const a = aboutFlight(header('lv-19-day'), { tz: TZ }).approach;
    expect(a.matches).toEqual([]);
    expect(a.sentence).toBe('The final was flown at 3.35°, 0.11° steeper than the nearest published glide path for runway 19R, 3.24°; the check allows 0.35°.');
  });
});

describe('the data credits while flying', () => {
  const all = FLY_CREDITS.flatMap((g) => g.items);
  const names = all.map((c) => `${c.name} ${c.use} ${c.licence ?? ''}`).join('\n');

  it('credit every source on screen while flying, with the lines section 12.2 asks for', () => {
    expect(all.find((c) => /adsb\.lol/.test(c.name))).toMatchObject({ licence: 'ODbL 1.0', url: 'https://www.adsb.lol/' });
    expect(names).toContain(ADSBLOL_CREDIT);
    for (const must of [/OpenStreetMap contributors/, /Federal Aviation Administration/, /U\.S\. Geological Survey/, /NASA/, /Global Imagery Browse Services/,
      /EOxCloudless/, /Copernicus Sentinel data 2016/, /Open-Meteo/, /Iowa Environmental Mesonet/, /INEGI/]) expect(names).toMatch(must);
  });

  it('give every source a link', () => {
    for (const c of all) expect(c.url).toMatch(/^https:\/\//);
  });

  it('are what the panel shows', () => {
    const a = aboutFlight(header('lv-19-dusk'), { tz: TZ });
    expect(a.credits).toBe(FLY_CREDITS);
  });
});

describe('the panel\'s HTML', () => {
  const html = (id) => aboutHtml(aboutFlight(header(id), { tz: TZ, cifp: CIFP, airport: AIRPORT }));

  it('has a section for each part, in the order of section 4.2', () => {
    const order = ['This flight', 'The track', 'Recorded and inferred', 'Weather as flown', 'Quality report', 'The published approach', 'Data credits'].map((t) => html('lv-19-dusk').indexOf(`<h3>${t}</h3>`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('marks the waived gate as waived, with its reason, and the passed ones as passed', () => {
    const h = html('lv-19-dusk');
    expect(h).toMatch(/<tr class="waived"[^>]*data-gate="heightRmsLast60sM"[\s\S]*?Waived[\s\S]*?noise floor/);
    expect((h.match(/<tr class="pass"/g) || []).length).toBe(14);
  });

  it('shows the type note only when the type differs, and links the archive and its licence', () => {
    expect(html('lv-19-day')).toContain('class="type-note"');
    expect(html('lv-19-night')).not.toContain('class="type-note"');
    expect(html('lv-19-night')).toContain('href="https://www.adsb.lol/"');
    expect(html('lv-19-night')).toContain('href="https://opendatacommons.org/licenses/odbl/1-0/"');
  });

  it('escapes what it is given', () => {
    const h = header('lv-19-night');
    h.badges = { ...h.badges, from: '<img src=x onerror=alert(1)>' };
    expect(aboutHtml(aboutFlight(h, { tz: TZ }))).not.toContain('<img src=x');
  });
});

describe('the credits in "About the data" (src/ui/credits.js) while flying', () => {
  it('include the Fly group, so the corner label reaches every attribution in every mode', async () => {
    const { CREDITS } = await import('../../../src/ui/credits.js');
    expect(CREDITS).toEqual(expect.arrayContaining(FLY_CREDITS));
  });

  it('carry the credit lines the served files ask for, word for word', () => {
    const text = FLY_CREDITS.flatMap((g) => g.items).map((c) => `${c.name} ${c.use}`).join('\n');
    const terrain = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/lv/terrain.json'), 'utf8'));
    for (const id of ['region', 'approaches', 'valley']) {
      const g = terrain.grids[id];
      expect(text, `${id} heights`).toContain(g.source.credit);
      expect(text.replace(/’/g, '\''), `${id} image`).toContain(g.image.credit);
    }
    for (const [k, s] of Object.entries(AIRPORT.sources)) {
      const who = s.credit.split(/[:;(]/)[0].trim();
      const words = { nasr: 'NASR', faaAirportMapping: 'airport mapping data', faaObstacles: 'Digital Obstacle File', osm: 'OpenStreetMap contributors', lidar: '3DEP LiDAR', cityBuildings: 'OpenStreetMap contributors' }[k];
      expect(text, `${k}: ${who}`).toContain(words);
    }
  });
});
