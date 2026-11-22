// T5.4: from weather to medium (plan 01, sections 6.4, 7.5 and 8.2). The acceptance lines of T5.4, the fusion of
// each recorded day against expectations read off its raw reports by hand, and properties: more optical depth never
// raises visibility; applying the medium writes the right numbers into an atmosphere's uniforms.
import { describe, it, expect } from 'vitest';
import cities from '../../../data/cities.json' with { type: 'json' };
import lvClimatology from '../../../public/data/lv/aerosol.json' with { type: 'json' };
import slcClimatology from '../../../public/data/slc/aerosol.json' with { type: 'json' };
import { KOSCHMIEDER, rayleighExtinction, aerosolExtinction, visibilityFromAerosol, atmosphereMedium, setAtmosphereFromWeather,
  ATMOSPHERE_UNIFORMS, fuse, modelAt, stationPressure, COVER, TS_BASE_AGL } from '../../../src/weather/derive.js';
import { normalizeOpenMeteo, normalizeAirQuality, mergeModel, parseIemCsv, parseMetar, MILE_M, FT_M } from '../../../src/weather/normalize.js';
import { validateSample } from '../../../src/weather/schema.js';
import { presetSample, PRESETS } from '../../../src/weather/presets.js';
import { rand } from '../../../src/core/rng.js';
import { loadFixture, fixtureLabels } from '../../helpers/weatherFixtures.js';

const CLIM = { lv: lvClimatology, slc: slcClimatology };
const ground = (city) => cities[city].stationElevationM;
function seriesOf(city, day) {
  const r = loadFixture(city, day).responses;
  return {
    model: mergeModel(normalizeOpenMeteo(r['open-meteo'].body), r['open-meteo-historical'] ? normalizeOpenMeteo(r['open-meteo-historical'].body) : null),
    aerosol: r['open-meteo-air'] ? normalizeAirQuality(r['open-meteo-air'].body) : [],
    observations: parseIemCsv(r.iem.body),
  };
}
const sampleAt = (city, day, hhmm) => fuse(seriesOf(city, day), Date.parse(`${day}T${hhmm}:00Z`), { groundM: ground(city), climatology: CLIM[city] });

describe('section 7.5: aerosols to extinction', () => {
  it('optical depth 0.05 over a 2.5 km layer: a visual range of 150 to 220 km (T5.4)', () => {
    for (const elevationM of [0, 620, 1300]) {
      const v = visibilityFromAerosol({ aod550: 0.05, layerHeightM: 2500, dustUgM3: 0 }, elevationM);
      expect(v).toBeGreaterThan(150000);
      expect(v).toBeLessThan(220000);
    }
  });
  it('the constants: Koschmieder 3.912, Rayleigh 1.16e-5 per metre at sea level', () => {
    expect(KOSCHMIEDER).toBe(3.912);
    expect(rayleighExtinction(0)).toBeCloseTo(1.16e-5, 12);
    expect(rayleighExtinction(8434)).toBeCloseTo(1.16e-5 / Math.E, 12);
  });
  it('the plan\'s live check: 0.06 over a 0.55 to 0.9 km layer gives 46 to 68 km (within 15 %)', () => {
    expect(visibilityFromAerosol({ aod550: 0.06, layerHeightM: 900 }, 620) / 1000).toBeCloseTo(68, -1);
    const v550 = visibilityFromAerosol({ aod550: 0.06, layerHeightM: 550 }, 620) / 1000;
    expect(v550).toBeGreaterThan(46 * 0.85);
    expect(v550).toBeLessThan(46 * 1.15);
  });
  it('property: more optical depth never raises visibility, at any layer height, dust and elevation', () => {
    for (let i = 0; i < 2000; i++) {
      const layerHeightM = 300 + rand(3, i, 0) * 4200, dustUgM3 = rand(3, i, 1) * 3000, elev = rand(3, i, 2) * 1500;
      const a = rand(3, i, 3) * 2, b = a + rand(3, i, 4) * 0.5;
      expect(visibilityFromAerosol({ aod550: b, layerHeightM, dustUgM3 }, elev)).toBeLessThanOrEqual(visibilityFromAerosol({ aod550: a, layerHeightM, dustUgM3 }, elev));
    }
  });
  it('property: through fusion too, more optical depth in the feed never raises the sample\'s visibility', () => {
    const base = seriesOf('lv', '2023-07-06');
    const noObs = { ...base, observations: [] };
    for (let i = 0; i < 40; i++) {
      const k = 1 + rand(5, i) * 3;
      const t = Date.UTC(2023, 6, 6, Math.floor(rand(6, i) * 23));
      const more = { ...noObs, aerosol: noObs.aerosol.map((h) => ({ ...h, aod550: h.aod550 * k })) };
      const ctx = { groundM: ground('lv') };
      expect(fuse(more, t, ctx).visibilityM).toBeLessThanOrEqual(fuse(noObs, t, ctx).visibilityM);
    }
  });
});

describe('the medium', () => {
  it('a METAR of HZ with 5 SM gives 8 km within 25 % (T5.4)', () => {
    // the smoke day of 8 September 2020, with its 12:56 report reduced to the haze alone (its own VCBLDU would make
    // the dust carry the visibility)
    const series = seriesOf('lv', '2020-09-08');
    const t = Date.parse('2020-09-08T12:56:00Z');
    series.observations = [{ ...parseMetar('KLAS 081256Z 01023G39KT 5SM HZ FEW250 31/01 A2962 RMK AO2'), t }];
    const s = fuse(series, t, { groundM: ground('lv'), climatology: CLIM.lv });
    expect(s.wxCodes).toEqual(['HZ']);
    const m = atmosphereMedium(s, { elevationM: ground('lv') });
    expect(m.visibilityM / 8000).toBeGreaterThan(0.75);
    expect(m.visibilityM / 8000).toBeLessThan(1.25);
    expect(m.visibilityM).toBeCloseTo(5 * MILE_M, 0);
    // the layer thinned so the optical depth is kept
    expect(m.aerosolExtinctionPerM * m.aerosolScaleHeightM).toBeCloseTo(s.aerosol.aod550 - 0.02, 6);
  });

  it('section 8.2: derived visibility against every report below 10 miles in the fixtures, within 25 %', () => {
    let n = 0;
    for (const city of ['lv', 'slc']) {
      for (const day of fixtureLabels(city).filter((l) => l !== 'live')) {
        const series = seriesOf(city, day);
        for (const o of series.observations.filter((x) => x.visibilityM !== null && x.visibilityM < 10 * MILE_M - 1)) {
          const s = fuse(series, o.t, { groundM: ground(city), climatology: CLIM[city] });
          const m = atmosphereMedium(s, { elevationM: ground(city) });
          expect(Math.abs(m.visibilityM / o.visibilityM - 1), `${city} ${new Date(o.t).toISOString()} ${o.raw}`).toBeLessThan(0.25);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it('humid air scatters more forward; dust is grey and absorbs blue', () => {
    const dry = presetSample('clear', 0, 620), humid = presetSample('rain', 0, 620), dusty = presetSample('haboob', 0, 620);
    const m = (s) => atmosphereMedium(s, { elevationM: 620 });
    expect(m(dry).asymmetryG).toBeCloseTo(0.76 - 0.06 * ((1.4 - 1.3) / 1.2), 6);
    expect(m(humid).asymmetryG).toBeCloseTo(0.82, 6);
    expect(m(dusty).asymmetryG).toBeLessThan(0.72);
    expect(m(dusty).singleScatteringAlbedo440).toBe(0.88);
    expect(m(dry).singleScatteringAlbedo440).toBe(0.93);
    for (const { id } of PRESETS) {
      const x = m(presetSample(id, 0, 620));
      expect(x.visibilityM, id).toBeCloseTo(presetSample(id, 0, 620).visibilityM, -1);
      expect(Object.values(x).every(Number.isFinite), id).toBe(true);
    }
  });

  it('the real 12:56 report, with VCBLDU: the dust it implies carries the 5 SM', () => {
    const s = sampleAt('lv', '2020-09-08', '13:00'); // KLAS 081256Z 01023G39KT 5SM HZ FU VCBLDU FEW250
    expect(s.wxCodes).toEqual(expect.arrayContaining(['HZ', 'FU', 'VCBLDU']));
    expect(atmosphereMedium(s, { elevationM: ground('lv') }).visibilityM).toBeCloseTo(5 * MILE_M, 0);
    expect(s.aerosol.dustUgM3).toBeGreaterThan(500);
  });

  it('setAtmosphereFromWeather: the function phase 3 calls writes each medium value into its uniform', () => {
    const s = sampleAt('lv', '2022-10-23', '04:56'); // BLDU 3 SM
    const medium = atmosphereMedium(s, { elevationM: ground('lv') });
    const uniforms = Object.fromEntries(Object.keys(ATMOSPHERE_UNIFORMS).map((k) => [k, { value: -1 }]));
    uniforms.unrelated = { value: 42 };
    const written = setAtmosphereFromWeather(uniforms, medium);
    expect(written.sort()).toEqual(Object.keys(ATMOSPHERE_UNIFORMS).sort());
    expect(uniforms.aerosolExtinction.value).toBeCloseTo(KOSCHMIEDER / s.visibilityM - rayleighExtinction(ground('lv')), 12);
    expect(uniforms.aerosolScaleHeight.value).toBe(medium.aerosolScaleHeightM);
    expect(uniforms.rayleighExtinction.value).toBeCloseTo(rayleighExtinction(ground('lv')), 15);
    expect(uniforms.aerosolAngstrom.value).toBeCloseTo(0.2, 6); // blowing dust: grey
    expect(uniforms.miePhaseG.value).toBeCloseTo(0.70, 2);
    expect(uniforms.aerosolAlbedo.value).toBe(0.93);
    expect(uniforms.aerosolAlbedo440.value).toBe(0.88);
    expect(uniforms.unrelated.value).toBe(42);
    expect(setAtmosphereFromWeather({ aerosolExtinction: { value: 0 } }, medium)).toEqual(['aerosolExtinction']);
    expect(setAtmosphereFromWeather(null, medium)).toEqual([]);
  });
});

describe('fusion: each recorded day against its reports (section 8.2)', () => {
  const lvG = ground('lv'), slcG = ground('slc');

  it('every hour of every recorded day is a valid sample', () => {
    for (const city of ['lv', 'slc']) {
      for (const day of fixtureLabels(city).filter((l) => l !== 'live')) {
        const series = seriesOf(city, day);
        for (let h = 0; h < 24; h++) {
          const s = fuse(series, Date.parse(`${day}T00:00:00Z`) + h * 3600000, { groundM: ground(city), climatology: CLIM[city] });
          expect(validateSample(s), `${city} ${day} ${h}h`).toEqual([]);
        }
      }
    }
  });

  it('clear, 6 July 2023 21:00: CLR 10SM, CAMS aerosols, visibility from them and at least 10 miles', () => {
    const s = sampleAt('lv', '2023-07-06', '21:00');
    expect(s.source).toEqual({ surface: 'metar', clouds: 'metar', aerosol: 'cams' });
    expect(s.clouds).toEqual([]);
    expect(s.visibilityCensored).toBe(true);
    expect(s.visibilityM).toBeGreaterThan(10 * MILE_M);
    expect(s.visibilityM).toBeCloseTo(Math.max(visibilityFromAerosol(s.aerosol, lvG), 10 * MILE_M), 0);
    expect(s.precip.kind).toBe('none');
    expect(s.storm.thunder).toBe(false);
  });

  it('blowing dust, 23 October 2022 04:56: 3 SM from the report, the dust it implies, grey, no wall without thunder', () => {
    const s = sampleAt('lv', '2022-10-23', '04:56'); // 21013G25KT 3SM BLDU FEW020 BKN130
    expect(s.visibilityM).toBeCloseTo(3 * MILE_M, 3);
    expect(s.wind.gustMs).toBeCloseTo(25 * 0.514444, 3);
    expect(s.aerosol.dustUgM3).toBeGreaterThan(500); // the feed has almost none: section 6.1, finding 3
    expect(s.aerosol.angstrom).toBeCloseTo(0.2, 6);
    expect(s.clouds.map((c) => c.genus)).toEqual(['cu', 'as']);
    expect(s.clouds[0].baseM).toBeCloseTo(lvG + 2000 * FT_M, 3);
    expect(s.clouds[1].cover).toBe(COVER.BKN);
    expect(s.dustWall).toBe(null);
  });

  it('-RA BR, 20 August 2023 16:00: rain and 5 SM from the report, the low layers at their reported bases', () => {
    const s = sampleAt('lv', '2023-08-20', '16:00'); // 1556Z 5SM -RA BR BKN012 BKN018 OVC110
    expect(s.precip).toMatchObject({ kind: 'rain', convective: false });
    expect(s.precip.rateMmH).toBeGreaterThan(0);
    expect(s.visibilityM).toBeCloseTo(5 * MILE_M, 3);
    expect(s.visibilityCensored).toBe(false);
    expect(s.clouds.slice(0, 3).map((c) => [c.genus, Math.round(c.baseM - lvG), c.cover])).toEqual([
      ['sc', Math.round(1200 * FT_M), 0.75], ['sc', Math.round(1800 * FT_M), 0.75], ['as', Math.round(11000 * FT_M), 1]]);
    expect(s.wxCodes).toEqual(['-RA', 'BR']);
    expect(s.aerosol.layerHeightM).toBeGreaterThanOrEqual(300);
  });

  it('+TSRA, 18 July 2022 21:56: twenty flashes a minute, a cumulonimbus at the reported base, convective rain', () => {
    const s = sampleAt('lv', '2022-07-18', '21:56'); // 01005KT 10SM +TSRA FEW120CB SCT200
    expect(s.storm).toMatchObject({ thunder: true, flashRatePerMin: 20, cells: 3 });
    expect(s.storm.capeJKg).toBeGreaterThan(800);
    expect(s.clouds[0]).toMatchObject({ genus: 'cb', cover: COVER.FEW });
    expect(s.clouds[0].baseM).toBeCloseTo(lvG + 12000 * FT_M, 3);
    expect(s.clouds[0].topM).toBeGreaterThanOrEqual(12000);
    expect(s.precip).toMatchObject({ kind: 'rain', convective: true, rateMmH: 10 });
  });

  it('VCTS with VIRGA, 31 July 2021 20:56: one flash a minute, virga from the cumulonimbus base; then -TSRA at 21:56', () => {
    const s = sampleAt('lv', '2021-07-31', '20:56'); // VCTS SCT100CB ... RMK LTG DSNT S ... VIRGA DSNT ALQDS
    expect(s.storm).toMatchObject({ thunder: true, flashRatePerMin: 1 });
    expect(s.precip.kind).toBe('virga');
    expect(s.precip.rateMmH).toBe(0);
    expect(s.precip.virgaBaseM).toBeCloseTo(lvG + 10000 * FT_M, 3);
    expect(s.clouds[0].genus).toBe('cb');
    expect(s.wxCodes).toEqual(expect.arrayContaining(['VCTS', 'VIRGA', 'LTG', 'CB']));
    const later = sampleAt('lv', '2021-07-31', '21:56'); // 20015G26KT 10SM -TSRA SCT100CB
    expect(later.storm.flashRatePerMin).toBe(6);
    expect(later.precip.kind).toBe('rain');
    expect(later.wind.gustMs).toBeCloseTo(26 * 0.514444, 3);
    expect(later.windAloft.map((w) => w.level)).toEqual([850, 700, 500, 300]); // the historical forecast's levels
  });

  it('overcast, 23 January 2024 10:18: OVC003 is stratus 91 m up; 15:56 -DZ BR 2 SM is drizzle', () => {
    const s = sampleAt('lv', '2024-01-23', '10:18');
    expect(s.clouds[0]).toMatchObject({ genus: 'st', cover: 1 });
    expect(s.clouds[0].baseM - lvG).toBeCloseTo(300 * FT_M, 3);
    expect(s.visibilityM).toBeCloseTo(8 * MILE_M, 3);
    const dz = sampleAt('lv', '2024-01-23', '15:56');
    expect(dz.precip.kind).toBe('drizzle');
    expect(dz.visibilityM).toBeCloseTo(2 * MILE_M, 3);
  });

  it('calm, 7 December 2019 11:56: no wind, and the direction kept from the last report that had one', () => {
    const series = seriesOf('lv', '2019-12-07');
    const t = Date.parse('2019-12-07T11:56:00Z');
    const s = fuse(series, t, { groundM: lvG, climatology: CLIM.lv });
    expect(s.wind.speedMs).toBe(0);
    const last = series.observations.filter((o) => o.t < t && o.windDirDeg !== null).pop();
    expect(s.wind.dirDeg).toBe(last.windDirDeg);
  });

  it('missing fields, 20 May 2024 01:56: no visibility or sky in the report, so both come from aerosols and the model', () => {
    const s = sampleAt('lv', '2024-05-20', '01:56'); // 22014G23KT 33/M03 A2972
    expect(s.source).toEqual({ surface: 'metar', clouds: 'model', aerosol: 'cams' });
    expect(s.visibilityM).toBeCloseTo(visibilityFromAerosol(s.aerosol, lvG), 0);
    expect(s.visibilityCensored).toBe(false);
    expect(s.tempC).toBeCloseTo(33.3, 6);
    expect(s.pressureHPa).toBeCloseTo(stationPressure(29.72 * 33.8639, lvG), 6);
  });

  it('CLR under high cloud, 30 September 2023 12:00: the automated station says CLR, the model has cirrostratus', () => {
    const s = sampleAt('lv', '2023-09-30', '12:00');
    const series = seriesOf('lv', '2023-09-30');
    const m = modelAt(series.model, Date.parse('2023-09-30T12:00:00Z'));
    expect(m.cloudHigh).toBeGreaterThan(0.75);
    expect(s.source.clouds).toBe('metar');
    expect(s.clouds).toEqual([expect.objectContaining({ genus: 'cs', cover: m.cloudHigh })]);
    expect(s.clouds[0].baseM).toBeGreaterThanOrEqual(10000);
  });

  it('1975: 35SM is uncensored and kept, TCU in the remarks makes it convective; there is no aerosol feed', () => {
    const s = sampleAt('lv', '1975-07-14', '00:00');
    expect(s.visibilityM).toBeCloseTo(35 * MILE_M, 3);
    expect(s.visibilityCensored).toBe(false);
    expect(s.source.aerosol).toBe('climatology');
    expect(s.aerosol.aod550).toBe(lvClimatology.months[6].aod550Median);
    expect(s.precip.convective).toBe(true);
    expect(s.wxCodes).toEqual(['TCU']);
    expect(atmosphereMedium(s, { elevationM: lvG }).visibilityM).toBeCloseTo(35 * MILE_M, 0);
  });

  it('1940 at Las Vegas: model only, every field labelled so', () => {
    const s = sampleAt('lv', '1940-01-15', '12:00');
    expect(s.source).toEqual({ surface: 'model', clouds: 'model', aerosol: 'climatology' });
    expect(s.wxCodes).toEqual([]);
    expect(s.windAloft.length).toBeGreaterThan(0); // extrapolated from the surface wind
    expect(s.windAloft.every((w) => w.dirDeg === (s.wind.dirDeg + 20) % 360)).toBe(true);
  });

  it('Salt Lake City: snow in freezing fog; a winter inversion\'s haze; 1975 virga; 1940 smoke in the GHCNh record', () => {
    const sn = sampleAt('slc', '2023-02-22', '12:00');
    expect(sn.precip.kind).toBe('snow');
    expect(sn.visibilityM).toBeLessThan(1000);
    expect(sn.clouds[0].genus).toBe('st');
    const hz = sampleAt('slc', '2023-02-04', '15:00');
    expect(hz.wxCodes).toContain('HZ');
    expect(hz.visibilityM).toBeCloseTo(2 * MILE_M, 3);
    const v75 = sampleAt('slc', '1975-07-14', '00:00');
    expect(v75.precip.kind).toBe('virga');
    expect(v75.visibilityM).toBeCloseTo(30 * MILE_M, 3);
    const fu = sampleAt('slc', '1940-01-15', '04:00');
    expect(fu.source.surface).toBe('metar');
    expect(fu.source.clouds).toBe('model'); // the rebuilt reports carry no sky
    expect(fu.visibilityM).toBeCloseTo(3 * MILE_M, 3);
    expect(fu.wxCodes).toEqual(['FU']);
    expect(slcG).toBeGreaterThan(1000);
  });

  it('no report within 40 minutes: the model; a thunderstorm with no reported base sits 2.6 km up', () => {
    const series = seriesOf('lv', '2021-07-31');
    const t = Date.parse('2021-07-31T21:56:00Z');
    const only = { ...series, observations: [{ ...parseMetar('KLAS 312156Z 20015G26KT 10SM -TSRA 29/18 A3003'), t }] };
    const s = fuse(only, t, { groundM: lvG, climatology: CLIM.lv });
    expect(s.clouds[0]).toMatchObject({ genus: 'cb' });
    expect(s.clouds[0].baseM).toBe(lvG + TS_BASE_AGL);
    const far = fuse(only, t + 45 * 60000, { groundM: lvG, climatology: CLIM.lv });
    expect(far.source.surface).toBe('model');
  });

  it('three-hourly years: a report up to 100 minutes away is used', () => {
    const series = seriesOf('lv', '1975-07-14');
    const sparse = { ...series, observations: series.observations.filter((o) => new Date(o.t).getUTCHours() % 3 === 0) };
    const t = Date.parse('1975-07-14T04:30:00Z');
    expect(fuse(sparse, t, { groundM: lvG }).source.surface).toBe('metar');
    expect(fuse({ ...series, observations: [series.observations[0]] }, Date.parse('1975-07-14T01:30:00Z'), { groundM: lvG }).source.surface).toBe('model');
  });

  it('aerosol extinction from column or surface dust, whichever is larger', () => {
    expect(aerosolExtinction({ aod550: 0.12, layerHeightM: 1000, dustUgM3: 0 })).toBeCloseTo(1e-4, 12);
    expect(aerosolExtinction({ aod550: 0.12, layerHeightM: 1000, dustUgM3: 1000 })).toBeCloseTo(6e-4, 12);
  });
});
