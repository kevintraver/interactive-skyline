// The drive's transport for now: one pill in #dock with play/pause, the city's local time and the speed.
// The next task grows this into the route bar, so it owns its own DOM.

const MPH = 0.44704;

/**
 * @param {{ dock: HTMLElement, tz: string, units: () => 'ft'|'m', onToggle: () => void }} opts
 *   units is read on every update so a change in the options shows at once (feet go with mph, metres with km/h)
 */
export function createTransport({ dock, tz, units, onToggle }) {
  const el = document.createElement('div');
  el.id = 'drivebar';
  el.hidden = true;
  el.innerHTML = '<button class="play" type="button"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#i-play" /></svg></button>'
    + '<span class="time"></span><span class="speed"></span><span class="status"></span>';
  dock.prepend(el);
  const btn = el.querySelector('.play'), use = btn.querySelector('use');
  const time = el.querySelector('.time'), speed = el.querySelector('.speed'), status = el.querySelector('.status');
  btn.addEventListener('click', onToggle);
  const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const shown = { playing: null, minute: null, speed: null, status: null };

  return {
    el,
    show(on) { el.hidden = !on; },
    /** Loading text in place of the readings, or null for the readings. */
    setStatus(text) {
      if (shown.status === text) return;
      shown.status = text;
      status.textContent = text || '';
      el.classList.toggle('busy', !!text);
    },
    /** Write only what changed, so a frame costs no layout when nothing did. */
    update({ playing, simMs, speed: v }) {
      if (playing !== shown.playing) {
        shown.playing = playing;
        use.setAttribute('href', playing ? '#i-pause' : '#i-play');
        btn.title = playing ? 'Pause (Space)' : 'Play (Space)';
        btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        btn.setAttribute('aria-pressed', String(playing));
      }
      const minute = Math.floor(simMs / 60000);
      if (minute !== shown.minute) {
        shown.minute = minute;
        time.textContent = clockFmt.format(simMs);
      }
      const metric = units() === 'm';
      const text = metric ? `${Math.round(v * 3.6)} km/h` : `${Math.round(v / MPH)} mph`;
      if (text !== shown.speed) { shown.speed = text; speed.textContent = text; }
    },
  };
}
