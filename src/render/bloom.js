// Bloom (plan 01, section 7.3). Phase 2 first used three's BloomNode (a bright pass, then five mips each blurred by
// two separable Gaussians: twelve passes); on the WebGL2 backend of the reference M4 it cost about 3.5 ms a frame at
// High and 2.3 ms at Low, most of the phase's budget. Section 7.3 names the replacement, used here: the 13-tap
// downsample and 3 x 3 tent upsample chain of Jimenez's Call of Duty talk (SIGGRAPH 2014), five mips, nine small
// passes. Its output is the average of the five blurred levels, a blurred copy of the frame with the same total
// light, which the pipeline mixes in by the bloom strength. Presets change its resolution scale (the size of the
// first mip), not its mip count.
//
// The passes run from the pipeline right after the scene pass (`run`), reading its resolved colour.
import { RenderTarget, QuadMesh, MeshBasicNodeMaterial, HalfFloatType, LinearFilter, Vector2 } from 'three/webgpu';
import { Fn, texture, uniform, uv, vec2, vec4, min, max, vec3 } from 'three/tsl';

const MIPS = 5;

/** 13-tap downsample: a 4x4 box made of five overlapping 2x2 boxes, weighted 0.5 centre, 0.125 each corner. */
function downsampleMaterial(src, texel, clampInput) {
  const m = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  m.fragmentNode = Fn(() => {
    const p = uv(), t = texel;
    const s = (x, y) => {
      const c = texture(src, p.add(vec2(x, y).mul(t))).rgb;
      // the first pass keeps a single blown pixel from flaring the whole halo (and NaN or Inf from passing on)
      return clampInput ? min(max(c, vec3(0)), vec3(65000)) : c;
    };
    const a = s(-2, 2), b = s(0, 2), c = s(2, 2);
    const d = s(-2, 0), e = s(0, 0), f = s(2, 0);
    const g = s(-2, -2), h = s(0, -2), i = s(2, -2);
    const j = s(-1, 1), k = s(1, 1), l = s(-1, -1), mm = s(1, -1);
    const centre = j.add(k).add(l).add(mm).mul(0.5 / 4);
    const corners = a.add(b).add(d).add(e).mul(0.125 / 4)
      .add(b.add(c).add(e).add(f).mul(0.125 / 4))
      .add(d.add(e).add(g).add(h).mul(0.125 / 4))
      .add(e.add(f).add(h).add(i).mul(0.125 / 4));
    return vec4(centre.add(corners), 1);
  })();
  return m;
}

/** 3x3 tent upsample of the smaller level, added to this level. */
function upsampleMaterial(small, here, texel) {
  const m = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  m.fragmentNode = Fn(() => {
    const p = uv(), t = texel;
    const s = (x, y, w) => texture(small, p.add(vec2(x, y).mul(t))).rgb.mul(w);
    const tent = s(-1, 1, 1).add(s(0, 1, 2)).add(s(1, 1, 1))
      .add(s(-1, 0, 2)).add(s(0, 0, 4)).add(s(1, 0, 2))
      .add(s(-1, -1, 1)).add(s(0, -1, 2)).add(s(1, -1, 1)).div(16);
    return vec4(texture(here, p).rgb.add(tent), 1);
  })();
  return m;
}

/**
 * @param {Texture} source  the scene pass's resolved colour texture
 * @param {number} resolutionScale  the first mip's size as a fraction of the frame (0.5 High, 0.25 Low)
 * @returns {{ node, run(renderer), dispose() }}  `node` is the blurred frame, sampled at the screen's uv
 */
export function createBloom(source, resolutionScale = 0.5) {
  const target = () => new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  const down = Array.from({ length: MIPS }, target);
  const up = Array.from({ length: MIPS - 1 }, target);
  const texels = down.map(() => uniform(new Vector2(1, 1)));
  // pass i reads the level above it: the frame for i = 0, down[i - 1] after
  const srcTexel = uniform(new Vector2(1, 1));
  const downQuads = down.map((_, i) => new QuadMesh(downsampleMaterial(i === 0 ? source : down[i - 1].texture, i === 0 ? srcTexel : texels[i - 1], i === 0)));
  // up[i] = down[i] + tent(up[i + 1] or down[last])
  const upQuads = up.map((_, i) => new QuadMesh(upsampleMaterial(i === MIPS - 2 ? down[MIPS - 1].texture : up[i + 1].texture, down[i].texture, texels[i + 1])));
  const size = new Vector2();
  let w = 0, h = 0;

  function resize(renderer) {
    renderer.getDrawingBufferSize(size);
    if (size.x === w && size.y === h) return;
    w = size.x; h = size.y;
    srcTexel.value.set(1 / w, 1 / h);
    let x = Math.max(1, Math.round(w * resolutionScale)), y = Math.max(1, Math.round(h * resolutionScale));
    for (let i = 0; i < MIPS; i++) {
      down[i].setSize(x, y);
      if (i < MIPS - 1) up[i].setSize(x, y);
      texels[i].value.set(1 / x, 1 / y);
      x = Math.max(1, x >> 1); y = Math.max(1, y >> 1);
    }
  }

  return {
    // five levels added together: divide by five for a blurred copy with the frame's total light
    node: vec4(texture(up[0].texture, uv()).rgb.div(MIPS), 1),
    run(renderer) {
      resize(renderer);
      const previous = renderer.getRenderTarget();
      for (let i = 0; i < MIPS; i++) { renderer.setRenderTarget(down[i]); downQuads[i].render(renderer); }
      for (let i = MIPS - 2; i >= 0; i--) { renderer.setRenderTarget(up[i]); upQuads[i].render(renderer); }
      renderer.setRenderTarget(previous);
    },
    dispose() {
      for (const t of [...down, ...up]) t.dispose();
      for (const q of [...downQuads, ...upQuads]) q.material.dispose();
    },
  };
}
