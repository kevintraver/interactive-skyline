// Plan 03, section 4.10: the flight's state in the address bar.
// ?city=lv&mode=flight&flight=lv-19-dusk&at=1240&seat=22F&yaw=-10&pitch=-8&lens=26
import { describe, it, expect } from 'vitest';
import { decodeFlightState, encodeFlightState, clearFlightState, FLIGHT_KEYS } from '../../../src/flight/url.js';

describe('decodeFlightState', () => {
  it('reads the example link of section 4.10', () => {
    const s = decodeFlightState('?city=lv&mode=flight&flight=lv-19-dusk&at=1240&seat=22F&yaw=-10&pitch=-8&lens=26');
    expect(s).toEqual({ flight: true, id: 'lv-19-dusk', at: 1240, seat: '22F', yaw: -10, pitch: -8, lens: 26, frame: undefined, t: undefined });
  });

  it('says flight: false for any other mode, and leaves missing values undefined', () => {
    expect(decodeFlightState('?city=lv&mode=drive&route=i15n').flight).toBe(false);
    const s = decodeFlightState('?mode=flight');
    expect(s.flight).toBe(true);
    for (const k of ['id', 'at', 'seat', 'yaw', 'pitch', 'lens', 'frame', 't']) expect(s[k]).toBeUndefined();
  });

  it('drops malformed values instead of guessing', () => {
    const s = decodeFlightState('?mode=flight&flight=../../etc&at=-5&seat=99Z&yaw=abc&pitch=&lens=0&frame=maybe&t=yesterday');
    for (const k of ['id', 'at', 'seat', 'yaw', 'pitch', 'lens', 'frame', 't']) expect(s[k]).toBeUndefined();
  });

  it('normalises the seat and reads the cabin frame and a retimed instant', () => {
    const s = decodeFlightState('?mode=flight&seat=7a&frame=0&t=2026-11-14T01:07:30Z');
    expect(s.seat).toBe('7A');
    expect(s.frame).toBe(false);
    expect(s.t).toBe(Date.parse('2026-11-14T01:07:30Z'));
    expect(decodeFlightState('?mode=flight&frame=1').frame).toBe(true);
    // plan 01's own zoned form of t (formatTimeParam), with an offset
    expect(decodeFlightState('?mode=flight&t=2026-11-13T17:07:30-08:00').t).toBe(Date.parse('2026-11-14T01:07:30Z'));
  });
});

describe('encodeFlightState', () => {
  it('writes mode=flight and the flight keys, keeping everything else', () => {
    const p = encodeFlightState({ id: 'lv-19-dusk', at: 1240, seat: '22F', yaw: -10, pitch: -8, lens: 26 }, '?city=lv&renderer=webgpu&backend=webgl2');
    expect(p.get('city')).toBe('lv');
    expect(p.get('renderer')).toBe('webgpu');
    expect(p.get('backend')).toBe('webgl2');
    expect(p.get('mode')).toBe('flight');
    expect(p.get('flight')).toBe('lv-19-dusk');
    expect(p.get('at')).toBe('1240');
    expect(p.get('seat')).toBe('22F');
    expect(p.get('yaw')).toBe('-10');
    expect(p.get('pitch')).toBe('-8');
    expect(p.get('lens')).toBe('26');
    expect(p.has('frame')).toBe(false);
    expect(p.has('t')).toBe(false);
  });

  it('rounds to a tenth, and writes frame=0 and t only when they differ from the defaults', () => {
    const p = encodeFlightState({ id: 'x', at: 12.345, yaw: 1.26, pitch: -7.94, lens: 26.04, frame: false, t: Date.parse('2026-11-14T01:07:30.4Z') });
    expect(p.get('at')).toBe('12.3');
    expect(p.get('yaw')).toBe('1.3');
    expect(p.get('pitch')).toBe('-7.9');
    expect(p.get('lens')).toBe('26');
    expect(p.get('frame')).toBe('0');
    expect(p.get('t')).toBe('2026-11-14T01:07:30Z');
  });

  it('replaces another mode\'s keys of the same name and drops the drive\'s own', () => {
    const p = encodeFlightState({ id: 'a', at: 1 }, '?city=lv&mode=drive&route=i15n&s=500&view=clean&yaw=40&t=2026-01-01T00:00:00Z');
    expect(p.get('mode')).toBe('flight');
    for (const k of ['route', 's', 'view', 'yaw', 't']) expect(p.has(k)).toBe(false);
  });

  it('round-trips through decode', () => {
    const state = { id: 'lv-19-day', at: 300.5, seat: '22F', yaw: 12.5, pitch: -3, lens: 50, frame: false, t: Date.parse('2026-11-14T01:07:30Z') };
    const back = decodeFlightState(encodeFlightState(state, '?city=lv'));
    expect(back).toEqual({ flight: true, ...state });
  });
});

describe('clearFlightState', () => {
  it('removes every flight key and nothing else', () => {
    const p = clearFlightState('?city=lv&mode=flight&flight=a&at=3&seat=22F&yaw=1&pitch=2&lens=3&frame=0&t=2026-01-01T00:00:00Z&backend=webgl2');
    expect(p.toString()).toBe('city=lv&backend=webgl2');
    expect(FLIGHT_KEYS).toEqual(expect.arrayContaining(['mode', 'flight', 'at', 'seat', 'yaw', 'pitch', 'lens', 'frame', 't']));
  });

  it('leaves another mode\'s address alone', () => {
    expect(clearFlightState('?city=lv&mode=drive&route=i15n').toString()).toBe('city=lv&mode=drive&route=i15n');
  });
});

describe('moving between an orbit and a recorded flight (F7.2)', () => {
  const orbitLink = '?city=lv&mode=flight&orbit=1&alt=12000&r=9&phase=140&c=-3000,2500&on=bellagio&out=1&ias=250&seat=22F&backend=webgl';
  it('a recorded flight written over an orbit drops every orbit key', () => {
    const p = encodeFlightState({ id: 'lv-19-day', at: 12, seat: '22F' }, orbitLink);
    for (const k of ['orbit', 'alt', 'r', 'phase', 'c', 'on', 'out', 'ias']) expect(p.has(k), k).toBe(false);
    expect(p.toString()).toBe('city=lv&backend=webgl&mode=flight&flight=lv-19-day&at=12&seat=22F');
  });

  it('leaving Fly from an orbit drops every orbit key', () => {
    expect(clearFlightState(orbitLink).toString()).toBe('city=lv&backend=webgl');
  });
});

describe('the orbit keys listed in url.js', () => {
  it('are orbitUrl.js ORBIT_KEYS', async () => {
    const { ORBIT_KEYS } = await import('../../../src/flight/orbitUrl.js');
    const p = clearFlightState(`?mode=flight&${ORBIT_KEYS.map((k) => `${k}=1`).join('&')}`);
    expect(p.toString()).toBe('');
  });
});
