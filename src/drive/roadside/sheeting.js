/**
 * Retroreflective sheeting kinds, as codes for vertex and instance attributes (plan 02, D5.2 and
 * section 7.4). Every reflective element the roadside draws names its sheeting so the headlight
 * work can light it with retro.js's coefficient tables:
 *
 *   road chunks (src/drive/roadnet)   vertex attribute `retro` (Uint8): barrier reflectors 1 white
 *                                     (right side) or 2 yellow (left side), everything else 0
 *   sign faces (index.js)             vertex attributes `retro` (the panel's background sheeting)
 *                                     and `retroLegend` (its legend and border); a texel is legend
 *                                     where the face texture is its legend colour
 *   delineators (delineators.js)      one InstancedMesh per colour, materials 'delineator white' and
 *                                     'delineator yellow', and an instance attribute `retro`
 *
 * Codes: 0 none (not retroreflective: black legend ink, concrete, steel), 1 white, 2 yellow,
 * 3 red, 4 green. Names match RETRO_TYPES in retro.js.
 */
export const SHEETING = Object.freeze({ none: 0, white: 1, yellow: 2, red: 3, green: 4 });
export const SHEETING_NAMES = Object.freeze(['none', 'white', 'yellow', 'red', 'green']);
/** The code of a sheeting name (0 for anything unknown). */
export const sheetingCode = (name) => SHEETING[name] ?? 0;
/** The sheeting of a sign colour: black ink is not retroreflective. */
export const sheetingOfColour = (colour) => (colour === 'black' ? 'none' : colour);
