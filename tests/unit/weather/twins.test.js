import { describe, it, expect } from 'vitest';
import { twinFresnel, twinRule } from '../../../src/drive/lights/spriteMirror.js';
import { createSpriteLayer, setTwins, TWIN_UNIFORMS } from '../../../src/drive/lights/sprites.js';
import { spriteTwinVertex, spriteTwinFragment } from '../../../src/drive/lights/sprites.glsl.js';
import { meanCover, facetSlope, GLOSS } from '../../../src/drive/weather/wetMirror.js';
import { LAMP_CD } from '../../../src/drive/traffic/lamps.js';

const pixelAngle = (2 * Math.tan((50 * Math.PI) / 360)) / 720;

/** Sum the drawn twin over its quad, pixel by pixel, back to lux at the eye. */
function summed(t, gain) {
  let sum = 0;
  const ex = Math.ceil(t.extent.across), up = Math.ceil(t.extent.up), dn = Math.ceil(t.extent.down);
  for (let u = -ex; u <= ex; u += 0.25) for (let v = -dn; v <= up; v += 0.25) sum += t.profile(u, v) * 0.0625;
  return (sum * pixelAngle * pixelAngle) / gain;
}

describe('Fresnel reflectance of water', () => {
  it('is about 2% head on and rises to 1 at grazing', () => {
    expect(twinFresnel(1)).toBeCloseTo(0.0204, 3);
    expect(twinFresnel(0)).toBeCloseTo(1, 6);
    expect(twinFresnel(0.05)).toBeGreaterThan(twinFresnel(0.3));
  });
});

describe('reflected twins (D8.1)', () => {
  const gain = 0.1;
  const eye = [0, 1.2, 0];
  const tail = [0, 0.8, -40]; // a tail lamp 40 m ahead
  it('dry: no twin', () => {
    expect(twinRule({ lamp: tail, eye, roadY: 0, intensityCd: LAMP_CD.tail, wet: meanCover(0), slope: facetSlope(0), pixelAngle, gain })).toBeNull();
  });
  it('fully wet: a tail lamp 40 m ahead has a streak summing to within 2x of a mirror at the Fresnel reflectance', () => {
    const t = twinRule({ lamp: tail, eye, roadY: 0, intensityCd: LAMP_CD.tail, wet: meanCover(1) * GLOSS.twin, slope: facetSlope(1), pixelAngle, gain });
    const dm = Math.hypot(40, 2);
    const mirror = (twinFresnel(2 / dm) * LAMP_CD.tail) / (dm * dm);
    const s = summed(t, gain);
    expect(s / mirror).toBeGreaterThan(0.5);
    expect(s / mirror).toBeLessThan(2);
    expect(s / mirror).toBeGreaterThan(0.6); // the film's gloss (0.7) of it, less the edge
    // and it is a streak: much longer than wide
    expect(t.extent.up + t.extent.down).toBeGreaterThan(4 * t.extent.across);
  });
  it('a streak that starts at the foot of its lamp and runs toward the viewer, thin and long, its light kept', () => {
    // pixels below the horizon of a road point at horizontal distance x, from the eye 1.2 m up
    const below = (x) => Math.atan(1.2 / x) / pixelAngle;
    for (const [lamp, cd] of [[tail, LAMP_CD.tail], [[3, 0.7, -25], LAMP_CD.head], [[-8, 12, -140], 20000], [[6, 10, -90], 15000]]) {
      const t = twinRule({ lamp, eye, roadY: 0, intensityCd: cd, wet: meanCover(1) * GLOSS.twin, slope: facetSlope(1), pixelAngle, gain });
      const D = Math.hypot(lamp[0], lamp[2]), R = Math.hypot(t.r[0], t.r[2]);
      // its top is the road under the lamp (B) as seen from the eye, its peak the mirror point R below it
      expect(Math.abs(below(R) - t.extent.up - below(D))).toBeLessThan(1);
      expect(t.profile(0, t.extent.up + 0.01)).toBe(0);
      expect(t.profile(0, 0.6 * t.extent.up)).toBeGreaterThan(0.5 * t.profile(0, 0)); // lit along the way up to B
      expect(t.profile(0, -0.5)).toBeLessThan(t.profile(0, 0));
      // toward the viewer, past R
      expect(t.extent.down).toBeGreaterThan(t.extent.across);
      // thin and long
      expect(t.extent.up + t.extent.down).toBeGreaterThan(4 * t.extent.across);
      // the summed light is the mirror's (E) to within the sampling
      expect(summed(t, gain) / t.E).toBeGreaterThan(0.97);
      expect(summed(t, gain) / t.E).toBeLessThan(1.03);
    }
  });
  it('the shader skips everything at uTwinWet 0, and setTwins hides the twins', () => {
    expect(spriteTwinVertex).toContain('if (!(uTwinWet > 0.0)) return;');
    expect(spriteTwinVertex).toContain('float twinErf(');
    expect(spriteTwinFragment).toContain('vTwSig.y'); // the run up to the lamp's foot
    const layer = createSpriteLayer({ capacity: 8, reflect: true });
    const plain = createSpriteLayer({ capacity: 8 });
    expect(plain.twins).toBeNull();
    setTwins({ wet: 0.8, car: { x: 0, z: 0 }, forward: { x: 0, z: -1 }, roadY: 0, grade: 0 });
    expect(layer.twins.mesh.visible).toBe(true);
    setTwins({ wet: 0 });
    expect(TWIN_UNIFORMS.uTwinWet.value).toBe(0);
    expect(layer.twins.mesh.visible).toBe(false);
    expect(layer.twins.listed).toBe(0);
    layer.dispose(); plain.dispose();
  });
  it('lists the instances near the car for a layer rewritten each frame', () => {
    const layer = createSpriteLayer({ capacity: 4, reflect: true });
    layer.set(0, { position: [0, 1, -50], intensity: 6 });
    layer.set(1, { position: [0, 1, -5000], intensity: 6 });
    setTwins({ wet: 1, car: { x: 0, z: 0 }, forward: { x: 0, z: -1 } });
    layer.commitRows(2);
    expect(layer.twins.listed).toBe(1);
    setTwins({ wet: 0 });
    layer.dispose();
  });
});
