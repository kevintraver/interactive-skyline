// Render on demand: a frame is drawn only after invalidate(). (Phase 1, T1.9, turns this into the tiered
// scheduler of plan 01, section 5.5; the fountain, LED and wheel tick in attractions.js still only calls
// invalidate().)
export function createFrameLoop() {
  let dirty = true;
  const loop = {
    /** Frames rendered since the page loaded; the performance tests read it. */
    frames: 0,
    invalidate: () => { dirty = true; },
    /**
     * Start drawing. `before(now)` runs every animation frame; `render(now)` only when something asked for a frame.
     */
    start(renderer, { before, render }) {
      renderer.setAnimationLoop((now) => {
        before(now);
        if (!dirty) return;
        dirty = false;
        render(now);
        loop.frames++;
      });
    },
  };
  return loop;
}
