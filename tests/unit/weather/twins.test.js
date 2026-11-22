import { describe, it, expect } from 'vitest';
import { twinFresnel, twinRule } from '../../../src/drive/lights/spriteMirror.js';
import { createSpriteLayer, setTwins, TWIN_UNIFORMS } from '../../../src/drive/lights/sprites.js';
import { spriteTwinVertex } from '../../../src/drive/lights/sprites.glsl.js';
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
    // and it is a streak: much longer than wide, longer toward the viewer
    expect(t.extent.down).toBeGreaterThan(4 * t.extent.across);
    expect(t.sDn).toBeGreaterThan(t.sUp);
  });
  it('the shader skips everything at uTwinWet 0, and setTwins hides the twins', () => {
    expect(spriteTwinVertex).toContain('if (!(uTwinWet > 0.0)) return;');
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
