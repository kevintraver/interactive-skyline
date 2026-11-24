// Pure data of the light-sprite layer that the node version (sprites.node.js) needs without importing the GLSL one.
// The values are the GLSL module's (sprites.glsl.js, spriteMirror.js, sprites.js); tests/unit/lights/sprites.node.test.js
// holds the two copies equal until the GLSL path is deleted.

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
