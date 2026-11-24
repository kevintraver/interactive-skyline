// T5.2: the normalizers (plan 01, sections 6.1 and 8.2) on hand-checked reports and on the recorded days. The raw
// reports quoted here are copied from the fixtures; the expected values were read off them by hand.
import { describe, it, expect } from 'vitest';
import { parseMetar, parseIemCsv, parseAviationWeather, parseNws, normalizeOpenMeteo, normalizeAirQuality, mergeModel,
  KT_MS, MILE_M, FT_M, INHG_HPA } from '../../../src/weather/normalize.js';
import { loadFixture, fixtureLabels } from '../../helpers/weatherFixtures.js';

const iemOf = (city, day) => parseIemCsv(loadFixture(city, day).responses.iem.body);
const at = (obs, hhmm) => obs.find((o) => new Date(o.t).toISOString().slice(11, 16) === hhmm);

describe('parseMetar', () => {
  it('1975, uncensored: 35SM CLR with TCU in the remarks', () => {
    const o = parseMetar('KLAS 140000Z 22008KT 35SM CLR 38/08 A2971 RMK TCU DSNT NE-SE SLP029 8/201 T03830083 51025');
    expect(o.station).toBe('KLAS');
    expect(o.windDirDeg).toBe(220);
    expect(o.windSpeedMs).toBeCloseTo(8 * KT_MS, 9);
    expect(o.visibilityM).toBeCloseTo(35 * MILE_M, 6);
    expect(o.visibilityCensored).toBe(false);
    expect(o.skyClear).toBe(true);
    expect(o.clouds).toEqual([]);
    expect(o.tempC).toBeCloseTo(38.3, 9); // the T group is more precise than 38/08
    expect(o.dewPointC).toBeCloseTo(8.3, 9);
    expect(o.altimeterHPa).toBeCloseTo(29.71 * INHG_HPA, 6);
    expect(o.remarks.tcu).toBe(true);
  });

  it('10SM is censored; CB on a layer and VIRGA, LTG, TSB in the remarks', () => {
    const o = parseMetar('KLAS 312056Z 15007KT 10SM VCTS SCT100CB SCT150 BKN250 35/14 A3003 RMK AO2 LTG DSNT S TSE54 SLP137 TSB53 VIRGA DSNT ALQDS T03500139 56019');
    expect(o.visibilityCensored).toBe(true);
    expect(o.wx).toEqual(['VCTS']);
    expect(o.clouds).toEqual([
      { cover: 'SCT', baseAglM: 10000 * FT_M, type: 'CB' },
      { cover: 'SCT', baseAglM: 15000 * FT_M, type: null },
      { cover: 'BKN', baseAglM: 25000 * FT_M, type: null },
    ]);
    expect(o.remarks).toMatchObject({ virga: true, cb: true, ltg: true, tsBegin: true });
    expect(o.tempC).toBeCloseTo(35, 9);
    expect(o.dewPointC).toBeCloseTo(13.9, 9);
  });

  it('+TSRA, gusts and the hourly precipitation group', () => {
    const o = parseMetar('KLAS 182256Z VRB05KT 10SM TS SCT120CB BKN200 37/17 A2990 RMK AO2 RAE23 SLP092 OCNL LTGICCCCG OHD-ALQDS TS OHD-ALQDS MOV N CB DSNT NE-SE P0017 T03720172');
    expect(o.windVariable).toBe(true);
    expect(o.windDirDeg).toBe(null);
    expect(o.wx).toEqual(['TS']);
    expect(o.precipMm).toBeCloseTo(0.17 * 25.4, 9);
    expect(o.remarks).toMatchObject({ ltg: true, ts: true, rainEnd: true });
    const p = parseMetar('KLAS 182156Z 01005KT 10SM +TSRA FEW120CB SCT200 32/19 A2993 RMK AO2 PK WND 19032/2153');
    expect(p.wx).toEqual(['+TSRA']);
    const g = parseMetar('KLAS 230056Z 21017G44KT 4SM BLDU FEW020 SCT130 BKN220 24/03 A2939 RMK AO2');
    expect(g.gustMs).toBeCloseTo(44 * KT_MS, 9);
    expect(g.wx).toEqual(['BLDU']);
    expect(g.visibilityM).toBeCloseTo(4 * MILE_M, 6);
    expect(g.visibilityCensored).toBe(false);
  });

  it('-RA BR, rain begin and end remarks, fractions of a mile, vertical visibility', () => {
    const o = parseMetar('KLAS 201556Z 04003KT 5SM -RA BR BKN012 BKN018 OVC110 21/19 A2994 RMK AO2 RAB1457 SLP122 P0001 T02060194');
    expect(o.wx).toEqual(['-RA', 'BR']);
    expect(o.remarks.rainBegin).toBe(true);
    expect(parseMetar('KXXX 010000Z 00000KT 1 1/2SM BR OVC003 05/05 A3000').visibilityM).toBeCloseTo(1.5 * MILE_M, 6);
    expect(parseMetar('KXXX 010000Z 00000KT M1/4SM FG VV002 05/05 A3000').clouds).toEqual([{ cover: 'VV', baseAglM: 200 * FT_M, type: null }]);
    expect(parseMetar('KXXX 010000Z 00000KT P6SM SKC 05/M05 A3000').visibilityCensored).toBe(true);
  });

  it('calm: no direction', () => {
    const o = parseMetar('KLAS 071156Z 00000KT 10SM CLR 03/M06 A3025 RMK AO2');
    expect(o.windSpeedMs).toBe(0);
    expect(o.windDirDeg).toBe(null);
    expect(o.tempC).toBe(3);
    expect(o.dewPointC).toBe(-6);
  });

  it('missing fields stay missing, and a report without a sky group says nothing about the sky', () => {
    const o = parseMetar('KLAS 200156Z 22014G23KT 33/M03 A2972 RMK AO2 SLP038 T03331028 $');
    expect(o.visibilityM).toBe(null);
    expect(o.skyReported).toBe(false);
    expect(o.skyClear).toBe(false);
    expect(o.gustMs).toBeCloseTo(23 * KT_MS, 9);
  });

  it('the METAR prefix of aviationweather.gov, and the archive\'s reports rebuilt from GHCNh', () => {
    expect(parseMetar('METAR KLAS 221456Z 20003KT 10SM BKN150 BKN200 07/M02 A3009 RMK AO2').station).toBe('KLAS');
    const g = parseMetar('METAR KSLC 150000Z AUTO 20304KT M01/M07 A3036 RMK AO2 SLP308 T10061072 IEM_GHCNH');
    expect(g.synthetic).toBe(true);
    expect(g.skyReported).toBe(false);
    expect(g.tempC).toBeCloseTo(-0.6, 9);
  });

  it('nonsense does not throw', () => {
    for (const s of ['', null, undefined, 'RMK', 'KLAS', '%%% ### $$$', 'KLAS 999999Z 99999G999KT 9999SM']) expect(() => parseMetar(s)).not.toThrow();
  });
});

describe('the recorded days (section 8.2)', () => {
  it('fixtures exist for every day of section 8.2, and for both cities', () => {
    expect(fixtureLabels('lv')).toEqual(['1940-01-15', '1975-07-14', '2019-12-07', '2020-09-08', '2021-07-31', '2022-07-18', '2022-10-23',
      '2023-07-06', '2023-08-20', '2023-09-30', '2024-01-23', '2024-05-20', 'live']);
    expect(fixtureLabels('slc')).toEqual(['1940-01-15', '1975-07-14', '2023-02-04', '2023-02-22', 'live']);
  });

  it('IEM: times are UTC, every report of the day, oldest first', () => {
    const obs = iemOf('lv', '2023-08-20');
    expect(obs.length).toBeGreaterThan(30);
    expect(new Date(obs[0].t).toISOString()).toBe('2023-08-20T00:56:00.000Z');
    for (let i = 1; i < obs.length; i++) expect(obs[i].t).toBeGreaterThan(obs[i - 1].t);
    expect(at(obs, '15:56').wx).toEqual(['-RA', 'BR']);
    expect(at(obs, '15:56').visibilityM).toBeCloseTo(5 * MILE_M, 6);
  });

  it('IEM: HZ (2020-09-08), BLDU (2022-10-23), OVC003 (2024-01-23), calm (2019-12-07)', () => {
    expect(iemOf('lv', '2020-09-08').some((o) => o.wx.includes('HZ') && o.visibilityM < 7 * MILE_M)).toBe(true);
    expect(at(iemOf('lv', '2022-10-23'), '04:56')).toMatchObject({ wx: ['BLDU'] });
    expect(at(iemOf('lv', '2024-01-23'), '10:18').clouds).toEqual([{ cover: 'OVC', baseAglM: 300 * FT_M, type: null }]);
    expect(iemOf('lv', '2019-12-07').filter((o) => o.windSpeedMs === 0).length).toBeGreaterThan(8);
  });

  it('IEM: 1975 uncensored visibility; no reports in January 1940 at Las Vegas; GHCNh-rebuilt reports at Salt Lake City', () => {
    const lv75 = iemOf('lv', '1975-07-14');
    expect(lv75[0].visibilityM).toBeCloseTo(35 * MILE_M, 6);
    expect(lv75[0].visibilityCensored).toBe(false);
    expect(iemOf('lv', '1940-01-15')).toEqual([]);
    const slc40 = iemOf('slc', '1940-01-15');
    expect(slc40.length).toBeGreaterThan(10);
    // rebuilt from NOAA's GHCNh: temperature, wind, pressure; no sky; visibility and smoke (FU) only now and then
    expect(slc40.every((o) => o.synthetic && !o.skyReported)).toBe(true);
    expect(at(slc40, '04:00')).toMatchObject({ wx: ['FU'], visibilityM: 3 * MILE_M });
    expect(at(slc40, '00:00').visibilityM).toBe(null);
  });

  it('aviationweather.gov and the NWS API (the live window)', () => {
    const live = loadFixture('lv', 'live').responses;
    const av = parseAviationWeather(live.aviationweather.body);
    expect(av.length).toBeGreaterThan(15);
    for (const o of av) {
      expect(o.station).toBe('KLAS');
      expect(Number.isFinite(o.t)).toBe(true);
      expect(o.tempC).not.toBe(null);
    }
    const nws = parseNws(live.nws.body);
    expect(nws.length).toBeGreaterThan(10);
    expect(nws.every((o) => Number.isFinite(o.t) && o.tempC !== null)).toBe(true);
  });

  it('Open-Meteo archive: 24 hours, fractions, metres per second; the archive has no visibility or CAPE', () => {
    const f = loadFixture('lv', '2023-08-20').responses;
    const hours = normalizeOpenMeteo(f['open-meteo'].body);
    expect(hours).toHaveLength(24);
    expect(hours[0].t).toBe(Date.UTC(2023, 7, 20));
    expect(hours[0].cloud).toBeGreaterThanOrEqual(0);
    expect(hours[0].cloud).toBeLessThanOrEqual(1);
    expect(hours[0].visibilityM).toBe(null);
    expect(hours[0].capeJKg).toBe(null);
    expect(hours[0].aloft).toEqual([]);
    // the historical forecast fills what the archive lacks (values read from the fixture itself, not hard-coded: they
    // come from whichever model Open-Meteo's best match uses, which changes when HRRR and NAM retire; decision 11)
    const hf = f['open-meteo-historical'].body.hourly;
    const merged = mergeModel(hours, normalizeOpenMeteo(f['open-meteo-historical'].body));
    expect(merged[0].visibilityM).toBe(hf.visibility[0] ?? null);
    expect(merged[0].capeJKg).toBe(hf.cape[0] ?? null);
    expect(merged[0].aloft.map((w) => w.level)).toEqual([850, 700, 500, 300].filter((l) => hf[`wind_speed_${l}hPa`][0] !== null));
    expect(merged[0].tempC).toBe(hours[0].tempC);
  });

  it('Open-Meteo air quality: optical depth and dust; nothing before August 2022', () => {
    const air = normalizeAirQuality(loadFixture('lv', '2023-08-20').responses['open-meteo-air'].body);
    expect(air).toHaveLength(24);
    expect(air[0]).toEqual({ t: Date.UTC(2023, 7, 20), aod550: 0.15, dustUgM3: 9, pm10UgM3: 14.5, pm25UgM3: 8.2 });
    expect(loadFixture('lv', '2020-09-08').responses['open-meteo-air']).toBeUndefined();
  });

  it('every recorded day normalizes without a gap in time', () => {
    for (const city of ['lv', 'slc']) {
      for (const label of fixtureLabels(city)) {
        const hours = normalizeOpenMeteo(loadFixture(city, label).responses['open-meteo'].body);
        expect(hours.length, `${city} ${label}`).toBeGreaterThanOrEqual(24);
        for (let i = 1; i < hours.length; i++) expect(hours[i].t - hours[i - 1].t).toBe(3600000);
        expect(hours.every((h) => h.tempC !== null && h.windSpeedMs !== null), `${city} ${label}`).toBe(true);
      }
    }
  });

  it('malformed input gives empty lists, not exceptions', () => {
    for (const bad of [null, undefined, '', 42, {}, { hourly: {} }, { hourly: { time: 'x' } }]) {
      expect(normalizeOpenMeteo(bad)).toEqual([]);
      expect(normalizeAirQuality(bad)).toEqual([]);
      expect(parseNws(bad)).toEqual([]);
      expect(parseAviationWeather(bad)).toEqual([]);
      expect(parseIemCsv(bad)).toEqual([]);
    }
    expect(parseIemCsv('station,valid\n')).toEqual([]);
  });
});
