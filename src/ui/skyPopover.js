// The time of day: #sky-toggle under #night opens #sky, a popover placed like #settings (plan 01, section 4.2;
// task T1.5). Phase 1 rows: play/pause, the city's local time and zone, Now; a 24-hour scrubber whose track is
// shaded by twilight phase, with sunrise and sunset ticks; quick jumps; the date and the speed. Any time control
// enters the clock state. Keys (section 4.5): Space, , and . (Shift: an hour, Alt: a day), [ and ], N, and T to
// open or close #sky; none of them while typing in a field.
import { zonedToUtc } from '../core/time.js';
import { phaseOf } from '../sky/ephemeris.js';

const SPEEDS = [0, 1, 60, 600, 3600];
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
// the scrubber's track, by twilight phase (sky colours, the same in both themes)
const PHASE_COLOR = { day: '#8cc0ec', civil: '#e0a77f', nautical: '#55618f', astronomical: '#2d3559', night: '#161b30' };
const PHASE_LABEL = { day: 'Day', civil: 'Civil twilight', nautical: 'Nautical twilight', astronomical: 'Astronomical twilight', night: 'Night' };
// which phase begins at each event
const AFTER = { astronomicalDawn: 'astronomical', nauticalDawn: 'nautical', civilDawn: 'civil', sunrise: 'day',
  sunset: 'civil', civilDusk: 'nautical', nauticalDusk: 'astronomical', astronomicalDusk: 'night' };
/** While dragging, the scrubber snaps to sunrise or sunset within this many minutes (about two pixels). */
const SNAP_MIN = 12;

/** Is the key event meant for a field (search, date, a select) rather than for the app? */
export function typingIn(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['range', 'radio', 'checkbox', 'button', 'submit', 'reset'].includes(target.type);
}

export function initSkyPopover(app) {
  const { clock, env, loop } = app;
  const $ = (id) => document.getElementById(id);
  const form = $('sky'), toggle = $('sky-toggle'), playBtn = $('sky-play'), timeOut = $('sky-time'), liveBtn = $('sky-live');
  const scrub = $('sky-scrub'), phaseOut = $('sky-phase'), track = form.querySelector('.sky-track');
  const riseOut = $('sky-sunrise'), setOut = $('sky-sunset'), dateIn = $('sky-date'), speedSel = $('sky-speed');
  const jumps = [...form.querySelectorAll('input[name="sky-jump"]')];

  let dayKey = '', dayStart = 0, events = {}, scrubbing = false, jumping = false;
  loop.add({ demand: () => (scrubbing ? 'continuous' : 'idle') }, 15);

  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;

  /** The local day the clock is in: its start, its events and the scrubber's track. */
  function refreshDay() {
    const p = clock.local();
    const key = isoDate(p);
    if (key === dayKey) return;
    dayKey = key;
    dayStart = zonedToUtc({ year: p.year, month: p.month, day: p.day }, clock.zone);
    const next = clock.local(dayStart + 26 * HOUR);
    const length = zonedToUtc({ year: next.year, month: next.month, day: next.day }, clock.zone) - dayStart; // 23 to 25 h
    events = env.ephemeris.events(dayStart);
    scrub.max = String(Math.round(length / MIN) - 1);
    // the track: one colour per twilight phase, hard edges at the events
    const pct = (t) => `${(((t - dayStart) / length) * 100).toFixed(2)}%`;
    let phase = phaseOf(env.ephemeris.at(dayStart).sun.trueAltDeg);
    const stops = [`${PHASE_COLOR[phase]} 0%`];
    for (const [name, t] of Object.entries(events).filter(([k, t]) => AFTER[k] && t !== null).sort((a, b) => a[1] - b[1])) {
      stops.push(`${PHASE_COLOR[phase]} ${pct(t)}`);
      phase = AFTER[name];
      stops.push(`${PHASE_COLOR[phase]} ${pct(t)}`);
    }
    stops.push(`${PHASE_COLOR[phase]} 100%`);
    track.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    for (const tick of track.querySelectorAll('.tick')) {
      const t = events[tick.dataset.event];
      tick.hidden = t === null;
      if (t !== null) tick.style.left = pct(t);
      tick.title = t === null ? '' : `${tick.dataset.event === 'sunrise' ? 'Sunrise' : 'Sunset'} ${clock.format(t, 'time')}`;
    }
    riseOut.textContent = events.sunrise === null ? '' : `Sunrise ${clock.format(events.sunrise, 'time')}`;
    setOut.textContent = events.sunset === null ? '' : `Sunset ${clock.format(events.sunset, 'time')}`;
    dateIn.value = key;
    const week = clock.local(Date.now() + 7 * DAY);
    dateIn.max = isoDate(week);
  }

  /** Bring every control up to date with the clock and the state. */
  function render() {
    if (form.hidden) return;
    refreshDay();
    timeOut.value = clock.format(clock.timeMs, 'full');
    if (!scrubbing) scrub.value = String(Math.round((clock.timeMs - dayStart) / MIN));
    const clockState = env.mode === 'clock';
    phaseOut.value = clockState ? PHASE_LABEL[env.state.sky.phase] : `Pinned ${env.night ? 'night' : 'day'}`;
    const playing = clockState && clock.playing;
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.title = `${playing ? 'Pause' : 'Play'} (Space)`;
    playBtn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    liveBtn.setAttribute('aria-pressed', String(clockState && clock.live));
    speedSel.value = String(playing ? nearestSpeed(clock.rate) : 0);
  }
  const nearestSpeed = (rate) => SPEEDS.reduce((best, s) => (Math.abs(s - rate) < Math.abs(best - rate) ? s : best), 1);

  /** Any time control: enter the clock state first. */
  const control = (fn) => (...args) => { env.enterClock(); fn(...args); render(); };

  const clearJumps = () => { if (!jumping) for (const r of jumps) r.checked = false; };
  for (const type of ['tick', 'seek', 'state', 'rate']) clock.on(type, (e) => { if (type === 'seek') clearJumps(); render(); });
  env.on('mode', render);

  const togglePlay = control(() => {
    if (clock.playing) { clock.pause(); return; }
    if (!clock.rate) clock.setRate(1); // keep the speed in force: a journey's transport bar has speeds this popover does not list
    clock.play();
  });
  const goLive = control(() => clock.goLive());
  const stepBy = control((ms) => clock.set(clock.timeMs + ms));
  const setSpeed = control((rate) => {
    if (!rate) clock.pause();
    else { clock.setRate(rate); clock.play(); }
  });
  const jumpTo = control((which) => {
    refreshDay();
    let t = events[which];
    if (which === 'night') t = events.astronomicalDusk !== null ? events.astronomicalDusk + HOUR : events.sunset !== null ? events.sunset + 2 * HOUR : dayStart + 23 * HOUR;
    if (t === null || t === undefined) return;
    jumping = true;
    clock.set(Math.min(t, dayStart + DAY - MIN));
    jumping = false;
  });

  playBtn.addEventListener('click', togglePlay);
  liveBtn.addEventListener('click', goLive);
  speedSel.addEventListener('change', () => setSpeed(Number(speedSel.value)));
  for (const r of jumps) r.addEventListener('change', () => { if (r.checked) jumpTo(r.value); });
  const setDate = control((value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return;
    const p = clock.local();
    clock.setLocal({ year: +m[1], month: +m[2], day: +m[3], hour: p.hour, minute: p.minute, second: p.second });
  });
  dateIn.addEventListener('change', () => setDate(dateIn.value));

  // the scrubber: every input moves the clock; a drag snaps to sunrise and sunset
  let pointer = false;
  scrub.addEventListener('pointerdown', () => { pointer = true; scrubbing = true; loop.invalidate(); });
  const release = () => { if (pointer) { pointer = false; scrubbing = false; render(); } };
  scrub.addEventListener('pointerup', release);
  scrub.addEventListener('pointercancel', release);
  scrub.addEventListener('lostpointercapture', release);
  // (read the control before entering the clock state: entering it re-renders the popover from the clock)
  const scrubTo = control((value) => {
    let t = dayStart + value * MIN;
    if (pointer) {
      for (const k of ['sunrise', 'sunset']) if (events[k] !== null && Math.abs(t - events[k]) <= SNAP_MIN * MIN) t = events[k];
    }
    clock.set(t);
  });
  scrub.addEventListener('input', () => scrubTo(Number(scrub.value)));

  function openSky(open) {
    if (open) app.closePopovers('sky');
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) render();
    app.events.emit('sky:open', open); // the weather rows (src/weather/index.js) load and render on this
  }
  toggle.addEventListener('click', () => openSky(form.hidden));

  addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || typingIn(ev.target)) return;
    if (app.drive && app.drive.active) return; // drive seam: while driving, the drive's own keys (src/drive/input.js)
    const onControl = ev.target instanceof HTMLButtonElement || (ev.target instanceof HTMLInputElement && ['radio', 'checkbox', 'range'].includes(ev.target.type));
    switch (ev.code) {
      case 'Space':
        if (onControl) return; // Space presses the focused control
        ev.preventDefault();
        togglePlay();
        break;
      case 'Comma': case 'Period': {
        if (ev.target instanceof HTMLInputElement && ev.target.type === 'range') return;
        ev.preventDefault();
        const ms = ev.altKey ? DAY : ev.shiftKey ? HOUR : 10 * MIN;
        stepBy(ev.code === 'Comma' ? -ms : ms);
        break;
      }
      case 'BracketLeft': case 'BracketRight': {
        ev.preventDefault();
        const i = SPEEDS.indexOf(clock.playing ? nearestSpeed(clock.rate) : 0);
        setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + (ev.code === 'BracketRight' ? 1 : -1)))]);
        break;
      }
      case 'KeyN':
        if (ev.altKey || ev.shiftKey) return;
        ev.preventDefault();
        goLive();
        break;
      case 'KeyT':
        if (ev.altKey || ev.shiftKey) return;
        ev.preventDefault();
        openSky(form.hidden);
        if (!form.hidden) (form.querySelector('#sky-play')).focus({ preventScroll: true });
        break;
      default:
    }
  });

  Object.assign(app, { openSky, renderSky: render, togglePlay, goLive });
}
