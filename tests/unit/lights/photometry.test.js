// photometry.js: the scale from the drive's physical units to buffer units, its nodes and their CPU twins, held to
// plan 01's env.nodes (src/env/nodes.js).
import { describe, it, expect } from 'vitest';
import {
  photometryContext, lightScale, artificialScale, luminance, illuminanceToRadiance, pointSource, illuminanceAt,
  lightScaleCpu, artificialScaleCpu, luminanceCpu, illuminanceToRadianceCpu, pointSourceCpu, illuminanceAtCpu,
} from '../../../src/drive/lights/photometry.js';
import { createEnvNodes, pointSourceCpu as envPointSourceCpu, emissiveCpu } from '../../../src/env/nodes.js';

const env = createEnvNodes(null);

describe('the context', () => {
  it('takes plan 01\'s shared nodes by default', () => {
    const c = photometryContext({});
    expect(c.nodes.exposure).toBe(env.exposure); // the one shared uniform
    expect(c.nodes.cityFactor).toBe(env.cityFactor);
    expect(photometryContext(c)).toBe(c);
  });
});

describe('the nodes', () => {
  it('lightScale is env.nodes.exposure, the pre-exposure', () => {
    expect(lightScale({ nodes: env })).toBe(env.exposure);
    const own = { exposure: { isNode: true, mul: () => 'x' }, cityFactor: {} };
    expect(lightScale({ nodes: own })).toBe(own.exposure);
  });
  it('builds nodes for every helper', () => {
    for (const n of [artificialScale({}), luminance(300, {}), illuminanceToRadiance(0.3, 20, {}), illuminanceAt(1000, 30),
      pointSource(1000, { distance: 30, pixelSr: 1e-6 }, {}).color]) expect(n.isNode).toBe(true);
  });
});

describe('the CPU twins', () => {
  it('scale by the exposure and by cityFactor', () => {
    expect(lightScaleCpu({ exposure: 7 })).toBe(7);
    expect(artificialScaleCpu({ exposure: 2, cityFactor: 0.5 })).toBe(1);
    expect(luminanceCpu(300, { exposure: 1e-3, cityFactor: 0.5 })).toBeCloseTo(emissiveCpu(300, { exposure: 1e-3, cityFactor: 0.5, artificial: true }), 12);
  });
  it('albedo x lux / pi', () => {
    expect(illuminanceToRadianceCpu(0.3, 20, { exposure: 0.1 })).toBeCloseTo((0.3 * 20 * 0.1) / Math.PI, 12);
    expect(illuminanceToRadianceCpu([0.5, 0.25, 1], Math.PI, { exposure: 2 })).toEqual([1, 0.5, 2]);
  });
  it('the point source agrees with plan 01\'s pointSource (flux conserved whatever the size)', () => {
    for (const [I, d, sr, size] of [[1000, 30, 1e-6, 1], [5e4, 2000, 4e-7, 3], [10, 5, 2e-6, 1.5]]) {
      const o = { exposure: 3e-3, cityFactor: 0.7 };
      const mine = pointSourceCpu(I, { distance: d, pixelSr: sr, sizePx: size }, o);
      const theirs = envPointSourceCpu(I, d, sr, { minPixels: size, exposure: 3e-3, cityFactor: 0.7, artificial: true });
      expect(mine.color).toBeCloseTo(theirs.color, 9);
      // the summed light: luminance x pixels x pixel solid angle is I / d^2, whatever the size
      expect(mine.luminance * Math.max(1, size) ** 2 * sr).toBeCloseTo(illuminanceAtCpu(I, d), 12);
    }
  });
});
