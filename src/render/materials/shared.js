// Uniforms every material of the new renderer shares (plan 01, T2.2 to T2.11). Each is a TSL uniform node whose
// `.value` is also what the classic renderer's GLSL reads (src/render/legacy/materials.js), so the app sets one
// value and both renderers follow.
import { Color } from 'three';
import { uniform } from 'three/tsl';

/** 0 by day, 1 at night: the legacy look's night switch (T1.4's ramp in the clock state). */
export const night = uniform(0).setName('uNight');
/** Seconds into the show loops (fountain, LED skins); attractions.js drives it. */
export const clock = uniform(0).setName('uClock');
/** The legacy haze colour: the fog, the dome's horizon, and the sky that facade glass reflects by day. */
export const haze = uniform(new Color(0xd3dee8)).setName('uHaze');

// ------------------------------------------------------------------ photometry (T2.5, section 7.2)
/** Pre-exposure: everything that emits or reflects light is multiplied by this before it is written. */
export const exposure = uniform(1).setName('uExposure');
/** 1 when materials emit in physical units (the shipped look), 0 for the classic look (?display=classic). */
export const physical = uniform(1).setName('uPhysical');
/** The lights-out slider, 0..1 (phase 4); every artificial light is multiplied by it. */
export const cityFactor = uniform(1).setName('uCityFactor');
/** Switch-on state of the city's lights, 0..1, from dusk and the hour of night (env.state.lights). */
export const switchOn = {
  windows: uniform(0).setName('uSwitchWindows'),
  street: uniform(0).setName('uSwitchStreet'),
  signs: uniform(0).setName('uSwitchSigns'),
};
/**
 * The interim legacy surfaces (the dome, the fountain, the Sun and Moon discs, the street glow) keep their classic
 * display colours until phases 3 and 4; in the physical look they are scaled by this, the reciprocal of the
 * exposure table's value for the current solar altitude, so they keep their classic relation to the scene.
 */
export const legacyScale = uniform(1).setName('uLegacyScale');
