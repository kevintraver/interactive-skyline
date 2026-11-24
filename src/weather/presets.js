// Named weather scenes (plan 01, sections 4.2 and 6.4; task T5.1): each is a complete WeatherSample. Heights are
// given above the ground here and returned above sea level, so a preset looks the same over either city. The
// numbers are typical of the desert South-west (section 6.1, finding 7): dry air, a deep mixed layer by day,
// monsoon storms with high bases and virga.
import { rhFrom } from './schema.js';

export const PRESETS = [
  { id: 'clear', label: 'Clear' },
  { id: 'hazy', label: 'Hazy' },
  { id: 'dusty', label: 'Dusty' },
  { id: 'cumulus', label: 'Fair-weather cumulus' },
  { id: 'cirrus', label: 'High cirrus' },
  { id: 'overcast', label: 'Overcast' },
  { id: 'rain', label: 'Rain' },
  { id: 'monsoon', label: 'Monsoon storm' },
  { id: 'haboob', label: 'Haboob' },
  { id: 'virga', label: 'Virga at sunset' },
];

// [genus, base above ground (m), depth (m), cover]
const SCENES = {
  clear: { tempC: 24, dewPointC: -4, wind: [200, 3, 5], visibilityM: 160000, aod: 0.05, dust: 4, pm25: 4, layer: 2500 },
  hazy: { tempC: 30, dewPointC: 2, wind: [180, 2, 4], visibilityM: 30000, aod: 0.35, dust: 12, pm25: 35, layer: 1800, wx: ['HZ'] },
  dusty: { tempC: 31, dewPointC: -6, wind: [210, 11, 17], visibilityM: 16000, aod: 0.4, dust: 400, pm25: 30, layer: 2500, angstrom: 0.3, wx: ['BLDU'] },
  cumulus: { tempC: 33, dewPointC: 4, wind: [190, 4, 7], visibilityM: 120000, aod: 0.08, dust: 8, pm25: 6, layer: 3000,
    clouds: [['cu', 2800, 900, 0.25]] },
  cirrus: { tempC: 26, dewPointC: -2, wind: [240, 4, 6], visibilityM: 140000, aod: 0.06, dust: 4, pm25: 5, layer: 2200,
    clouds: [['ci', 8800, 1200, 0.45]] },
  overcast: { tempC: 12, dewPointC: 6, wind: [160, 4, 7], visibilityM: 40000, aod: 0.08, dust: 3, pm25: 6, layer: 1200,
    clouds: [['sc', 1200, 700, 1], ['as', 3500, 1800, 0.75]] },
  rain: { tempC: 14, dewPointC: 12, wind: [150, 5, 9], visibilityM: 12000, aod: 0.1, dust: 2, pm25: 6, layer: 900,
    clouds: [['st', 450, 400, 1], ['as', 2500, 2500, 1]], precip: [3, 'rain', false], wx: ['RA', 'BR'] },
  monsoon: { tempC: 34, dewPointC: 15, wind: [140, 9, 18], visibilityM: 30000, aod: 0.15, dust: 40, pm25: 12, layer: 3500,
    clouds: [['cb', 2600, 9500, 0.45], ['ac', 4500, 600, 0.3], ['ci', 10500, 1200, 0.6]], precip: [12, 'rain', true],
    storm: [true, 6, 2, 1500], wx: ['TSRA'] },
  haboob: { tempC: 36, dewPointC: 10, wind: [150, 18, 27], visibilityM: 1200, aod: 1.8, dust: 6000, pm25: 250, layer: 2000, angstrom: 0.1,
    clouds: [['cb', 3000, 8500, 0.35]], storm: [true, 1, 1, 1200], dustWall: [150, 6000, 15, 1500], wx: ['VCTS', 'DS', 'BLDU'] },
  virga: { tempC: 35, dewPointC: 2, wind: [200, 5, 9], visibilityM: 110000, aod: 0.09, dust: 15, pm25: 7, layer: 3800,
    clouds: [['ac', 3600, 900, 0.4], ['tcu', 3200, 3500, 0.2]], precip: [0, 'virga', true], virgaAgl: 3200, wx: ['VIRGA'] },
};

/**
 * The preset `id` (the clear one if unknown) as a complete sample at time `t`, over ground at `groundM` metres.
 * Returns a fresh object every time.
 */
export function presetSample(id, t, groundM) {
  const p = SCENES[id] || SCENES.clear;
  const [dirDeg, speedMs, gustMs] = p.wind;
  const clouds = (p.clouds || [])
    .map(([genus, agl, depth, cover]) => ({ genus, baseM: groundM + agl, topM: groundM + agl + depth, cover }))
    .sort((a, b) => a.baseM - b.baseM);
  const [rateMmH, kind, convective] = p.precip || [0, 'none', false];
  const [thunder, flashRatePerMin, cells, capeJKg] = p.storm || [false, 0, 0, null];
  return {
    t, source: { surface: 'preset', clouds: 'preset', aerosol: 'preset' },
    tempC: p.tempC, dewPointC: p.dewPointC, rh: rhFrom(p.tempC, p.dewPointC),
    pressureHPa: 1013.25 * (1 - 2.25577e-5 * groundM) ** 5.25588,
    wind: { dirDeg, speedMs, gustMs },
    windAloft: [],
    visibilityM: p.visibilityM, visibilityCensored: false,
    aerosol: { aod550: p.aod, angstrom: p.angstrom ?? 1.3, dustUgM3: p.dust, pm25UgM3: p.pm25, layerHeightM: p.layer },
    clouds,
    precip: { rateMmH, kind, convective, virgaBaseM: p.virgaAgl ? groundM + p.virgaAgl : null },
    storm: { thunder, flashRatePerMin, cells, capeJKg },
    dustWall: p.dustWall ? { active: true, bearingDeg: p.dustWall[0], distanceM: p.dustWall[1], speedMs: p.dustWall[2], heightM: p.dustWall[3] } : null,
    wxCodes: [...(p.wx || [])],
  };
}

export const presetLabel = (id) => (PRESETS.find((p) => p.id === id) || PRESETS[0]).label;
