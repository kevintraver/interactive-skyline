// The shared transport bar (plan 01, section 4.3; task T1.8): the last child of #dock, styled like #changes, shown
// only while a journey is active. Its scrubber moves the clock (handle.seek), "Depart" re-anchors the journey
// (handle.setStart: the position is kept and the sky moves), Now sets the departure so that the present position
// is now and follows the wall clock. #transport-slot, directly above it, is where a mode mounts its own bar.
import { formatTimeParam, parseTimeParam } from '../sim/clock.js';

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** @returns {import('../contracts.d.ts').Transport} */
export function initTransport(app) {
  const { clock, timeline, env } = app;
  const bar = document.getElementById('transport'), slot = document.getElementById('transport-slot');
  const play = bar.querySelector('.play'), label = bar.querySelector('.label'), scrub = bar.querySelector('.scrub');
  const marks = bar.querySelector('.marks'), pos = bar.querySelector('.pos'), speed = bar.querySelector('.speed');
  const depart = bar.querySelector('.depart input'), now = bar.querySelector('.now');
  let scrubbing = false;
  app.loop.add({ demand: () => (scrubbing ? 'continuous' : 'idle') }, 16);

  // the slot shows only when a mode has put something in it
  new MutationObserver(() => { slot.hidden = !slot.children.length; }).observe(slot, { childList: true });

  function render() {
    const h = timeline.active;
    bar.hidden = !h;
    if (!h) return;
    const j = h.journey;
    if (!scrubbing) scrub.value = String(h.progressS);
    pos.value = `${mmss(h.progressS)} / ${mmss(j.durationS)}`;
    const playing = h.coupling === 'clock' && clock.playing;
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    if (document.activeElement !== depart) depart.value = formatTimeParam(h.startMs, clock.zone).slice(0, 16);
  }

  timeline.on('begin', (h) => {
    const j = h.journey;
    label.textContent = j.label;
    scrub.max = String(j.durationS);
    marks.replaceChildren(...(j.markers || []).map((m) => Object.assign(document.createElement('span'), {
      textContent: m.label, style: `left: ${(m.progressS / j.durationS) * 100}%`,
    })));
    env.enterClock(); // a journey moves the clock
    render();
  });
  timeline.on('end', render);
  for (const type of ['tick', 'seek', 'state']) clock.on(type, render);

  play.addEventListener('click', () => {
    if (clock.playing) clock.pause();
    else { clock.setRate(Number(speed.value)); clock.play(); }
    render();
  });
  speed.addEventListener('change', () => { if (clock.playing) clock.setRate(Number(speed.value)); });
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  const release = () => { scrubbing = false; render(); };
  scrub.addEventListener('pointerup', release);
  scrub.addEventListener('pointercancel', release);
  scrub.addEventListener('input', () => { if (timeline.active) timeline.active.seek(Number(scrub.value)); });
  depart.addEventListener('change', () => {
    const t = parseTimeParam(depart.value, clock.zone);
    if (t && t.timeMs !== undefined && timeline.active) timeline.active.setStart(t.timeMs);
  });
  now.addEventListener('click', () => {
    const h = timeline.active;
    if (!h) return;
    h.setStart(Date.now() - h.progressS * 1000);
    clock.goLive();
  });

  const transport = {
    get slotAbove() { return slot; },
    attachJourney(j) {
      if (!j) { if (timeline.active) timeline.active.end(); return null; }
      return timeline.begin(j);
    },
  };
  app.transport = transport;
  return transport;
}
