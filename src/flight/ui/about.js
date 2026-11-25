// "About this flight" (plan 03, section 4.2 and F2.6): the provenance of the flight being looked at, opened from its
// card in the picker and from the flight's bar. What the flight is (date, local time, runway, the type as recorded and
// a plain sentence when it is not the 737-800 that is drawn); where the track comes from (adsb.lol, ODbL) and what is
// deliberately not kept; what is recorded and what is inferred; the weather as flown; the quality report, every gate
// with its number and limit and a waived gate shown as waived; the published approach the final matches; the data
// credits for everything on screen while flying.
//
// Two halves, as ui/windowPanel.js: the pure model (aboutFlight, FLY_CREDITS; unit tested without a DOM, from the
// served header alone) and createAboutPanel, which draws it into a `.pop` dialog.

/** The airframe the app draws for every flight (models/aircraft/spec.py). */
export const DRAWN_TYPE = '737-800';

/** ICAO type designators the selection allows (section 6.2), in words, and how each differs from the one drawn. */
const TYPES = {
  B738: { name: '737-800', note: null },
  B739: { name: '737-900', note: 'The 737-900 is 2.6 m longer, with the same wing, engines and windows, so the view from a window seat is the same; only the length of cabin ahead of and behind the wing differs.' },
  B38M: { name: '737 MAX 8', note: 'The MAX 8 has the same cabin and windows, but larger engines and split-tip winglets, which the drawing does not show.' },
  B39M: { name: '737 MAX 9', note: 'The MAX 9 is 2.6 m longer, with larger engines and split-tip winglets, which the drawing does not show.' },
  B737: { name: '737-700', note: 'The 737-700 is 2.4 m shorter, with the same wing and windows.' },
};

const dateFmt = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });

/** The card's title, as ui/cards.js titleOf words it. */
const titleOf = (h) => `Runway ${h.runway ?? '?'}${h.badges?.from ? `, from the ${h.badges.from}` : ''}`;

function flightPart(h, tz) {
  const d = new Date(h.touchdown);
  const ok = Number.isFinite(d.getTime());
  const code = h.aircraftType || null;
  const t = code ? TYPES[code] : null;
  let type, typeNote = null;
  if (t) {
    type = `${t.name} (recorded type code ${code})`;
    if (t.name !== DRAWN_TYPE) typeNote = `This flight was a ${t.name}. The aircraft drawn is a ${DRAWN_TYPE}, the one airframe the app flies for every flight. ${t.note}`;
  } else {
    type = code ? `recorded type code ${code}` : 'not recorded';
    typeNote = `This flight was recorded as type ${code ?? 'unknown'}. The aircraft drawn is a ${DRAWN_TYPE}, the one airframe the app flies for every flight.`;
  }
  return {
    date: ok ? dateFmt(tz).format(d).replace(',', '') : '',
    time: ok ? timeFmt(tz).format(d).toLowerCase() : '',
    runway: h.runway ?? null,
    type,
    typeNote,
  };
}

const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const ADSBLOL_URL = 'https://www.adsb.lol/';
/** Section 12.2's line for the flight tracks, shown in About and in each flight's provenance. */
export const ADSBLOL_CREDIT = 'Flight tracks: contains information from adsb.lol globe_history, made available under the Open Database License (ODbL) 1.0';

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const NO_LICENCE = 'No licence stated; used with this credit';

/**
 * The data behind everything on screen while flying, in the shape of src/ui/credits.js's groups (that file shows it in
 * "About the data", from the corner label, in every mode); the lines are section 12.2's.
 * @type {{ title: string, items: { name: string, use: string, url: string, licence: string|null, licenceUrl?: string }[] }[]}
 */
export const FLY_CREDITS = [
  {
    title: 'Fly (Las Vegas)',
    items: [
      { name: 'adsb.lol contributors', use: `${ADSBLOL_CREDIT}. The six recorded arrivals; the tracks derived from them are offered under the same licence`, url: ADSBLOL_URL, licence: 'ODbL 1.0', licenceUrl: ODBL_URL },
      { name: '© OpenStreetMap contributors', use: 'The city’s buildings; at the airport the taxiway centre lines and names, stands, gates, jet bridges and mapped lights; the roads that place the region’s town lights', url: OSM_COPYRIGHT, licence: 'ODbL 1.0', licenceUrl: ODBL_URL },
      { name: 'Federal Aviation Administration', use: 'Runways, their ends, markings and lights (NASR); runway, taxiway and apron outlines and airport buildings (airport mapping data); the control tower (Digital Obstacle File); the published approaches (CIFP; not for navigation)', url: 'https://www.faa.gov/air_traffic/flight_info/aeronav/', licence: 'Work of the US government' },
      { name: 'U.S. Geological Survey, via AWS Terrain Tiles', use: 'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey; INEGI, Continuo de Elevaciones Mexicano 3.0; ETOPO1 courtesy of NOAA. The terrain out to the horizon', url: 'https://registry.opendata.aws/terrain-tiles/', licence: 'Open data, with this credit' },
      { name: 'U.S. Geological Survey, 3DEP LiDAR and NAIP imagery', use: 'Building heights at the airport and in the city; the ground imagery at the airport and in the city', url: 'https://www.usgs.gov/3d-elevation-program', licence: 'Public domain' },
      { name: 'NASA Global Imagery Browse Services (GIBS)', use: 'We acknowledge the use of imagery provided by services from NASA’s Global Imagery Browse Services (GIBS), part of NASA’s Earth Science Data and Information System (ESDIS). Blue Marble Next Generation for the ground beyond the valley; Black Marble 2016 for where the region’s towns are lit', url: 'https://nasa-gibs.github.io/gibs-api-docs/', licence: 'NASA open data' },
      { name: 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017)', use: 'The ground under the approaches and over the valley (Sentinel-2 cloudless 2016)', url: 'https://cloudless.eox.at/', licence: 'CC BY 4.0', licenceUrl: CC_BY },
      { name: 'Weather data by Open-Meteo.com', use: 'Wind, temperature and cloud by height for each flight as flown (GFS through the historical forecast API; model data NOAA)', url: 'https://open-meteo.com/', licence: 'CC BY 4.0', licenceUrl: CC_BY },
      { name: 'Iowa Environmental Mesonet of Iowa State University', use: 'The airport’s weather reports at each flight’s time (observations by NOAA / National Weather Service)', url: 'https://mesonet.agron.iastate.edu/', licence: 'Public domain' },
      { name: 'Clark County, the City of Las Vegas, the City of Henderson and Boulder City', use: 'Street lights, seen from the air at night, and the brightness of the region’s towns calibrated on them', url: 'https://services2.arcgis.com/MLoS3Qx4BXmDoTIY/arcgis/rest/services/Fixtures_View/FeatureServer/0', licence: NO_LICENCE },
    ],
  },
];

function trackPart(h) {
  const src = h.source || {};
  return {
    archive: src.archive || 'adsb.lol globe_history',
    release: src.release || null,
    licence: 'Open Database License (ODbL) 1.0',
    credit: ADSBLOL_CREDIT,
    links: [{ href: ADSBLOL_URL, text: 'adsb.lol' }, { href: ODBL_URL, text: 'ODbL 1.0' }],
    about: 'The track is the aircraft’s own ADS-B broadcasts (position, height and speed, about one a second near the airport), received by volunteers’ stations and archived by adsb.lol, then smoothed and checked by this project’s bake (scripts/bake_flight.py). The derived track is offered under the same licence.',
    notKept: 'The airline, flight number, registration and the transponder’s address are not kept in anything the app serves: only the date, the time, the runway and the type.',
  };
}

/** The header's channels in words, in the file's order; x and n are one position. */
const CHANNELS = {
  x: 'Position', n: 'Position', h: 'Height', s: 'Distance flown', gs: 'Ground speed', vs: 'Vertical speed',
  tas: 'True airspeed', ias: 'Airspeed', hdg: 'Heading', pitch: 'Pitch', roll: 'Bank', flap: 'Flaps', slat: 'Slats',
  gear: 'Gear', speedbrake: 'Speed brakes', groundSpoiler: 'Ground spoilers', reverser: 'Reversers', lights: 'Lights',
  cabinLight: 'Cabin light', turbulence: 'Turbulence',
};
const num = (v, d = 0) => new Intl.NumberFormat('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);

function provenancePart(h) {
  const prov = h.provenance || {};
  const notesOf = h.provenanceNotes || {};
  const by = { recorded: [], derived: [], inferred: [] };
  const notes = [];
  for (const ch of h.channels || Object.keys(prov)) {
    const kind = prov[ch], label = CHANNELS[ch] ?? ch;
    if (!by[kind] || by[kind].includes(label)) continue;
    by[kind].push(label);
    notes.push({ channel: ch, label, kind, note: notesOf[ch] ?? null });
  }
  const reconstructed = (h.reconstructed || []).map((r) => `From ${num(r.from)} s to ${num(r.to)} s: ${r.what}`);
  const inf = h.inferred || {};
  const choices = [];
  if (Number.isFinite(inf.weightKg)) choices.push(`Weight about ${num(inf.weightKg / 1000, 1)} t (from the approach speed)`);
  if (Number.isFinite(inf.approachSpeedKt)) choices.push(`Approach speed ${num(inf.approachSpeedKt)} kt`);
  if (Number.isFinite(inf.landingFlap)) choices.push(`Landing flap ${inf.landingFlap}`);
  if (Number.isFinite(inf.gearDownT) && Number.isFinite(h.touchdownT)) choices.push(`Gear down ${num(h.touchdownT - inf.gearDownT)} s before touchdown`);
  if (Number.isFinite(inf.maxCrabDeg)) choices.push(`Largest crab into the wind ${num(inf.maxCrabDeg, 1)}°`);
  return {
    summary: 'Recorded: where the aircraft was, how high and how fast, from its own broadcasts. Derived: what follows from those by arithmetic (heading into the wind, bank in a turn, airspeed). Inferred: what the archive does not carry at all (pitch, flaps, slats, gear, spoilers, reversers, the lights and the cabin light), set by rules from the aircraft’s limits and standard practice. The inferred channels are plausible, not known.',
    ...by,
    notes,
    reconstructed,
    choices,
  };
}

const COVER = { FEW: 'Few clouds', SCT: 'Scattered clouds', BKN: 'Broken cloud', OVC: 'Overcast', VV: 'Sky obscured' };
const WX = { BR: 'mist', HZ: 'haze', FG: 'fog', FU: 'smoke', DU: 'dust', RA: 'rain', DZ: 'drizzle', SN: 'snow', TS: 'thunderstorm', SH: 'showers', VC: 'in the vicinity' };
const wxText = (code) => {
  const m = /^([+-]?)(VC)?([A-Z]+)$/.exec(code || '');
  if (!m) return code;
  const parts = m[3].match(/.{2}/g) || [];
  const words = parts.map((p) => WX[p] ?? p).join(' ');
  return `${m[1] === '-' ? 'light ' : m[1] === '+' ? 'heavy ' : ''}${words}${m[2] ? ' in the vicinity' : ''}`;
};
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

function weatherPart(h) {
  const w = h.weather;
  if (!w) return null;
  const near = w.nearest || {};
  const report = (w.reports || []).find((r) => r.metar === near.metar) || null;
  const lines = [];
  const windKt = near.windKt ?? report?.windKt ?? w.surface?.windKt;
  const gust = report?.gustKt ?? null;
  if (Number.isFinite(windKt)) {
    if (windKt < 1) lines.push('Calm');
    else lines.push(`Wind from ${num(near.windDir ?? report?.windDir ?? 0)}° at ${num(windKt)} kt${Number.isFinite(gust) ? `, gusting ${num(gust)} kt` : ''}`);
  }
  const visMi = near.visibilityMi ?? (report ? report.visibilityM / 1609.344 : null);
  if (Number.isFinite(visMi)) {
    const censored = report ? report.visibilityCensored : visMi >= 10;
    lines.push(censored ? `Visibility ${num(visMi)} miles or more` : `Visibility ${num(visMi, visMi < 3 ? 1 : 0)} miles`);
  }
  const layers = report?.layers || [];
  if (layers.length) {
    for (const l of layers) lines.push(`${COVER[l.cover] ?? l.cover} at ${num(l.baseFtAgl)} ft above the airport (base observed, top estimated)`);
  } else lines.push('No cloud reported');
  const pr = w.precipitation || {};
  if (!pr.kind || pr.kind === 'none') lines.push('No precipitation');
  else lines.push(cap(`${pr.intensity ? `${pr.intensity} ` : ''}${pr.kind}${Number.isFinite(pr.rateMmH) ? `, ${num(pr.rateMmH, 1)} mm an hour` : ''}`));
  for (const c of report?.wx || []) lines.push(cap(wxText(c)));
  const temp = report?.tempC ?? near.tempC;
  if (Number.isFinite(temp)) lines.push(`${num(temp)} °C at the airport`);
  return {
    badge: cap(w.badge || h.badges?.weather || ''),
    report: near.metar || report?.metar || null,
    reportTime: near.valid || report?.valid || null,
    lines,
    about: w.about || '',
    sources: (w.sources || []).map((x) => ({ what: x.what, source: x.source, url: x.url || null })),
  };
}

/** The quality gates of section 7.2 (scripts/bake_flight.py), in words: label, unit, digits. */
const GATES = {
  positionRmsAirM: { label: 'Position against the recorded points, in the air (RMS)', unit: 'm', d: 2 },
  positionRmsLowM: { label: 'Position against the recorded points, below 300 m (RMS)', unit: 'm', d: 2 },
  heightRmsAirM: { label: 'Height against the recorded heights, in the air (RMS)', unit: 'm', d: 2 },
  heightRmsLast60sM: { label: 'Height against the recorded heights, last minute before touchdown (RMS)', unit: 'm', d: 2 },
  glidePathDeg: { label: 'Glide path angle on final', unit: '°', d: 2 },
  crossingHeightM: { label: 'Antenna height over the landing threshold', unit: 'm', d: 1 },
  touchdownPastThresholdM: { label: 'Touchdown past the threshold', unit: 'm', d: 0 },
  touchdownOffCentreM: { label: 'Touchdown off the centre line', unit: 'm', d: 1 },
  bankDeg: { label: 'Steepest bank', unit: '°', d: 1 },
  pitchDeg: { label: 'Pitch, lowest to highest', unit: '°', d: 1 },
  decelerationMs2: { label: 'Hardest braking on the runway', unit: 'm/s²', d: 2 },
  flapPlacard: { label: 'Moments a flap setting was above its placard speed', unit: '', d: 0 },
  flapsMonotonic: { label: 'Flap retractions during the approach', unit: '', d: 0 },
  gearBeforeLandingFlapS: { label: 'Gear down before the landing flap', unit: 's', d: 1 },
  landingLightBy10000ft: { label: 'Landing lights on below 10,000 ft', unit: '', d: 0 },
};
const MINUS = '−';
const signed = (v, d) => (v < 0 ? MINUS : '') + num(Math.abs(v), d);
const withUnit = (t, unit) => (unit === '°' ? `${t}°` : unit ? `${t} ${unit}` : t);
/** A limit's number: as few digits as it needs (12, 3.5, 0.35). */
const lim = (v) => signed(v, Number.isInteger(v) ? 0 : (String(v).split('.')[1] || '').length);

function gateValue(id, g, f) {
  const v = g.value;
  if (v === null || v === undefined) return 'not measured';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return `${withUnit(signed(v[0], f.d), f.unit)} to ${withUnit(signed(v[1], f.d), f.unit)}`;
  return withUnit(signed(v, f.d), f.unit);
}
function gateLimit(id, g, f) {
  const u = (t) => withUnit(t, f.unit);
  if ('maxDiff' in g) return Number.isFinite(g.nearest) ? `within ${lim(g.maxDiff)}° of the published ${num(g.nearest, 2)}°` : `within ${lim(g.maxDiff)}° of a published angle`;
  if ('maxAbs' in g) return `within ${u(lim(g.maxAbs))} either side`;
  if (typeof g.value === 'boolean') return 'yes';
  if ('min' in g && 'max' in g) return `${lim(g.min)} to ${u(lim(g.max))}`;
  if ('max' in g) return g.max === 0 && !f.unit ? 'none' : `at most ${u(lim(g.max))}`;
  if ('min' in g) return id === 'gearBeforeLandingFlapS' ? 'before it' : `at least ${u(lim(g.min))}`;
  return '';
}

function qaPart(h) {
  const qa = h.qa;
  if (!qa) return null;
  const gates = [];
  for (const [id, g] of Object.entries(qa.gates || {})) {
    const f = GATES[id] ?? { label: id, unit: '', d: 2 };
    const state = g.waived ? 'waived' : g.pass ? 'pass' : 'fail';
    gates.push({ id, label: f.label, value: gateValue(id, g, f), limit: gateLimit(id, g, f), state,
      reason: g.waived ? (g.waiver?.reason ?? (qa.waived || []).find((w) => w.gate === id)?.reason ?? null) : null });
  }
  const passed = gates.filter((g) => g.state === 'pass').length;
  const waived = gates.filter((g) => g.state === 'waived').length;
  const failed = gates.filter((g) => g.state === 'fail').length;
  const tail = [waived ? `${waived} waived` : null, failed ? `${failed} failed` : null].filter(Boolean).join(', ');
  const facts = [];
  const cal = qa.calibration || {};
  if (Number.isFinite(cal.offsetM)) facts.push(`Heights reported above the ${cal.datum === 'ellipsoid' ? 'ellipsoid' : cal.datum === 'geoid' ? 'geoid (sea level)' : 'unknown datum'}; the runway calibration moved them by ${signed(cal.offsetM, 1)} m`);
  if (Number.isFinite(qa.touchdownPastThresholdM)) facts.push(`Touchdown ${num(qa.touchdownPastThresholdM)} m past the threshold, ${num(Math.abs(qa.touchdownOffCentreM ?? 0), 1)} m off the centre line`);
  if (qa.touchdownSource) facts.push(`Touchdown time: ${qa.touchdownSource === 'levelled before the surface flag' ? 'where the descent levelled on the runway, before the transponder reported being on the ground' : qa.touchdownSource}`);
  if (Number.isFinite(qa.sunAtTouchdownDeg)) facts.push(`Sun ${num(Math.abs(qa.sunAtTouchdownDeg), 1)}° ${qa.sunAtTouchdownDeg < 0 ? 'below' : 'above'} the horizon at touchdown`);
  if (Number.isFinite(qa.antennaAboveWheelsM)) facts.push(`Heights are the wheels: the antenna taken as ${num(qa.antennaAboveWheelsM, 1)} m above them (an estimate)`);
  return {
    pass: !!qa.pass,
    gates,
    waived,
    failed,
    summary: `${passed} of ${gates.length} checks passed${tail ? `; ${tail}` : ''}`,
    facts,
  };
}

const listText = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The published procedures for the flight's runway end whose angle is the one the QA compared it with (F2.6). A
 * localizer-only procedure is left out where an ILS to the same end has the angle: it shares the ILS's final. */
function approachPart(h, cifp, airport) {
  const g = h.qa?.gates?.glidePathDeg;
  if (!g || !Number.isFinite(g.value)) return null;
  const flown = g.value, nearest = Number.isFinite(g.nearest) ? g.nearest : null;
  const matches = [];
  if (cifp?.approaches && nearest !== null) {
    const same = Object.entries(cifp.approaches).filter(([, a]) => a.runway === h.runway && Math.abs(a.glidePathDeg - nearest) < 0.005);
    const hasIls = same.some(([, a]) => a.type === 'ILS');
    for (const [key, a] of same) {
      if (a.type === 'LOC' && hasIls) continue;
      const letter = key.length > 1 + a.runway.length ? key.slice(-1) : '';
      matches.push({ name: `${a.type}${letter ? ` ${letter}` : ''} RWY ${a.runway}`, type: a.type, angleDeg: a.glidePathDeg, crossingHeightFt: a.crossingHeightFt, finalCourseTrue: a.finalCourseTrue });
    }
  }
  const diff = nearest === null ? null : flown - nearest;
  const how = diff === null ? '' : Math.abs(diff) < 0.005 ? 'exactly on' : `${num(Math.abs(diff), 2)}° ${diff > 0 ? 'steeper' : 'shallower'} than`;
  const allows = Number.isFinite(g.maxDiff) ? `; the check allows ${lim(g.maxDiff)}°.` : '.';
  let sentence;
  if (nearest === null) sentence = `The final was flown at ${num(flown, 2)}°; no published angle for runway ${h.runway} was found to compare it with.`;
  else if (matches.length) sentence = `The final was flown at ${num(flown, 2)}°, ${how} the ${num(nearest, 2)}° glide path of the ${listText(matches.map((m) => m.name))} approach${matches.length > 1 ? 'es' : ''}${cifp.cycle ? ` (FAA CIFP cycle ${cifp.cycle})` : ''}${allows}`;
  else sentence = `The final was flown at ${num(flown, 2)}°, ${how} the nearest published glide path for runway ${h.runway}, ${num(nearest, 2)}°${allows}`;
  const p = airport?.ends?.[h.runway]?.papi;
  const papi = p && Number.isFinite(p.angle) ? `The runway’s ${p.type || 'PAPI'} is set to ${num(p.angle, 2)}°${Number.isFinite(p.crossingHeightFt) ? `, crossing the threshold at ${num(p.crossingHeightFt)} ft` : ''}.` : null;
  return { flownDeg: flown, nearestDeg: nearest, matches, sentence, papi, note: 'Published procedures: FAA Coded Instrument Flight Procedures. Not for navigation.' };
}

/**
 * Everything the panel says about one flight, from its served header. Pure.
 * @param {object} h a flight header (public/data/<city>/flights/<id>.json, format skyline-flight/1)
 * @param {{ tz?: string, cifp?: object, airport?: object }} [o] tz: the airport's time zone; cifp: the airport's
 *   published approaches (data/flights/<city>/cifp-<icao>.json); airport: airport.json (the PAPI of each end)
 */
export function aboutFlight(h, { tz = 'UTC', cifp = null, airport = null } = {}) {
  return {
    id: h.id,
    title: titleOf(h),
    flight: flightPart(h, tz),
    track: trackPart(h),
    provenance: provenancePart(h),
    weather: weatherPart(h),
    qa: qaPart(h),
    approach: approachPart(h, cifp, airport),
    credits: FLY_CREDITS,
  };
}

// ---------------------------------------------------------------- the panel

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const STATE = { pass: 'Passed', fail: 'Failed', waived: 'Waived' };

/** The panel's body for one flight, as HTML (everything given is escaped). Pure. */
export function aboutHtml(a) {
  const f = a.flight, t = a.track, p = a.provenance, w = a.weather, q = a.qa, ap = a.approach;
  const out = [];
  out.push(`<section><h3>This flight</h3><dl>`
    + `<dt>Date</dt><dd>${esc(f.date)}</dd><dt>Touchdown</dt><dd>${esc(f.time)}, local time</dd>`
    + `<dt>Runway</dt><dd>${esc(f.runway)}</dd><dt>Aircraft</dt><dd>${esc(f.type)}</dd></dl>`
    + (f.typeNote ? `<p class="type-note">${esc(f.typeNote)}</p>` : '') + `</section>`);
  out.push(`<section><h3>The track</h3><p>${esc(t.about)}</p>`
    + `<p class="credit">${esc(t.credit)}: ${t.links.map((l) => link(l.href, l.text)).join(', ')}.${t.release ? ` Archive release <code>${esc(t.release)}</code>.` : ''}</p>`
    + `<p>${esc(t.notKept)}</p></section>`);
  out.push(`<section><h3>Recorded and inferred</h3><p>${esc(p.summary)}</p><dl>`
    + `<dt>Recorded</dt><dd>${esc(p.recorded.join(', '))}</dd>`
    + `<dt>Derived</dt><dd>${esc(p.derived.join(', '))}</dd>`
    + `<dt>Inferred</dt><dd>${esc(p.inferred.join(', '))}</dd></dl>`
    + (p.reconstructed.length ? `<p>Reconstructed: ${esc(p.reconstructed.join('; '))}.</p>` : '')
    + (p.choices.length ? `<p>Inferred for this flight: ${esc(p.choices.join('; '))}.</p>` : '')
    + `<details><summary>How each channel was made</summary><ul class="notes">${p.notes.filter((n) => n.note)
      .map((n) => `<li><b>${esc(n.label)}</b> <span class="kind">${esc(n.kind)}</span> ${esc(n.note)}</li>`).join('')}</ul></details></section>`);
  if (w) {
    out.push(`<section><h3>Weather as flown</h3><ul class="lines">${w.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
      + (w.report ? `<p class="metar"><code>${esc(w.report)}</code></p>` : '')
      + `<p class="small">${esc(w.about)} Sources: ${esc(w.sources.map((s) => s.source).join('; '))}.</p></section>`);
  }
  if (q) {
    out.push(`<section><h3>Quality report</h3><p class="qa-summary">${esc(q.summary)}.</p>`
      + `<table class="gates"><thead><tr><th scope="col">Check</th><th scope="col">This flight</th><th scope="col">Limit</th><th scope="col"><span class="vh">Result</span></th></tr></thead><tbody>`
      + q.gates.map((g) => `<tr class="${g.state}" data-gate="${esc(g.id)}"><th scope="row">${esc(g.label)}</th><td>${esc(g.value)}</td><td>${esc(g.limit)}</td>`
        + `<td><span class="state">${STATE[g.state]}</span></td></tr>`
        + (g.reason ? `<tr class="reason"><td colspan="4">${esc(g.reason)}</td></tr>` : '')).join('')
      + `</tbody></table>`
      + (q.facts.length ? `<ul class="lines small">${q.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '') + `</section>`);
  }
  if (ap) {
    out.push(`<section><h3>The published approach</h3><p>${esc(ap.sentence)}</p>${ap.papi ? `<p>${esc(ap.papi)}</p>` : ''}<p class="small">${esc(ap.note)}</p></section>`);
  }
  out.push(`<section><h3>Data credits</h3>${a.credits.map((g) => `<ul class="credits">${g.items.map((c) => `<li>${link(c.url, c.name)}`
    + `<span class="use">${esc(c.use)}${c.licence ? ` · ${c.licenceUrl ? link(c.licenceUrl, c.licence) : esc(c.licence)}` : ''}</span></li>`).join('')}</ul>`).join('')}</section>`);
  return out.join('');
}

const FOCUSABLE = 'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The dialog: one `.pop` the flight's card and the flight's bar open. Keyboard: focus moves into it when it opens and
 * Tab stays inside it; Escape, the close button or a press outside it closes it, and focus goes back to what opened it.
 * The header and airport.json are fetched when first wanted (the browser has them already once the flight is in).
 * @param {{ parent: HTMLElement, data: string, tz: string, flights: object[], cifp?: object, onToggle?: (open: boolean) => void }} o
 *   data: the city's data folder; flights: flights/index.json's entries (their `header` file names)
 */
export function createAboutPanel({ parent, data, tz, flights, cifp = null, onToggle = () => {} }) {
  const base = String(data).replace(/\/$/, '');
  const el = document.createElement('div');
  el.id = 'flightabout';
  el.className = 'pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'flightabout-title');
  el.hidden = true;
  el.innerHTML = `<div class="head"><div><h2 id="flightabout-title">About this flight</h2><span class="sub"></span></div>`
    + `<button class="x" type="button" aria-label="Close"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#i-x" /></svg></button></div>`
    + `<div class="body" tabindex="-1"></div>`;
  parent.append(el);
  const sub = el.querySelector('.sub'), body = el.querySelector('.body'), closeBtn = el.querySelector('.x');
  const cache = new Map();
  let airport = null, returnTo = null, current = null, token = 0;

  const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
  function headerOf(id) {
    if (!cache.has(id)) {
      const entry = flights.find((f) => f.id === id);
      cache.set(id, getJson(`${base}/flights/${entry?.header || `${id}.json`}`).catch((err) => { cache.delete(id); throw err; }));
    }
    return cache.get(id);
  }
  const airportJson = () => (airport ??= getJson(`${base}/airport.json`).catch(() => null));

  async function show(id, from = null) {
    const my = ++token;
    current = id;
    returnTo = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const wasHidden = el.hidden;
    el.hidden = false;
    el.dataset.flight = id;
    if (wasHidden) onToggle(true);
    body.innerHTML = '<p class="small">Loading…</p>';
    sub.textContent = '';
    closeBtn.focus({ preventScroll: true });
    try {
      const [h, ap] = await Promise.all([headerOf(id), airportJson()]);
      if (my !== token || el.hidden) return api;
      const a = aboutFlight(h, { tz, cifp, airport: ap });
      sub.textContent = a.title;
      body.innerHTML = aboutHtml(a);
      body.scrollTop = 0;
    } catch {
      if (my === token) body.innerHTML = '<p class="err">This flight’s details could not be loaded.</p>';
    }
    return api;
  }

  function close() {
    if (el.hidden) return api;
    token++;
    el.hidden = true;
    current = null;
    onToggle(false);
    const back = returnTo;
    returnTo = null;
    if (back?.isConnected && back.offsetParent !== null) back.focus({ preventScroll: true });
    return api;
  }

  closeBtn.addEventListener('click', () => close());
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key !== 'Tab') return;
    // focus stays in the dialog: from the last stop back to the first, and the other way with Shift
    const stops = [...el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  // a press outside closes it, as the app's other popovers; a press on an opener is that opener's
  addEventListener('pointerdown', (ev) => {
    if (!el.hidden && !el.contains(ev.target) && !ev.target.closest?.('[data-about]')) close();
  }, true);

  const api = {
    el,
    get open() { return !el.hidden; },
    get flight() { return current; },
    show,
    close,
    /** Open on a flight, or close it when it is already open on that flight. */
    toggle(id, from) { return !el.hidden && current === id ? close() : show(id, from); },
    dispose() { el.remove(); },
  };
  return api;
}
