// Upstream responses to common units and names (plan 01, sections 6.1 and 6.3; task T5.2). Pure functions, no
// interpretation: fusion lives in derive.js. Imported by api/weather.js, the browser fallback and the tests.
//
// ModelHour    { t, tempC, dewPointC, rh, pressureHPa (at the model's ground), cloud, cloudLow, cloudMid, cloudHigh (0..1),
//                visibilityM, windSpeedMs, windDirDeg, gustMs, precipMm, rainMm, showersMm, snowCm, weatherCode,
//                capeJKg, liftedIndex, cinJKg, freezingLevelM, blhM, aloft: { level, speedMs, dirDeg }[] }   (null = missing)
// AerosolHour  { t, aod550, dustUgM3, pm10UgM3, pm25UgM3 }
// Observation  { t, station, tempC, dewPointC, windDirDeg (null when variable or calm), windVariable, windSpeedMs, gustMs,
//                visibilityM, visibilityCensored, altimeterHPa, clouds: { cover, baseAglM, type }[], skyClear, skyReported,
//                wx: string[], remarks: { virga, tcu, cb, ltg, ts, tsBegin, rainBegin, rainEnd }, precipMm, synthetic, raw }

export const KT_MS = 0.514444, MILE_M = 1609.344, FT_M = 0.3048, INHG_HPA = 33.8639, INCH_MM = 25.4;
/** 10 statute miles: reports at or above it are censored (section 6.4). */
export const TEN_MILES_M = 10 * MILE_M;
const fToC = (f) => (f - 32) / 1.8;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pick = (v) => (isNum(v) ? v : null);
const pct = (v) => (isNum(v) ? v / 100 : null);

// ------------------------------------------------------------------ Open-Meteo

const LEVELS = [850, 700, 500, 300];

/** An Open-Meteo hourly response (`timeformat=unixtime`, `wind_speed_unit=ms`) as ModelHours. */
export function normalizeOpenMeteo(json) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  const col = (name) => (Array.isArray(h[name]) ? h[name] : []);
  const c = Object.fromEntries(Object.keys(h).map((k) => [k, col(k)]));
  const at = (name, i) => pick(c[name]?.[i]);
  return h.time.map((s, i) => ({
    t: s * 1000,
    tempC: at('temperature_2m', i), dewPointC: at('dew_point_2m', i), rh: pct(c.relative_humidity_2m?.[i]),
    pressureHPa: at('surface_pressure', i),
    cloud: pct(c.cloud_cover?.[i]), cloudLow: pct(c.cloud_cover_low?.[i]), cloudMid: pct(c.cloud_cover_mid?.[i]), cloudHigh: pct(c.cloud_cover_high?.[i]),
    visibilityM: at('visibility', i),
    windSpeedMs: at('wind_speed_10m', i), windDirDeg: at('wind_direction_10m', i), gustMs: at('wind_gusts_10m', i),
    precipMm: at('precipitation', i), rainMm: at('rain', i), showersMm: at('showers', i), snowCm: at('snowfall', i),
    weatherCode: at('weather_code', i),
    capeJKg: at('cape', i), liftedIndex: at('lifted_index', i), cinJKg: at('convective_inhibition', i),
    freezingLevelM: at('freezing_level_height', i), blhM: at('boundary_layer_height', i),
    aloft: LEVELS.map((level) => ({ level, speedMs: at(`wind_speed_${level}hPa`, i), dirDeg: at(`wind_direction_${level}hPa`, i) }))
      .filter((w) => w.speedMs !== null && w.dirDeg !== null),
  }));
}

/** Fill the gaps of `base` hours from `extra` hours at the same times (the historical forecast under the archive). */
export function mergeModel(base, extra) {
  if (!extra || !extra.length) return base;
  const byT = new Map(extra.map((h) => [h.t, h]));
  return base.map((h) => {
    const e = byT.get(h.t);
    if (!e) return h;
    const out = { ...h };
    for (const [k, v] of Object.entries(e)) {
      if (k === 'aloft') { if (!h.aloft.length && v.length) out.aloft = v; } else if (out[k] === null && v !== null) out[k] = v;
    }
    return out;
  });
}

/** An Open-Meteo air-quality response as AerosolHours (hours with no optical depth are dropped). */
export function normalizeAirQuality(json) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  return h.time.map((s, i) => ({
    t: s * 1000, aod550: pick(h.aerosol_optical_depth?.[i]), dustUgM3: pick(h.dust?.[i]), pm10UgM3: pick(h.pm10?.[i]), pm25UgM3: pick(h.pm2_5?.[i]),
  })).filter((a) => a.aod550 !== null);
}

// ------------------------------------------------------------------ METAR

const WX = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)?$/;
const SKY = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/;

function fraction(s) {
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b : NaN; }
  return Number(s);
}

/**
 * One METAR (or the archive's METAR-style rendering of an older report) to an Observation without a time: the
 * caller knows the full date. Remarks are read for what the decoded fields drop (section 6.1): TCU and CB, VIRGA,
 * LTG, thunder and rain begin and end, the hourly precipitation group and the precise temperature group.
 */
export function parseMetar(raw) {
  const o = { station: null, tempC: null, dewPointC: null, windDirDeg: null, windVariable: false, windSpeedMs: null, gustMs: null,
    visibilityM: null, visibilityCensored: false, altimeterHPa: null, clouds: [], skyClear: false, skyReported: false, wx: [],
    remarks: { virga: false, tcu: false, cb: false, ltg: false, ts: false, tsBegin: false, rainBegin: false, rainEnd: false },
    precipMm: null, synthetic: /IEM_GHCNH/.test(raw || ''), raw: raw || '' };
  if (!raw || typeof raw !== 'string') return o;
  const [body, rmk = ''] = raw.trim().split(/\s+RMK\s+/);
  const tok = body.split(/\s+/);
  let i = 0;
  if (tok[i] === 'METAR' || tok[i] === 'SPECI') i++;
  if (/^[A-Z0-9]{4}$/.test(tok[i] || '')) o.station = tok[i++];
  if (/^\d{6}Z$/.test(tok[i] || '')) i++;
  for (; i < tok.length; i++) {
    const t = tok[i];
    let m;
    if (t === 'AUTO' || t === 'COR' || t === 'NIL') continue;
    if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(t))) {
      const unit = m[4] === 'KT' ? KT_MS : 1;
      o.windSpeedMs = Number(m[2]) * unit;
      o.gustMs = m[3] ? Number(m[3]) * unit : null;
      o.windVariable = m[1] === 'VRB';
      o.windDirDeg = m[1] === 'VRB' || o.windSpeedMs === 0 ? null : Number(m[1]) % 360;
      continue;
    }
    if (/^\d{3}V\d{3}$/.test(t)) continue;
    // visibility: "10SM", "35SM", "1/2SM", "M1/4SM", "P6SM", or "1 1/2SM" across two tokens
    if (/^\d+$/.test(t) && /^\d\/\d+SM$/.test(tok[i + 1] || '')) {
      o.visibilityM = (Number(t) + fraction(tok[i + 1].slice(0, -2))) * MILE_M;
      i++;
      continue;
    }
    if ((m = /^([MP])?(\d+(?:\/\d+)?)SM$/.exec(t))) {
      const mi = fraction(m[2]);
      o.visibilityM = mi * MILE_M;
      o.visibilityCensored = m[1] === 'P' || mi === 10;
      continue;
    }
    if (/^\d{4}$/.test(t) && o.visibilityM === null && !o.clouds.length) { // metres (international reports)
      o.visibilityM = Number(t) === 9999 ? 10000 : Number(t);
      o.visibilityCensored = Number(t) === 9999;
      continue;
    }
    if (/^R\d{2}[LCR]?\//.test(t)) continue;
    if ((m = SKY.exec(t))) {
      o.skyReported = true;
      o.clouds.push({ cover: m[1], baseAglM: m[2] === '///' ? null : Number(m[2]) * 100 * FT_M, type: m[3] === 'CB' || m[3] === 'TCU' ? m[3] : null });
      continue;
    }
    if (/^(CLR|SKC|NCD|NSC|CAVOK)$/.test(t)) { o.skyReported = true; o.skyClear = true; continue; }
    if ((m = /^(M?\d{2})\/(M?\d{2})?$/.exec(t))) {
      const c = (s) => (s ? (s[0] === 'M' ? -Number(s.slice(1)) : Number(s)) : null);
      o.tempC = c(m[1]);
      o.dewPointC = c(m[2]);
      continue;
    }
    if ((m = /^A(\d{4})$/.exec(t))) { o.altimeterHPa = (Number(m[1]) / 100) * INHG_HPA; continue; }
    if ((m = /^Q(\d{4})$/.exec(t))) { o.altimeterHPa = Number(m[1]); continue; }
    if (t !== '' && WX.test(t) && t !== '+' && t !== '-') o.wx.push(t);
  }
  // remarks
  const r = ` ${rmk} `;
  o.remarks.virga = / VIRGA\b/.test(r);
  o.remarks.tcu = / TCU\b/.test(r) || o.clouds.some((c) => c.type === 'TCU');
  o.remarks.cb = / CB\b/.test(r) || / CBMAM\b/.test(r) || o.clouds.some((c) => c.type === 'CB');
  o.remarks.ltg = / (OCNL |FRQ |CONS )?LTG/.test(r);
  o.remarks.ts = / TS (OHD|DSNT|VC|[NSEW])/.test(r);
  o.remarks.tsBegin = / TSB\d/.test(r);
  o.remarks.rainBegin = / (RA|SHRA|TSRA|DZ)B\d/.test(r) || /[A-Z]RAB\d/.test(r);
  o.remarks.rainEnd = / (RA|SHRA|TSRA|DZ)(B\d+)?E\d/.test(r);
  let m;
  if ((m = / P(\d{4}) /.exec(r))) o.precipMm = (Number(m[1]) / 100) * INCH_MM;
  if ((m = / T([01])(\d{3})([01])(\d{3}) /.exec(r))) {
    o.tempC = (m[1] === '1' ? -1 : 1) * Number(m[2]) / 10;
    o.dewPointC = (m[3] === '1' ? -1 : 1) * Number(m[4]) / 10;
  }
  return o;
}

/** The remark tokens worth showing: what the decoded fields drop. */
export function remarkCodes(o) {
  const out = [];
  if (o.remarks.tcu) out.push('TCU');
  if (o.remarks.cb) out.push('CB');
  if (o.remarks.virga) out.push('VIRGA');
  if (o.remarks.ltg) out.push('LTG');
  return out;
}

// ------------------------------------------------------------------ observation feeds

/** A CSV line with quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The Iowa Environmental Mesonet's ASOS CSV (`format=onlycomma`, `missing=M`) as Observations, oldest first. */
export function parseIemCsv(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const head = splitCsv(lines[0]);
  const ix = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  if (ix.valid === undefined || ix.metar === undefined) return [];
  const num = (row, k) => { const v = row[ix[k]]; return v === undefined || v === 'M' || v === '' || v === 'T' ? null : Number(v); };
  const out = [];
  for (const line of lines.slice(1)) {
    const row = splitCsv(line);
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(row[ix.valid] || '');
    if (!m) continue;
    const o = parseMetar(row[ix.metar]);
    o.t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    o.station = o.station || row[ix.station] || null;
    // the decoded columns where the raw report did not give a value
    if (o.tempC === null && num(row, 'tmpf') !== null) o.tempC = fToC(num(row, 'tmpf'));
    if (o.dewPointC === null && num(row, 'dwpf') !== null) o.dewPointC = fToC(num(row, 'dwpf'));
    if (o.windSpeedMs === null && num(row, 'sknt') !== null) {
      o.windSpeedMs = num(row, 'sknt') * KT_MS;
      o.windDirDeg = o.windSpeedMs > 0 && num(row, 'drct') !== null ? num(row, 'drct') % 360 : null;
    }
    if (o.altimeterHPa === null && num(row, 'alti') !== null) o.altimeterHPa = num(row, 'alti') * INHG_HPA;
    out.push(o);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** aviationweather.gov's METAR JSON (`format=json`) as Observations, oldest first. */
export function parseAviationWeather(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && isNum(r.obsTime)).map((r) => {
    const o = parseMetar(r.rawOb || '');
    o.t = r.obsTime * 1000;
    o.station = o.station || r.icaoId || null;
    if (o.tempC === null) o.tempC = pick(r.temp);
    if (o.dewPointC === null) o.dewPointC = pick(r.dewp);
    if (o.windSpeedMs === null && isNum(r.wspd)) { o.windSpeedMs = r.wspd * KT_MS; o.windDirDeg = isNum(r.wdir) && r.wspd > 0 ? r.wdir % 360 : null; o.windVariable = r.wdir === 'VRB'; }
    if (o.visibilityM === null && r.visib !== undefined && r.visib !== null) {
      const censored = typeof r.visib === 'string' && r.visib.endsWith('+');
      const mi = parseFloat(r.visib);
      if (Number.isFinite(mi)) { o.visibilityM = mi * MILE_M; o.visibilityCensored = censored || mi === 10; }
    }
    if (o.altimeterHPa === null) o.altimeterHPa = pick(r.altim);
    return o;
  }).sort((a, b) => a.t - b.t);
}

const NWS_COVER = { FEW: 'FEW', SCT: 'SCT', BKN: 'BKN', OVC: 'OVC', VV: 'VV' };

/** The NWS API's observation collection as Observations, oldest first. The raw message is parsed when present; the
 * decoded fields fill in (they can stay null for a while after a report). */
export function parseNws(json) {
  const feats = json && Array.isArray(json.features) ? json.features : [];
  const val = (q) => (q && isNum(q.value) ? q.value : null);
  return feats.map((f) => f && f.properties).filter((p) => p && p.timestamp).map((p) => {
    const o = parseMetar(p.rawMessage || '');
    o.t = Date.parse(p.timestamp);
    o.station = o.station || (p.stationId || null);
    if (o.tempC === null) o.tempC = val(p.temperature);
    if (o.dewPointC === null) o.dewPointC = val(p.dewpoint);
    if (o.windSpeedMs === null && val(p.windSpeed) !== null) {
      const kmh = /km_h/.test(p.windSpeed.unitCode || 'km_h');
      o.windSpeedMs = kmh ? val(p.windSpeed) / 3.6 : val(p.windSpeed);
      o.windDirDeg = o.windSpeedMs > 0 && val(p.windDirection) !== null ? val(p.windDirection) % 360 : null;
      if (val(p.windGust) !== null) o.gustMs = kmh ? val(p.windGust) / 3.6 : val(p.windGust);
    }
    if (o.visibilityM === null && val(p.visibility) !== null) {
      o.visibilityM = val(p.visibility);
      o.visibilityCensored = o.visibilityM >= TEN_MILES_M - 1;
    }
    if (!o.skyReported && Array.isArray(p.cloudLayers) && p.cloudLayers.length) {
      for (const l of p.cloudLayers) {
        if (l.amount === 'CLR' || l.amount === 'SKC') { o.skyClear = true; o.skyReported = true; continue; }
        if (NWS_COVER[l.amount]) { o.skyReported = true; o.clouds.push({ cover: NWS_COVER[l.amount], baseAglM: val(l.base), type: null }); }
      }
    }
    return o;
  }).filter((o) => Number.isFinite(o.t)).sort((a, b) => a.t - b.t);
}
