// What the weather chip and its source line say (plan 01, section 4.2; tasks T5.3 and T5.5). Pure: a sample, a status
// and the visitor's units in, text out.
import { presetLabel } from './presets.js';
import { OVERRIDES } from './overrides.js';

const MILE = 1609.344;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** One or two words for the sky, the way a forecast would put it. */
export function summarize(s) {
  const wx = s.wxCodes.join(' ');
  if (s.dustWall && s.dustWall.active) return 'Dust storm';
  if (s.storm.thunder) return /(^|\s)[-+]?TS/.test(wx) || s.storm.flashRatePerMin >= 6 ? 'Thunderstorm' : 'Thunder nearby';
  if (s.precip.kind === 'snow') return s.precip.rateMmH >= 4 ? 'Heavy snow' : 'Snow';
  if (s.precip.kind === 'rain') return s.precip.rateMmH >= 8 ? 'Heavy rain' : s.precip.rateMmH < 2 ? 'Light rain' : 'Rain';
  if (s.precip.kind === 'drizzle') return 'Drizzle';
  if (s.precip.kind === 'hail') return 'Hail';
  if (s.visibilityM < 10000) {
    if (/FG/.test(wx) || s.visibilityM < 1000) return 'Fog';
    if (/DU|SA|SS|DS/.test(wx) || s.aerosol.dustUgM3 > 300) return 'Blowing dust';
    if (/FU/.test(wx)) return 'Smoke';
    if (/BR/.test(wx)) return 'Mist';
    return 'Haze';
  }
  if (s.precip.kind === 'virga') return 'Virga';
  const cover = s.clouds.reduce((m, c) => Math.max(m, c.cover), 0);
  const any = 1 - s.clouds.reduce((p, c) => p * (1 - c.cover), 1);
  const total = Math.max(cover, any);
  if (total < 0.1) return s.aerosol.dustUgM3 > 200 || /DU|SA/.test(wx) ? 'Dusty' : s.aerosol.aod550 > 0.25 || /HZ|FU/.test(wx) ? 'Hazy' : 'Clear';
  if (total < 0.3) return s.clouds.every((c) => c.genus === 'ci' || c.genus === 'cs') ? 'High cloud' : 'Few clouds';
  if (total < 0.6) return 'Partly cloudy';
  if (total < 0.95) return 'Mostly cloudy';
  return 'Overcast';
}

/** Visibility, temperature and wind in the visitor's units ('ft': miles, °F, mph; 'm': km, °C, km/h). */
export function formatWeather(s, units = 'ft') {
  const metric = units === 'm';
  let vis;
  if (metric) vis = s.visibilityM >= 10000 ? `${Math.round(s.visibilityM / 1000)} km` : `${(s.visibilityM / 1000).toFixed(1)} km`;
  else {
    const mi = s.visibilityM / MILE;
    vis = s.visibilityCensored && mi >= 9.95 ? '10+ mi' : mi >= 10 ? `${Math.round(mi)} mi` : `${mi < 1 ? mi.toFixed(2) : mi.toFixed(1)} mi`;
  }
  const temp = metric ? `${Math.round(s.tempC)} °C` : `${Math.round(s.tempC * 1.8 + 32)} °F`;
  const speed = metric ? Math.round(s.wind.speedMs * 3.6) : Math.round(s.wind.speedMs * 2.23694);
  const wind = speed === 0 ? 'calm' : `${compass(s.wind.dirDeg)} ${speed} ${metric ? 'km/h' : 'mph'}`;
  return [summarize(s), vis, temp, wind].join(' · ');
}

const SOURCE_NAME = { 'open-meteo': 'Open-Meteo', 'open-meteo-historical': 'Open-Meteo', 'open-meteo-air': 'aerosols', aviationweather: 'reports', nws: 'reports', iem: 'archived reports' };

/**
 * The source line: where the chip's numbers come from, what answered and what did not.
 * @param {object} st  service.status(t)
 * @param {{ time: (ms) => string, date: (ms) => string }} fmt  in the city's zone
 */
export function describeSource(st, fmt) {
  if (st.kind === 'preset') return `Preset: ${presetLabel(st.preset)}`;
  if (st.loading) return 'Loading the weather…';
  if (st.unavailable) return 'Weather unavailable · showing Clear';
  const parts = [];
  if (st.kind === 'history') parts.push(`This date in ${st.year}`);
  else parts.push(st.dataKind === 'live' ? 'Live' : `History · ${fmt.date(st.dataTimeMs)}`);
  if (st.observedAtMs !== null) parts.push(`${st.station} report ${fmt.time(st.observedAtMs)}`);
  parts.push(st.dataKind === 'live' ? 'forecast model' : 'reanalysis');
  if (st.aerosol === 'climatology') parts.push('aerosols: climatology');
  if (st.via === 'open-meteo') parts.push('reports unavailable');
  const failed = [...new Set(st.sources.filter((x) => !x.ok && !(x.id === 'aviationweather' && st.sources.some((y) => y.id === 'nws' && y.ok)))
    .map((x) => SOURCE_NAME[x.id] || x.id))];
  if (failed.length && st.via !== 'open-meteo') parts.push(`no ${failed.join(', ')}`);
  if (st.stale) parts.push('not updated lately');
  return parts.join(' · ');
}

/** What the chip says first when something departs from data (section 4.2: every override is visible). */
export function describeOverride(st) {
  const labels = st.overridden.map((k) => (OVERRIDES.find((o) => o.key === k) || { label: k }).label.toLowerCase());
  if (st.kind === 'preset') return labels.length ? `Preset: ${presetLabel(st.preset)}, adjusted: ${labels.join(', ')}` : `Preset: ${presetLabel(st.preset)}`;
  if (labels.length) return `Adjusted: ${labels.join(', ')}`;
  return null;
}
