// The content clock of the drive's screens (plan 02, D7.3): every animated surface (the LED skins of night.js,
// the fountain show, the turning wheel, the digital billboards) reads seconds from simulation time, so a frame is
// a pure function of simulation time: scrub back to a moment and the screens show what they showed then, pause
// and they hold, run at 16x and they run 16 times as fast.
//
// The shaders read the time as a float32 uniform. Simulation time is UTC milliseconds (about 1.8e12), far past
// float32's 24 bits, so the content clock is the time within the current UTC hour, 0 <= t < 3600 s: float32
// resolves it to under half a millisecond, and night.js's LED hash (fract(p * 123.34) of a lattice point that
// moves 0.11 cells a second) keeps the precision it has on the map, where its clock starts at 0 when the page
// loads. 3600 s is a whole number of the fountain's 80 s loop and of the High Roller's 180 s turn, so those two
// run on across the hour without a jump; the LED skins' drift is not periodic and changes pattern once at the
// top of each simulated hour (a single transition, counted by the flash test).

export const CONTENT_PERIOD_S = 3600;
const PERIOD_MS = CONTENT_PERIOD_S * 1000;

/** Seconds of the screens' content clock at simulation time `simMs` (UTC ms). Pure. */
export function contentSeconds(simMs) {
  if (!Number.isFinite(simMs)) return 0;
  return (((simMs % PERIOD_MS) + PERIOD_MS) % PERIOD_MS) / 1000;
}
