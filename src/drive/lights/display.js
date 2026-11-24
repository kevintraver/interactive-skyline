// What multiplies the drive's light besides photometry.node.js's scale (plan 02, third stretch, decision 6). Pure.
//
// On the classic renderer the drive's lights are in LIGHTING_UNITS, fitted to the night look at a fixed exposure, so
// the look fades them in through dusk (`lights` for lamps and obstruction lights, `beams` for the headlamps). The new
// renderer's classic display (?display=classic) holds the exposure at 1 and draws the same units, so it keeps the fade
// and the parity tool compares like with like. In the shipped look the pre-exposure does what the fade stood in for:
// a light is its real candela whenever it is on, and the fade is 1.

/** The photometric display of the page as photometry.node.js reads it: 'classic' or 'physical'. */
export const displayOfSearch = (search) => (new URLSearchParams(search || '').get('display') === 'classic' ? 'classic' : 'physical');

/**
 * @param {{ legacy: boolean, display: 'classic' | 'physical', fade: number }} o  fade: the look's `lights` or `beams`
 * @returns {number}
 */
export const displayFade = ({ legacy, display, fade }) => (legacy || display === 'classic' ? fade : 1);
