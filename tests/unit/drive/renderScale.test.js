// The drive's adaptive render scale (src/drive/renderScale.js): steps down when frames run over budget, never below the
// floor; steps back up only after a clean stretch, with a doubling wait after a failed try (no hunting); paused frames
// at the full ratio; off under automation and on a software renderer; leaving Drive puts the full ratio back.
import { describe, it, expect } from 'vitest';
import { SCALE, scaleState, scaleStep, adaptiveAllowed, createRenderScale } from '../../../src/drive/renderScale.js';

const SLOW = 33.3, FAST = 16.7;
/** A window's worth of intervals with `share` of them slow (a third: one step; all: two). */
const mixed = (s, share, windows) => {
  for (let w = 0; w < windows; w++) for (let i = 0; i < SCALE.SETTLE + SCALE.WINDOW; i++) s = scaleStep(s, i < SCALE.SETTLE ? FAST : (i - SCALE.SETTLE) < share * SCALE.WINDOW ? SLOW : FAST);
  return s;
};
/** Feed `n` intervals of `dt` ms through the rule. */
const feed = (s, dt, n) => { for (let i = 0; i < n; i++) s = scaleStep(s, dt); return s; };
/** Frames to fill one window after a change (the settling frames first). */
const WINDOW_AFTER_CHANGE = SCALE.SETTLE + SCALE.WINDOW;

describe('scaleStep', () => {
  it('stays at the full ratio while frames are on time', () => {
    const s = feed(scaleState(2), FAST, 2000);
    expect(s.ratio).toBe(2);
  });

  it('steps down one STEP per slow window, two when far over budget, never below the floor', () => {
    let s = mixed(scaleState(2), 1 / 3, 1);
    expect(s.ratio).toBe(2 - SCALE.STEP);
    s = mixed(s, 1 / 3, 1);
    expect(s.ratio).toBe(2 - 2 * SCALE.STEP);
    let f = feed(scaleState(2), SLOW, WINDOW_AFTER_CHANGE); // every frame slow: two steps at once
    expect(f.ratio).toBe(2 - 2 * SCALE.STEP);
    f = feed(f, SLOW, WINDOW_AFTER_CHANGE);
    expect(f.ratio).toBe(1);
    s = feed(s, SLOW, 20 * WINDOW_AFTER_CHANGE);
    expect(s.ratio).toBe(1);
  });

  it('never goes below the full ratio when that is under the floor (a ratio-1 screen stays at 1)', () => {
    const s = feed(scaleState(1), SLOW, 10 * WINDOW_AFTER_CHANGE);
    expect(s.ratio).toBe(1);
  });

  it('leaves out the settling frames after a change and stalls over STALL_MS', () => {
    let s = scaleState(2);
    s = feed(s, SLOW, SCALE.SETTLE + SCALE.WINDOW - 1);
    expect(s.ratio).toBe(2); // one interval short of a window
    s = feed(s, SCALE.STALL_MS + 1, 50); // a hidden tab: ignored
    expect(s.ratio).toBe(2);
    s = scaleStep(s, SLOW);
    expect(s.ratio).toBe(2 - 2 * SCALE.STEP); // all slow: two steps
  });

  it('does not step down for a share of slow frames under DOWN_SHARE', () => {
    let s = scaleState(2);
    const slowPerWindow = Math.ceil(SCALE.DOWN_SHARE * SCALE.WINDOW) - 1;
    for (let w = 0; w < 50; w++) for (let i = 0; i < SCALE.WINDOW + (w === 0 ? SCALE.SETTLE : 0); i++) s = scaleStep(s, i < slowPerWindow ? SLOW : FAST);
    expect(s.ratio).toBe(2);
  });

  it('steps up only after UP_WAIT_MS of clean windows (hysteresis)', () => {
    let s = mixed(scaleState(2), 1 / 3, 1); // 1.75
    const framesToWait = Math.ceil(SCALE.UP_WAIT_MS / FAST);
    s = feed(s, FAST, SCALE.SETTLE + framesToWait - 2 * SCALE.WINDOW);
    expect(s.ratio).toBe(2 - SCALE.STEP);
    s = feed(s, FAST, 3 * SCALE.WINDOW);
    expect(s.ratio).toBe(2);
  });

  it('a mixed stretch (between the two shares) restarts the clean run', () => {
    let s = mixed(scaleState(2), 1 / 3, 1);
    s = feed(s, FAST, SCALE.SETTLE + Math.ceil(SCALE.UP_WAIT_MS / FAST) - 2 * SCALE.WINDOW);
    // one window with 2 of 30 slow frames (between UP_SHARE and DOWN_SHARE): neither down nor clean
    for (let i = 0; i < SCALE.WINDOW; i++) s = scaleStep(s, i < 2 ? SLOW : FAST);
    expect(s.cleanMs).toBe(0);
    s = feed(s, FAST, 2 * SCALE.WINDOW);
    expect(s.ratio).toBe(2 - SCALE.STEP);
  });

  it('doubles the wait after a failed try, so it does not hunt between two steps', () => {
    // each phase starts on an empty window, so no interval of one phase is counted in the next
    const fresh = (x) => ({ ...x, window: [], settle: 0 });
    let s = fresh(mixed(scaleState(2), 1 / 3, 1)); // 1.75
    const wait0 = s.upWaitMs;
    s = feed(s, FAST, Math.ceil(wait0 / FAST) + SCALE.WINDOW); // up to 2
    expect(s.ratio).toBe(2);
    s = fresh(mixed(fresh(s), 1 / 3, 1)); // too slow at once: back down, and the next try waits twice as long
    expect(s.ratio).toBe(2 - SCALE.STEP);
    expect(s.upWaitMs).toBe(2 * wait0);
    const before = feed(s, FAST, Math.ceil(wait0 / FAST) + SCALE.WINDOW);
    expect(before.ratio).toBe(2 - SCALE.STEP); // the old wait is not enough now
    const after = feed(s, FAST, Math.ceil((2 * wait0) / FAST) + SCALE.WINDOW);
    expect(after.ratio).toBe(2);
    // and the doubling stops at UP_WAIT_MAX_MS
    let t = { ...s, upWaitMs: SCALE.UP_WAIT_MAX_MS, sinceUpMs: 0, settle: 0 };
    t = feed(t, SLOW, SCALE.WINDOW);
    expect(t.upWaitMs).toBe(SCALE.UP_WAIT_MAX_MS);
  });

  it('is pure: the state passed in is not changed', () => {
    const s = scaleState(2);
    const copy = JSON.stringify(s);
    feed(s, SLOW, 200);
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe('adaptiveAllowed', () => {
  it('is off under automation and on a software renderer', () => {
    expect(adaptiveAllowed({})).toBe(true);
    expect(adaptiveAllowed({ webdriver: true })).toBe(false);
    expect(adaptiveAllowed({ software: true })).toBe(false);
  });
});

describe('createRenderScale', () => {
  const fakeRenderer = (r) => {
    const calls = [];
    return { calls, getPixelRatio: () => r, setPixelRatio(x) { r = x; calls.push(x); } };
  };
  /** Play `n` frames `dt` apart from `t0`; returns the time after. */
  const play = (sc, t0, dt, n, playing = true) => { let t = t0; for (let i = 0; i < n; i++) { t += dt; sc.tick(t, playing); } return t; };

  it('lowers the ratio while playing slowly, draws paused frames at the full ratio, and resumes at the learned one', () => {
    const r = fakeRenderer(2);
    let asked = 0;
    const sc = createRenderScale({ renderer: r, invalidate: () => asked++, allowed: true });
    sc.enter();
    let t = play(sc, 0, SLOW, WINDOW_AFTER_CHANGE + 2); // every frame slow: two steps at once
    expect(r.getPixelRatio()).toBe(1.5);
    expect(asked).toBeGreaterThan(0); // a change asks for a frame
    sc.tick(t += SLOW, false); // paused: the full ratio at once, before the paused frame is drawn
    expect(r.getPixelRatio()).toBe(2);
    sc.tick(t += SLOW, true); // playing again: the learned ratio
    expect(r.getPixelRatio()).toBe(1.5);
  });

  it('is off when not allowed (automation, software): the full ratio whatever the frame times', () => {
    const r = fakeRenderer(2);
    const sc = createRenderScale({ renderer: r, invalidate() {}, allowed: false });
    sc.enter();
    play(sc, 0, SLOW, 10 * WINDOW_AFTER_CHANGE);
    expect(r.getPixelRatio()).toBe(2);
    expect(r.calls).toEqual([]);
    sc.setAdaptive(true); // a probe's override
    play(sc, 1e6, SLOW, 2 * WINDOW_AFTER_CHANGE + 2);
    expect(r.getPixelRatio()).toBeLessThan(2);
    sc.setAdaptive(false);
    sc.tick(2e6, true);
    expect(r.getPixelRatio()).toBe(2);
  });

  it('puts the full ratio back on leaving Drive, and does nothing outside Drive', () => {
    const r = fakeRenderer(2);
    const sc = createRenderScale({ renderer: r, invalidate() {}, allowed: true });
    sc.enter();
    play(sc, 0, SLOW, 4 * WINDOW_AFTER_CHANGE);
    expect(r.getPixelRatio()).toBeLessThan(2);
    sc.leave();
    expect(r.getPixelRatio()).toBe(2);
    const n = r.calls.length;
    play(sc, 1e6, SLOW, 4 * WINDOW_AFTER_CHANGE); // the map: untouched
    expect(r.calls.length).toBe(n);
    expect(r.getPixelRatio()).toBe(2);
  });
});
