// Pure data of the light-sprite layer (sprites.js) and its mirror (spriteMirror.js). No shader, no three.js.

/** Instances per row of the instance textures. */
export const SPRITE_TEX_WIDTH = 1024;
/** Patterns a layer can define (id 0 is the isotropic one). */
export const MAX_PATTERNS = 16;
/** Entries of the switch-on table (switching.js ON_TABLE.n). */
export const ON_TABLE_N = 37;
/** Pattern kinds of the sprite shader. */
export const PATTERN = Object.freeze({ isotropic: 0, cutoff: 1, droplens: 2, highmast: 3, lobe: 4 });
/** Share of a twin's peak left at the lamp's foot (the streak brightens from there to the mirror point). */
export const TWIN_FOOT = 0.5;
/** Twins are listed for instances within this distance of the car (m), horizontally. */
export const TWIN_LIST_M = 420;
/** A written-once layer's twin list is rebuilt when the car has moved this far (m). */
export const TWIN_RELIST_M = 20;

/**
 * The angular size of a pixel at angle t off the camera's axis, as the sprite rule must use it: a pixel there subtends
 * pa^2 cos^3(t) on a flat image plane, so the rule takes pa cos^1.5(t) (cosOff = cos t). With it a sprite carries I / d^2
 * anywhere on the screen; with pa alone it lost cos^3 of its light off axis (29 % at the edge of a 54-degree view).
 */
export const pixelAngleOffAxis = (pa, cosOff) => pa * Math.max(cosOff, 1e-3) ** 1.5;
