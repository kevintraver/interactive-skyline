// The frame loop: render on demand, in four tiers (plan 01, section 5.5; task T1.9).
//
//   idle        render only after invalidate(): exactly the app before phase 1
//   ambient     twice a second (the clock running at up to 60x)
//   animated    30 times a second
//   continuous  every animation frame (scrubbing, a clock faster than 60x, a journey playing)
//
// Each registered subsystem may vote through demand(); the loop takes the highest vote. On a rendered frame the
// subsystems' update(frame) run in their `order` (0 clock, 10 timeline, 40 env, 50 shadows), then render().
// `before(now)` still runs on every animation frame, as it always has, because the camera's damping and the
// fly-to animation must see every frame to know whether they moved (they invalidate when they do). The fountain,
// LED and wheel tick in attractions.js keeps asking for frames through invalidate() until integration v7.
const TIERS = ['idle', 'ambient', 'animated', 'continuous'];
const INTERVAL = { idle: Infinity, ambient: 500, animated: 1000 / 30, continuous: 0 };
const SLACK_MS = 2; // whole 60 Hz ticks: a frame due at 33.3 ms runs on the tick at 33.3, not the one after

/** A clock's vote: paused -> idle; up to 60x -> ambient; faster -> continuous (section 5.5). */
export function clockDemand(clock) {
  if (!clock.playing && !clock.live) return 'idle';
  return Math.abs(clock.rate) > 60 ? 'continuous' : 'ambient';
}

/**
 * @param {{ raf?: (fn: (now: number) => void) => unknown, now?: () => number, hidden?: () => boolean }} [o]
 *   injected in tests; the browser's requestAnimationFrame, performance.now and document.hidden by default.
 */
export function createFrameLoop({
  raf = (fn) => requestAnimationFrame(fn),
  now = () => performance.now(),
  hidden = () => typeof document !== 'undefined' && document.hidden,
} = {}) {
  let dirty = true, running = false, lastRender = -Infinity, frameNo = 0;
  const subsystems = []; // { sub, order, seq }
  let seq = 0;
  const settlers = [];

  function vote() {
    let best = 0;
    for (const { sub } of subsystems) {
      if (!sub.demand) continue;
      const i = TIERS.indexOf(sub.demand());
      if (i > best) best = i;
    }
    return TIERS[best];
  }

  const loop = {
    /** Frames rendered since the page loaded; the performance tests read it. */
    frames: 0,
    /** The tier the last animation frame ran at. */
    tier: 'idle',
    invalidate: () => { dirty = true; },
    clockDemand,
    /**
     * Register per-frame work: { update?(frame), demand?() }. `order` places it in the frame (section 5.5;
     * 20 to 29 are reserved for modes). Returns a function that removes it.
     */
    add(sub, order = 50) {
      const entry = { sub, order, seq: seq++ };
      subsystems.push(entry);
      subsystems.sort((a, b) => a.order - b.order || a.seq - b.seq);
      return () => {
        const i = subsystems.indexOf(entry);
        if (i >= 0) subsystems.splice(i, 1);
      };
    },
    /** Resolves when nothing is pending: no frame asked for and the tier back at idle. */
    settle() {
      return new Promise((resolve) => settlers.push(resolve));
    },
    /**
     * Start drawing. `before(now)` runs every animation frame; `render(now)` only on frames the tiers or an
     * invalidate() ask for. (`renderer` is kept for the old signature; the loop drives itself.)
     */
    start(renderer, { before, render }) {
      if (running) return;
      running = true;
      const frame = (t) => {
        raf(frame);
        const nowMs = t ?? now();
        if (hidden()) { lastRender = Math.max(lastRender, nowMs - 250); return; } // no catch-up burst on return
        before(nowMs);
        const previous = loop.tier;
        const tier = loop.tier = vote();
        const due = nowMs - lastRender >= INTERVAL[tier] - SLACK_MS;
        if (!dirty && !due) {
          if (tier === 'idle' && settlers.length) settlers.splice(0).forEach((fn) => fn());
          return;
        }
        dirty = false;
        // wall time since the last rendered frame; after an idle stretch (the clock was paused) only one frame's
        // worth, so a clock that starts playing does not jump by the time it stood still
        const dtWallMs = Number.isFinite(lastRender) ? Math.min(nowMs - lastRender, previous === 'idle' ? 1000 / 60 : 1000) : 0;
        lastRender = nowMs;
        const info = { nowMs, dtWallMs, frame: frameNo++ };
        for (const { sub } of subsystems) if (sub.update) sub.update(info);
        render(nowMs);
        loop.frames++;
      };
      raf(frame);
    },
  };
  return loop;
}
