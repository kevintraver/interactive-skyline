// A quality level change resizes the sun's shadow map (plan 01, T2.7). On WebGPURenderer the light's ShadowNode owns
// that render target (shadow.map is the node's own target) and resizes it from shadow.mapSize when it next draws.
// Disposing it from outside left the node and the materials' bind groups on a destroyed depth texture: every later
// submit failed validation ("Destroyed texture [ShadowDepthTexture] used in a submit") and the canvas stayed blank
// for the rest of the visit (found as Fly's blank frame, plan 03: the fill-rate benchmark or the governor dropped
// High to Low, 4096 to 2048, while a test or a visitor was entering Fly; reproduced on the map alone).
import { describe, it, expect, vi } from 'vitest';
import { resizeShadowMap, createShadowSizer } from '../../../src/render/setupQuality.js';

function sunWithMap(size) {
  const map = { dispose: vi.fn(), width: size, height: size };
  return { shadow: { mapSize: { x: size, y: size, set(a, b) { this.x = a; this.y = b; } }, map, needsUpdate: false }, map };
}

describe('resizeShadowMap', () => {
  it('sets the new size and asks for a redraw, and leaves the shadow node its own target', () => {
    const { shadow, map } = sunWithMap(4096);
    const renderer = { shadowMap: { needsUpdate: false } };
    resizeShadowMap(renderer, { shadow }, 2048);
    expect(shadow.mapSize.x).toBe(2048);
    expect(shadow.mapSize.y).toBe(2048);
    expect(renderer.shadowMap.needsUpdate).toBe(true);
    // the target is the shadow node's: it resizes it itself (ShadowNode.renderShadow -> shadowMap.setSize)
    expect(map.dispose).not.toHaveBeenCalled();
    expect(shadow.map).toBe(map);
  });
  it('does nothing when the size is unchanged', () => {
    const { shadow, map } = sunWithMap(2048);
    const renderer = { shadowMap: { needsUpdate: false } };
    expect(resizeShadowMap(renderer, { shadow }, 2048)).toBe(false);
    expect(renderer.shadowMap.needsUpdate).toBe(false);
    expect(map.dispose).not.toHaveBeenCalled();
  });
});

// Resizing it later, in the frame the pipeline rebuilds for a new MSAA count, still left a destroyed depth texture
// bound inside three (WebGPU: "Destroyed texture [ShadowDepthTexture] used in a submit" on Low -> High; WebGL2:
// "bindTexture: attempt to use a deleted object" on High -> Low), so the size is the start-up level's for the visit.
describe('createShadowSizer', () => {
  it('sizes the map for the first level applied and keeps it through later level changes', () => {
    const { shadow } = sunWithMap(1024);
    shadow.map = null;
    const renderer = { shadowMap: { needsUpdate: false } };
    const size = createShadowSizer(renderer, { shadow });
    size(4096);
    expect(shadow.mapSize.x).toBe(4096);
    renderer.shadowMap.needsUpdate = false;
    size(2048);
    expect(shadow.mapSize.x).toBe(4096);
    expect(renderer.shadowMap.needsUpdate).toBe(false);
  });
});
