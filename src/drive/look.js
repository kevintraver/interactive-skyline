// Which of the app's two looks the drive shows at a moment. The app has only day and night; the
// drive picks by the sun, so the look is a pure function of simulation time (plan 02, build decisions).

/** The night look once the sun is this many degrees below the horizon. */
export const NIGHT_BELOW = 1.5;

/** @param {number} sunElevation degrees, refracted  @returns {boolean} true for the night look */
export const isNightAt = (sunElevation) => sunElevation < -NIGHT_BELOW;
