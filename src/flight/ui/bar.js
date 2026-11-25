// The flight's own bar, mounted in #transport-slot above plan 01's journey bar (plan 03, sections 4.4 and 4.9): the
// status chip (phase, time to touchdown, altitude, ground speed, in the visitor's units; H hides it), the pace (the
// condensed pace, or the rate the visitor chose; pressing it turns the condensed pace back on), the seat (opens the
// seat map, ui/seatMap.js), the cabin frame (C), the window's glass (the window panel, ui/windowPanel.js),
// a "Retimed" note when the departure is not the recorded one, and a line for loading. In an orbit (setKind('orbit'))
// the pace has no meaning and hides, and the chip names the orbit's phase ("Orbiting", "Changing the orbit").
import { flightStatus } from './status.js';

const icon = (id) => `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#${id}" /></svg>`;
const rateText = (r) => `${Math.round(r * 10) / 10}×`;

/**
 * @param {{ slot: HTMLElement, units: () => 'ft'|'m', onPace: () => void, onFrame: () => void, onSeat?: () => void }} o
 */
export function createFlightBar({ slot, units, onPace, onFrame, onSeat = () => {}, onWindow = () => {} }) {
  const el = document.createElement('div');
  el.id = 'flightbar';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Flight');
  el.innerHTML = `<span class="status" title="Hide (H)"><b class="phase"></b><span class="ttd"></span><span class="alt"></span><span class="gs"></span></span>
    <button type="button" class="pace" aria-pressed="true" title="The condensed pace: cruise and descent fast, the last minutes in real time"></button>
    <button type="button" class="seat" aria-haspopup="dialog" aria-expanded="false" aria-controls="seatmap" title="Choose a seat"><span class="seat-id"></span></button>
    <button type="button" class="frame" aria-pressed="true" title="Cabin frame (C)">${icon('i-eye')}<span>Frame</span></button>
    <button type="button" class="window" aria-haspopup="dialog" aria-expanded="false" aria-controls="flightwindow" title="The window's glass: frost, rain, scratches, reflections, focus (F)">Window</button>
    <span class="retimed" hidden title="The departure is not the recorded one">Retimed</span>
    <span class="note" hidden></span>`;
  const $ = (s) => el.querySelector(s);
  const status = $('.status'), phase = $('.phase'), ttd = $('.ttd'), alt = $('.alt'), gs = $('.gs');
  const win = $('.window');
  win.addEventListener('click', () => onWindow());
  const pace = $('.pace'), frame = $('.frame'), retimed = $('.retimed'), note = $('.note'), seat = $('.seat'), seatId = $('.seat-id');
  pace.addEventListener('click', () => { pace.blur(); onPace(); });
  seat.addEventListener('click', () => onSeat());
  frame.addEventListener('click', () => { frame.blur(); onFrame(); });
  const shown = { text: null, pace: null, frame: null, retimed: null, hud: null };

  return {
    el,
    /** Into #transport-slot (the slot shows only while it has children) or out of it. */
    show(on) { if (on && el.parentNode !== slot) slot.append(el); else if (!on && el.parentNode) el.remove(); },
    /** The seat shown on its button ('23F'), and whether the seat map is open. */
    setSeat(id, open) {
      if (id) { seatId.textContent = `Seat ${id}`; seat.setAttribute('aria-label', `Seat ${id}: choose a seat`); }
      if (typeof open === 'boolean') seat.setAttribute('aria-expanded', String(open));
    },
    /** Whether the window panel is open (the button's state). */
    setWindow(open) { win.setAttribute('aria-expanded', String(!!open)); },
    /** The Window button (focus goes back to it when the panel closes). */
    windowButton: win,
    /** Loading text in place of the readings, or null. */
    setNote(text) { note.hidden = !text; note.textContent = text || ''; },
    /** 'flight' (the pace shows) or 'orbit' (it hides: the orbit runs at the clock's rate). */
    setKind(kind) { pace.hidden = kind === 'orbit'; },
    /** Write only what changed, so a frame costs no layout when nothing did. `phase` overrides the chip's phase words. */
    update({ state, touchdownT, events, pace: paceOn, rate, frame: frameOn, retimed: isRetimed, hud, phase: phaseText }) {
      if (state) {
        const s = flightStatus(state, { touchdownT, events, units: units() });
        if (phaseText) { s.phase = phaseText; s.text = [s.phase, s.toTouchdown, s.altitude, s.speed].filter(Boolean).join(' · '); }
        if (s.text !== shown.text) {
          shown.text = s.text;
          phase.textContent = s.phase;
          ttd.textContent = s.toTouchdown;
          ttd.hidden = !s.toTouchdown;
          alt.textContent = s.altitude;
          gs.textContent = s.speed;
          status.setAttribute('aria-label', s.text);
        }
      }
      const p = paceOn ? 'Condensed' : rateText(rate);
      if (p !== shown.pace) { shown.pace = p; pace.textContent = p; pace.setAttribute('aria-pressed', String(!!paceOn)); }
      if (frameOn !== shown.frame) { shown.frame = frameOn; frame.setAttribute('aria-pressed', String(!!frameOn)); }
      if (isRetimed !== shown.retimed) { shown.retimed = isRetimed; retimed.hidden = !isRetimed; }
      if (hud !== shown.hud) { shown.hud = hud; status.hidden = !hud; }
    },
  };
}
