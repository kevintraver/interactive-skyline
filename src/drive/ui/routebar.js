// The route bar in #dock: play or pause, the playback rate, the city's local time (which opens the
// time-of-day popover), the speed, the track with the thumb that moves the car, the next exit ahead,
// and the hold-position lock. It keeps the id the first transport pill had (#drivebar).

import { createTrack } from './slider.js';
import { aheadText } from './track.js';
import { formatClock, formatRate, formatSpeed, RATES } from './format.js';

const icon = (id) => `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#${id}" /></svg>`;

/**
 * @param {{ dock: HTMLElement, tz: string, units: () => 'ft'|'m', onToggle: () => void, onRate: (dir: 1|-1) => void,
 *           onLock: () => void, onSeek: (s: number, done: boolean) => void }} opts
 *   units is read on every update, so a change in the options shows at once (feet go with mph, metres with km/h)
 */
export function createRouteBar({ dock, tz, units, onToggle, onRate, onLock, onSeek }) {
  const el = document.createElement('div');
  el.id = 'drivebar';
  el.hidden = true;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Drive controls');
  el.innerHTML = `<div class="ctl">
      <button class="play" type="button">${icon('i-play')}</button>
      <div class="rate" role="group" aria-label="Playback rate">
        <button type="button" class="slower" aria-label="Slower" title="Slower (,)">${icon('i-slower')}</button>
        <output aria-live="off"></output>
        <button type="button" class="faster" aria-label="Faster" title="Faster (.)">${icon('i-faster')}</button>
      </div>
      <button class="time" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="drive-time" title="Time of day"></button>
      <span class="speed"></span>
    </div>
    <div class="route">
      <p class="ahead"><span class="name"></span><span class="dist"></span></p>
    </div>
    <button class="lock" type="button" aria-pressed="false">${icon('i-unlock')}</button>
    <span class="status"></span>`;
  dock.append(el);
  const $ = (sel) => el.querySelector(sel);
  const play = $('.play'), playUse = play.querySelector('use');
  const rateOut = $('.rate output'), slower = $('.slower'), faster = $('.faster');
  const time = $('.time'), speed = $('.speed'), status = $('.status');
  const ahead = $('.ahead'), aheadName = $('.ahead .name'), aheadDist = $('.ahead .dist');
  const lock = $('.lock'), lockUse = lock.querySelector('use');
  const track = createTrack({ units, onSeek });
  $('.route').prepend(track.el);

  play.addEventListener('click', onToggle);
  slower.addEventListener('click', () => onRate(-1));
  faster.addEventListener('click', () => onRate(1));
  lock.addEventListener('click', onLock);

  let route = null;
  const shown = { play: null, minute: null, speed: null, status: null, rate: null, lock: null, ahead: null, units: null };

  return {
    el,
    time,
    track,
    show(on) { el.hidden = !on; },
    /** Loading text in place of the readings, or null for the readings. */
    setStatus(text) {
      if (shown.status === text) return;
      shown.status = text;
      status.textContent = text || '';
      el.classList.toggle('busy', !!text);
    },
    /** @param {{ s0: number, s1: number, markers: object[], reveal?: object, to?: string }} r */
    setRoute(r) {
      route = r;
      track.setRoute(r);
      shown.ahead = null;
    },
    /** Write only what changed, so a frame costs no layout when nothing did. */
    update({ playing, simMs, speed: v, s, rate, locked, arrived }) {
      const u = units();
      if (u !== shown.units) { shown.units = u; track.refresh(); }
      const mode = arrived ? 'again' : playing ? 'pause' : 'play';
      if (mode !== shown.play) {
        shown.play = mode;
        playUse.setAttribute('href', { again: '#i-replay', pause: '#i-pause', play: '#i-play' }[mode]);
        const name = { again: 'Drive again', pause: 'Pause', play: 'Play' }[mode];
        play.title = `${name} (Space)`;
        play.setAttribute('aria-label', name);
        el.classList.toggle('arrived', arrived);
      }
      if (rate !== shown.rate) {
        shown.rate = rate;
        rateOut.textContent = formatRate(rate);
        rateOut.setAttribute('aria-label', `${formatRate(rate)} speed`);
        slower.disabled = rate <= RATES[0];
        faster.disabled = rate >= RATES[RATES.length - 1];
      }
      const minute = Math.floor(simMs / 60000);
      if (minute !== shown.minute) {
        shown.minute = minute;
        const text = formatClock(simMs, tz);
        time.textContent = text;
        time.setAttribute('aria-label', `Time of day, ${text}`);
      }
      // held in place, the car is not moving whatever the journey's speed there is
      const sp = formatSpeed(locked || arrived ? 0 : v, u);
      if (sp !== shown.speed) { shown.speed = sp; speed.textContent = sp; }
      if (locked !== shown.lock) {
        shown.lock = locked;
        lock.setAttribute('aria-pressed', String(locked));
        lockUse.setAttribute('href', locked ? '#i-lock' : '#i-unlock');
        lock.title = locked ? 'Holding position: changing the time keeps the car here' : 'Hold position: change the time without moving the car';
        lock.setAttribute('aria-label', 'Hold position');
      }
      if (route && Number.isFinite(s)) {
        track.update(s);
        const a = aheadText({ s, s1: route.s1, markers: route.markers, to: route.to, units: u });
        const key = `${a.text}|${a.dist || ''}`;
        if (key !== shown.ahead) {
          shown.ahead = key;
          aheadName.textContent = a.text;
          aheadDist.textContent = a.dist || '';
          ahead.title = a.dist ? `${a.text}, ${a.dist}` : a.text;
          ahead.classList.toggle('done', a.arrived);
        }
      }
    },
  };
}
