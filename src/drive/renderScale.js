// The drive's adaptive render scale: the safety net under the frame budget (plan 02, section 9.1). While the clock plays,
// the intervals between animation frames are watched; when too many of them run over the budget the drive lowers the
// renderer's pixel ratio a step, and when they have stayed clean for a while it tries a step back up. A paused frame,
// and so every settled frame, is drawn at the full ratio (the one the app set when Drive was entered); leaving Drive puts
// the full ratio back. Off under automation (navigator.webdriver) and on a software renderer, so tests and golden
// images never see a lowered ratio; a probe can switch it on (setAdaptive).
//
// The rule (scaleStep, pure): intervals come in windows of WINDOW frames, the first SETTLE frames after any change of
// ratio left out (a resize hitches the frame it lands on).
//   down  a window with at least DOWN_SHARE of its intervals over BUDGET_MS: one STEP down (two with FAR_SHARE or more:
//         each change of ratio reallocates the canvas and hitches a frame, so far over budget it gets there in fewer),
//         never below `min`.
//   up    windows with at most UP_SHARE over the budget for `upWaitMs` in a row (UP_WAIT_MS at first): one STEP up,
//         never above `full`. A step down within PROBE_MS of a step up was a failed try: the wait before the next try
//         doubles (up to UP_WAIT_MAX_MS), so the ratio does not hunt between two steps.
//   else  the clean run starts again.
// Intervals over STALL_MS (a hidden tab, a long task) are left out, as are those of the first frame after playing starts.

export const SCALE = Object.freeze({
  BUDGET_MS: 20, // an interval over this missed a 60 Hz frame
  WINDOW: 30,
  SETTLE: 6,
  DOWN_SHARE: 0.1, // the budget is under 5% of frames late: a tenth late is a step down
  UP_SHARE: 0.03,
  STEP: 0.25,
  FAR_SHARE: 0.5,
  UP_WAIT_MS: 4000,
  UP_WAIT_MAX_MS: 64000,
  PROBE_MS: 6000,
  STALL_MS: 250,
});

/** A fresh state for the rule. */
export function scaleState(full, min = 1) {
  const lo = Math.min(min, full);
  return { full, min: lo, ratio: full, window: [], settle: SCALE.SETTLE, cleanMs: 0, upWaitMs: SCALE.UP_WAIT_MS, sinceUpMs: Infinity };
}

/**
 * One interval through the rule. Pure: returns the next state (a new object; the input is not changed).
 * @param {ReturnType<typeof scaleState>} s  @param {number} dtMs the interval between two animation frames while playing
 * @returns {ReturnType<typeof scaleState>}
 */
export function scaleStep(s, dtMs) {
  const n = { ...s, window: s.window };
  if (!(dtMs > 0) || dtMs > SCALE.STALL_MS) return n;
  n.sinceUpMs = s.sinceUpMs + dtMs;
  if (s.settle > 0) { n.settle = s.settle - 1; return n; }
  n.window = [...s.window, dtMs];
  if (n.window.length < SCALE.WINDOW) return n;
  const over = n.window.filter((x) => x > SCALE.BUDGET_MS).length / n.window.length;
  const spanMs = n.window.reduce((a, x) => a + x, 0);
  n.window = [];
  if (over >= SCALE.DOWN_SHARE) {
    n.cleanMs = 0;
    if (s.ratio > n.min) {
      if (n.sinceUpMs < SCALE.PROBE_MS) n.upWaitMs = Math.min(SCALE.UP_WAIT_MAX_MS, s.upWaitMs * 2); // a failed try
      const step = over >= SCALE.FAR_SHARE ? 2 * SCALE.STEP : SCALE.STEP; // far over: two steps at once (each change hitches)
      n.ratio = Math.max(n.min, round(s.ratio - step));
      n.settle = SCALE.SETTLE;
      n.sinceUpMs = Infinity;
    }
  } else if (over <= SCALE.UP_SHARE) {
    n.cleanMs = s.cleanMs + spanMs;
    if (s.ratio < n.full && n.cleanMs >= s.upWaitMs) {
      n.ratio = Math.min(n.full, round(s.ratio + SCALE.STEP));
      n.cleanMs = 0;
      n.settle = SCALE.SETTLE;
      n.sinceUpMs = 0;
    }
  } else n.cleanMs = 0;
  return n;
}

const round = (x) => Math.round(x * 1000) / 1000;

/** Whether a WebGL renderer draws in software (SwiftShader, llvmpipe and the like), from its unmasked name. */
export function isSoftwareRenderer(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch { return false; } // unknown: not software
}

/** Whether the adaptation may run here: not under automation, not on a software renderer. */
export function adaptiveAllowed({ webdriver = false, software = false } = {}) {
  return !webdriver && !software;
}

/**
 * The controller the session runs (session.js frame and show).
 * @param {{ renderer: { getPixelRatio(): number, setPixelRatio(r: number): void }, invalidate: () => void,
 *   allowed: boolean, min?: number }} o
 */
export function createRenderScale({ renderer, invalidate, allowed, min = 1 }) {
  let full = null, adaptive = allowed, state = null, lastNow = null, wasPlaying = false, changes = 0;
  const apply = (r) => {
    if (Math.abs(renderer.getPixelRatio() - r) < 1e-6) return;
    renderer.setPixelRatio(r);
    changes++;
    invalidate();
  };
  return {
    /** Entering Drive: the ratio the app has set is the full one. */
    enter() { full = renderer.getPixelRatio(); state = scaleState(full, min); lastNow = null; wasPlaying = false; },
    /** Leaving Drive: the full ratio back. */
    leave() { if (full !== null) apply(full); full = null; state = null; lastNow = null; },
    /**
     * Once per animation frame (before the frame is drawn). Playing, the interval since the last call goes through the
     * rule and the ratio follows it; paused, the ratio is the full one at once (the paused frame is drawn at it).
     */
    tick(now, playing) {
      if (full === null) return;
      if (!adaptive || !playing) {
        lastNow = null; wasPlaying = false;
        apply(full);
        return;
      }
      if (!wasPlaying) state = { ...state, settle: SCALE.SETTLE, window: [] }; // playing again: the resume hitches too
      const dt = lastNow === null || !wasPlaying ? NaN : now - lastNow;
      lastNow = now; wasPlaying = true;
      if (Number.isFinite(dt)) state = scaleStep(state, dt);
      apply(state.ratio); // the learned ratio, also on the first frame after playing starts again
    },
    /** On or off (a probe's override of the automation rule); off puts the full ratio back on the next tick. */
    setAdaptive(on) { adaptive = !!on; if (full !== null && !adaptive) state = scaleState(full, min); },
    get adaptive() { return adaptive; },
    stats: () => ({ adaptive, allowed, full, ratio: renderer.getPixelRatio(), playRatio: state ? state.ratio : null, upWaitMs: state ? state.upWaitMs : null, changes }),
  };
}
