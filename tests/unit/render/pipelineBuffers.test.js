// What the scene pass keeps of its multisampled buffers (src/render/pipeline.js bufferPolicy), and bloom's resolution
// changed in place (src/render/bloom.js setScale). Both came out of plan 03's "blank frame" (24 Nov 2026):
//   - on WebGPU (Chrome on the reference Apple M4) a 2-sample colour attachment whose multisampled data are discarded
//     (three then makes it a transient attachment) resolves to black: Low (MSAA 2x) drew a blank canvas from its first
//     frame, and a drop from High to Low (the fill-rate benchmark under load, or the governor) blanked the app until the
//     level rose again. Storing the colour buffer at 2x draws correctly; 4x discarded draws correctly.
//   - on WebGL2 a bloom disposed and rebuilt in the same level change as the MSAA count left a deleted texture bound
//     and the canvas blank; resizing the bloom's targets in place does not.
import { describe, it, expect } from 'vitest';
import { bufferPolicy } from '../../../src/render/pipeline.js';
import { createBloom } from '../../../src/render/bloom.js';

describe('bufferPolicy', () => {
  const render = { at: 'afterScene', render() {} }, node = { at: 'afterScene', node: () => null }, early = { at: 'beforeScene', render() {} };
  it('no stage: nothing stored or resolved beyond the colour (4x on either backend)', () => {
    for (const webgpu of [true, false]) {
      expect(bufferPolicy({ stages: [], samples: 4, webgpu })).toEqual({ storeMultisampledColorBuffer: false, storeMultisampledDepthBuffer: false,
        storeMultisampledStencilBuffer: false, resolveDepthBuffer: false });
    }
  });
  it('a render stage after the scene keeps every buffer; a node stage resolves the depth', () => {
    expect(bufferPolicy({ stages: [render], samples: 4, webgpu: true })).toEqual({ storeMultisampledColorBuffer: true, storeMultisampledDepthBuffer: true,
      storeMultisampledStencilBuffer: true, resolveDepthBuffer: true });
    expect(bufferPolicy({ stages: [node], samples: 4, webgpu: true }).resolveDepthBuffer).toBe(true);
    expect(bufferPolicy({ stages: [early], samples: 4, webgpu: true }).storeMultisampledColorBuffer).toBe(false);
  });
  it('WebGPU below 4x stores the multisampled colour (a discarded 2x colour attachment resolves to black)', () => {
    const p = bufferPolicy({ stages: [], samples: 2, webgpu: true });
    expect(p.storeMultisampledColorBuffer).toBe(true);
    expect(p.storeMultisampledDepthBuffer).toBe(false); // measured harmless
    expect(bufferPolicy({ stages: [], samples: 2, webgpu: false }).storeMultisampledColorBuffer).toBe(false);
  });
});

describe('bloom.setScale', () => {
  const fakeRenderer = (w, h) => ({
    getDrawingBufferSize(v) { return v.set(w, h); }, getRenderTarget() { return null; }, setRenderTarget() {},
    render() {}, // QuadMesh.render(renderer) -> renderer.render(mesh, camera)
  });
  it('resizes the levels in place on the next run, keeping the same node', () => {
    const bloom = createBloom({ isTexture: true }, 0.5);
    const node = bloom.node;
    bloom.run(fakeRenderer(640, 400));
    expect(bloom.levels[0]).toEqual([320, 200]);
    bloom.setScale(0.25);
    bloom.run(fakeRenderer(640, 400));
    expect(bloom.levels[0]).toEqual([160, 100]);
    expect(bloom.levels[4]).toEqual([10, 6]);
    expect(bloom.node).toBe(node);
    bloom.dispose();
  });
});
