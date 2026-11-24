// T1.9: the frame loop's four tiers (plan 01, section 5.5), on a fake scheduler and a fake clock.
import { describe, it, expect } from 'vitest';
import { createFrameLoop } from '../../../src/render/frameLoop.js';
import { createSimClock } from '../../../src/sim/clock.js';

/** A 60 Hz requestAnimationFrame that runs only when told to. */
function fakeScheduler() {
  let now = 0, queue = [];
  return {
    raf: (fn) => { queue.push(fn); return queue.length; },
    now: () => now,
    /** One animation frame `ms` after the last. */
    advanceBy(ms) {
      now += ms;
      const q = queue; queue = [];
      for (const fn of q) fn(now);
    },
    /** Run `seconds` of 60 Hz frames. */
    run(seconds) {
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        now += 1000 / 60;
        const q = queue; queue = [];
        for (const fn of q) fn(now);
      }
    },
  };
}

function setup({ hidden = () => false } = {}) {
  const s = fakeScheduler();
  const loop = createFrameLoop({ raf: s.raf, now: s.now, hidden });
  const clock = createSimClock({ zone: 'America/Los_Angeles', now: () => 0, timeMs: Date.UTC(2026, 0, 1) });
  let renders = 0;
  const order = [];
  loop.add({ update: (f) => { clock.advance(f.dtWallMs); order.push('clock'); }, demand: () => loop.clockDemand(clock) }, 0);
  loop.add({ update: () => order.push('env') }, 40);
  loop.add({ update: () => order.push('timeline') }, 10);
  loop.start({ setAnimationLoop: () => { throw new Error('the loop drives itself'); } }, { before() {}, render() { renders++; order.push('render'); } });
  s.run(0.5); // the first frame (dirty at start) is drawn
  renders = 0;
  order.length = 0;
  return { s, loop, clock, renders: () => renders, order };
}

describe('frame loop tiers', () => {
  it('paused and still: zero renders in ten seconds', () => {
    const t = setup();
    t.s.run(10);
    expect(t.renders()).toBe(0);
    expect(t.loop.tier).toBe('idle');
  });

  it('clock at 1x: two renders a second (ambient)', () => {
    const t = setup();
    t.clock.play();
    t.s.run(10);
    expect(t.loop.tier).toBe('ambient');
    expect(t.renders()).toBeGreaterThanOrEqual(19);
    expect(t.renders()).toBeLessThanOrEqual(21);
    // the clock still advances by the wall time between rendered frames
    expect(Math.abs(t.clock.timeMs - Date.UTC(2026, 0, 1) - 10000)).toBeLessThan(600);
  });

  it('clock at up to 60x is ambient, faster is continuous', () => {
    const t = setup();
    t.clock.play();
    t.clock.setRate(60);
    t.s.run(1);
    expect(t.loop.tier).toBe('ambient');
    t.clock.setRate(600);
    t.s.run(10);
    expect(t.loop.tier).toBe('continuous');
    expect(t.renders()).toBeGreaterThanOrEqual(598);
  });

  it('a show in view, through invalidate() 30 times a second: thirty renders a second', () => {
    const t = setup();
    let last = -Infinity;
    // attractions.js's tick: every animation frame, invalidate when a show frame is due
    const tick = (now) => { t.s.raf(tick); if (now - last >= 1000 / 30 - 2) { last = now; t.loop.invalidate(); } };
    t.s.raf(tick);
    t.s.run(10);
    expect(t.renders()).toBeGreaterThanOrEqual(298);
    expect(t.renders()).toBeLessThanOrEqual(302);
  });

  it('scrubbing: every frame (continuous)', () => {
    const t = setup();
    const scrub = t.loop.add({ demand: () => 'continuous' }, 15);
    t.s.run(10);
    expect(t.renders()).toBe(600);
    scrub();
    t.s.run(1);
    const before = t.renders();
    t.s.run(10);
    expect(t.renders()).toBe(before);
  });

  it('the animated tier renders 30 times a second', () => {
    const t = setup();
    t.loop.add({ demand: () => 'animated' }, 15);
    t.s.run(10);
    expect(t.renders()).toBeGreaterThanOrEqual(298);
    expect(t.renders()).toBeLessThanOrEqual(302);
  });

  it('keeps twice a second when animation frames arrive irregularly (a loaded machine)', () => {
    const s = fakeScheduler();
    const loop = createFrameLoop({ raf: s.raf, now: s.now });
    let renders = 0;
    loop.add({ demand: () => 'ambient' }, 0);
    loop.start(null, { before() {}, render() { renders++; } });
    s.run(0.05);
    renders = 0;
    // frames every 300 to 450 ms: rendering 500 ms after the last render would wait a whole extra frame each time
    const gaps = [300, 450, 350, 420, 310, 440];
    let t = 0;
    for (let i = 0; i < 60; i++) { t += gaps[i % gaps.length]; s.advanceBy(gaps[i % gaps.length]); }
    expect(renders / (t / 1000)).toBeGreaterThan(1.8);
    expect(renders / (t / 1000)).toBeLessThanOrEqual(2.2);
  });

  it('the highest vote wins', () => {
    const t = setup();
    t.loop.add({ demand: () => 'animated' }, 15);
    t.loop.add({ demand: () => 'ambient' }, 16);
    t.s.run(1);
    expect(t.loop.tier).toBe('animated');
  });

  it('runs the frame steps in order, then renders', () => {
    const t = setup();
    t.loop.invalidate();
    t.s.run(0.1);
    expect(t.order).toEqual(['clock', 'timeline', 'env', 'render']);
  });

  it('stops while the document is hidden', () => {
    let hidden = false;
    const t = setup({ hidden: () => hidden });
    t.clock.play();
    hidden = true;
    t.s.run(5);
    expect(t.renders()).toBe(0);
    hidden = false;
    t.s.run(1);
    expect(t.renders()).toBeGreaterThan(0);
  });

  it('settle() resolves once nothing is pending and the tier is idle', async () => {
    const t = setup();
    t.clock.play();
    let settled = false;
    const p = t.loop.settle().then(() => { settled = true; });
    t.s.run(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    t.clock.pause();
    t.loop.invalidate();
    t.s.run(0.2);
    await p;
    expect(settled).toBe(true);
  });

  it('counts the frames it renders', () => {
    const t = setup();
    const f0 = t.loop.frames;
    t.loop.invalidate();
    t.s.run(0.1);
    expect(t.loop.frames).toBe(f0 + 1);
  });
});
