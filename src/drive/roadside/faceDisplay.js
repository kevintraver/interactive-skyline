// How bright a billboard's face may be drawn (plan 02, third stretch). Pure: numbers in, numbers out.
//
// A digital face is 300 cd/m2 at night and a floodlit one about 100, beside a road of 1 to 2 cd/m2. An eye looking at
// the board adapts to it and reads the advertisement; a frame has one exposure, set for the road, and the app's tone
// mapping (AgX) holds about 4 stops above mid-grey, so the face's white lands past it and the picture washes to white.
// So the face's white level is drawn no higher than FACE_DISPLAY.max in the frame's own units (the pre-exposed
// buffer, where mid-grey is 0.18): unchanged up to `knee`, then easing to `max`. The limit is on the white level, not
// on each pixel, so the picture keeps its contrast. By day a face's white is about 0.2 and nothing changes. What the
// board is (its luminance in the registry, the light it throws) is not touched: only how its own face is drawn.
export const FACE_DISPLAY = Object.freeze({ knee: 0.6, max: 1.4 });

/**
 * The drawn white level of a face for its pre-exposed white level `x` (buffer units).
 * @param {number} x
 * @returns {number}
 */
export function faceDisplay(x, { knee, max } = FACE_DISPLAY) {
  if (!(x > knee)) return Math.max(x, 0);
  const span = max - knee;
  return knee + span * (1 - Math.exp(-(x - knee) / span));
}
