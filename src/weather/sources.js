// The upstream requests (plan 01, sections 6.1 and 6.3; task T5.2), built from fixed templates. Every value placed
// in a URL comes from a city entry of data/cities.json or from a month the caller has already validated; nothing
// from a request is passed through. Shared by api/weather.js, the browser fallback (src/weather/service.js), the
// live contract test and, mirrored by hand, scripts/fetch_weather_fixtures.py.

/** Hourly variables every Open-Meteo model request asks for (forecast, archive and historical forecast). */
export const MODEL_VARS = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'surface_pressure', 'cloud_cover', 'cloud_cover_low',
  'cloud_cover_mid', 'cloud_cover_high', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'precipitation', 'rain', 'showers',
  'snowfall', 'weather_code', 'boundary_layer_height'];
export const LEVELS = [850, 700, 500, 300];
/** What the archive lacks (section 6.1, finding 1): visibility, convective indices, freezing level, winds aloft. */
export const FORECAST_VARS = ['visibility', 'cape', 'lifted_index', 'convective_inhibition', 'freezing_level_height',
  ...LEVELS.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`])];
export const AIR_VARS = ['aerosol_optical_depth', 'dust', 'pm10', 'pm2_5'];

export const HOSTS = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
  historicalForecast: 'https://historical-forecast-api.open-meteo.com/v1/forecast',
  air: 'https://air-quality-api.open-meteo.com/v1/air-quality',
  aviationweather: 'https://aviationweather.gov/api/data/metar',
  nws: 'https://api.weather.gov/stations',
  iem: 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py',
};
/** The first month each source has data for (section 6.1). */
export const FIRST_MONTH = { archive: '1940-01', historicalForecast: '2021-07', air: '2022-08' };
/** The live window: from a day back to a week ahead (the date picker's limit, section 4.2). */
export const LIVE_BACK_MS = 24 * 3600000, LIVE_AHEAD_MS = 7 * 24 * 3600000;

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const coords = (city) => ({ latitude: city.origin.lat.toFixed(4), longitude: city.origin.lon.toFixed(4) });
const url = (base, params) => `${base}?${new URLSearchParams(params).toString().replace(/%2C/g, ',')}`;

/** [start, end) of a month 'YYYY-MM', UTC ms. */
export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
}
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

/** The Open-Meteo requests for the live window: forecast hours from a day back to a week ahead, and aerosols. */
export function openMeteoLive(city) {
  const base = { ...coords(city), timeformat: 'unixtime', wind_speed_unit: 'ms' };
  return {
    forecast: url(HOSTS.forecast, { ...base, hourly: [...MODEL_VARS, ...FORECAST_VARS].join(','), past_days: '1', forecast_days: '8' }),
    air: url(HOSTS.air, { ...coords(city), timeformat: 'unixtime', hourly: AIR_VARS.join(','), past_days: '1', forecast_days: '5' }),
  };
}

/**
 * The Open-Meteo requests for one calendar month (UTC): the archive (reanalysis; "best match" fills recent days
 * from forecast models), the historical forecast for what the archive lacks from July 2021, aerosols from August
 * 2022. A month that has not ended stops today. Null for a source that has nothing that month.
 */
export function openMeteoMonth(city, month, nowMs) {
  const [from, to] = monthRange(month);
  const dates = { start_date: iso(from), end_date: iso(Math.min(to - DAY, nowMs)) };
  const base = { ...coords(city), ...dates, timeformat: 'unixtime', wind_speed_unit: 'ms' };
  return {
    archive: url(HOSTS.archive, { ...base, hourly: MODEL_VARS.join(',') }),
    historicalForecast: month >= FIRST_MONTH.historicalForecast ? url(HOSTS.historicalForecast, { ...base, hourly: FORECAST_VARS.join(',') }) : null,
    air: month >= FIRST_MONTH.air ? url(HOSTS.air, { ...coords(city), ...dates, timeformat: 'unixtime', hourly: AIR_VARS.join(',') }) : null,
  };
}

/** aviationweather.gov: the last day of reports. A fixed template: the API rejects any parameter it does not know. */
export const aviationWeatherUrl = (city) => `${HOSTS.aviationweather}?ids=${city.icao}&format=json&hours=24`;
/** The NWS API, the fallback for live observations: the latest 40 (about a day). */
export const nwsUrl = (city) => `${HOSTS.nws}/${city.icao}/observations?limit=40`;

/** The Iowa Environmental Mesonet ASOS archive: every routine and special report of one month, raw METAR kept. */
export function iemMonthUrl(city, month, nowMs) {
  const [from, to] = monthRange(month);
  const end = new Date(Math.min(to, nowMs + DAY));
  const start = new Date(from);
  return url(HOSTS.iem, {
    station: city.iemStation, data: 'all',
    year1: String(start.getUTCFullYear()), month1: String(start.getUTCMonth() + 1), day1: String(start.getUTCDate()),
    year2: String(end.getUTCFullYear()), month2: String(end.getUTCMonth() + 1), day2: String(end.getUTCDate()),
    tz: 'Etc/UTC', format: 'onlycomma', latlon: 'no', elev: 'no', missing: 'M', trace: 'T', direct: 'no',
  }) + '&report_type=3&report_type=4';
}

/** The credit each source asks for (section 12.2), keyed by the source ids of the function's `meta.sources`. */
export const ATTRIBUTION = {
  'open-meteo': 'Weather data by Open-Meteo.com (CC BY 4.0)',
  era5: 'Generated using Copernicus Climate Change Service information (ERA5: Hersbach et al. 2023, doi:10.24381/cds.adbb2d47)',
  'open-meteo-air': 'Generated using Copernicus Atmosphere Monitoring Service information',
  aviationweather: 'Observations: NOAA / National Weather Service (aviationweather.gov)',
  nws: 'Observations: NOAA / National Weather Service (api.weather.gov)',
  iem: 'Archived observations: Iowa Environmental Mesonet of Iowa State University',
};
