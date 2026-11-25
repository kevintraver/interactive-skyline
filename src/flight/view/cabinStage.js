// The cabin as its own late stage (plan 03, section 7.6; F3.9): the cabin is drawn after the world's anti-aliasing and
// composed over it, so it is sharp, does not reach the world's exposure meter or bloom's source, and the window glass
// reads the finished outside picture with mips instead of copying the frame half way through the scene pass.
//
// One stage, `flight-cabin` at plan 01's `afterBloom` (section 7.6 names afterAA; see "Bloom" below). Its node, updated once per pipeline render (as the drive's rain
// layer, src/drive/vehicle/glassRain.js), does in order:
//   1. the scene pass (a no-op when it has run this render)
//   2. outside: the stage's input colour (world, airframe, everything composed before it, resolved) copied into
//      a half-float target with a mip chain; the pane samples it at screenUV and any level (outside(uv, level))
//   3. the cabin: the cabin's own scene (view/layers.js cabinScene) through the cabin camera (the app camera's pose
//      and lens, 2 cm to 6 m, its own depth) into a 4x multisampled half-float target of its own, cleared to
//      transparent. The pane is part of it (window/index.js, the last transparent object).
// The composite is "over" with the cabin's alpha: a resolved 4x edge is a partial alpha, so the cabin's edges are
// smoothed against the finished outside. Where the cabin pass drew nothing (the clean view, the window opening without
// glass) the outside shows as it is. Nothing is drawn and nothing is sampled while the cabin is not shown.
//
// Light is in buffer units throughout: the input is pre-exposed, the cabin's materials emit through env.nodes.emissive
// (pre-exposed). Exposure and tone mapping follow the stage.
//
// Bloom. Plan 01's bloom blurs the scene pass's colour, which holds the world behind the cabin at full brightness (the
// cabin is not in it): composed at afterAA, the hidden world's blur came through the wall as a ghost (sunlit ground at
// 9,200 cd/m^2 behind a 386 cd/m^2 wall at bloom 0.06, measured by day on lv-19-day). Composed after the bloom, the
// outside keeps its own glow and the cabin gets none. The window's glow onto the frame (7.6: "a bright window blooms
// onto the frame as in a photograph") needs the bloom to read the composed picture: not built.

import { RenderTarget, QuadMesh, MeshBasicNodeMaterial, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Node, NodeUpdateType, FloatType, NearestFilter, RGBAFormat } from 'three/webgpu';
import { Fn, If, texture, screenUV, uniform, vec2, vec4, float } from 'three/tsl';
import { Vector2, Color } from 'three';

/** The cabin target's multisampling (7.6: the cabin brings its own edge smoothing, a 4x target). */
export const CABIN_SAMPLES = 4;

/** Runs `draw(frame)` once per render of the graph it is in, and stands for `layer` sampled at the screen. */
class CabinLayerNode extends Node {
  constructor(draw, layer) {
    super('vec4');
    this.draw = draw;
    this.layer = layer;
    this.updateBeforeType = NodeUpdateType.RENDER;
  }
  updateBefore(frame) { this.draw(frame); }
  setup() { return texture(this.layer, screenUV); }
}

/**
 * @param {{ renderer: object, pipeline: object, layers: ReturnType<import('./layers.js').createFlightLayers> }} o
 */
export function createCabinStage({ renderer, pipeline, layers }) {
  const outsideTarget = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter });
  outsideTarget.texture.name = 'flight-outside';
  const cabinTarget = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true, samples: CABIN_SAMPLES, generateMipmaps: false });
  cabinTarget.texture.name = 'flight-cabin';
  // 4x with the multisampled data discarded: kept in tile memory on the reference M4 (2x discarded drew black there,
  // src/render/pipeline.js bufferPolicy; 4x is measured good)
  Object.assign(cabinTarget, { storeMultisampledColorBuffer: false, storeMultisampledDepthBuffer: false, storeMultisampledStencilBuffer: false, resolveDepthBuffer: false });
  const outsideTex = texture(outsideTarget.texture);
  const copy = new QuadMesh(new MeshBasicNodeMaterial({ name: 'flight-outside-copy', depthTest: false, depthWrite: false }));
  const on = uniform(0);
  const size = new Vector2();
  const clear = new Color();
  let shown = false, staged = null, drawn = 0, lastMs = 0, cpuMs = 0, cpuN = 0;
  let inputColor = null, outsideUsed = () => true, copies = 0;

  /** The frame's work (see the header): runs inside the pipeline's render, before the composite reads. */
  function draw(frame) {
    if (!shown) return;
    const t0 = performance.now();
    pipeline.scenePass.updateBefore(frame);
    const rt = pipeline.scenePass.renderTarget;
    size.set(rt.width, rt.height);
    if (outsideTarget.width !== size.x || outsideTarget.height !== size.y) { outsideTarget.setSize(size.x, size.y); cabinTarget.setSize(size.x, size.y); }
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear, alpha = renderer.getClearAlpha();
    renderer.getClearColor(clear);
    try {
      // the outside picture only while something reads it (the glass shown)
      if (outsideUsed()) { renderer.setRenderTarget(outsideTarget); copy.render(renderer); copies++; }
      renderer.setRenderTarget(cabinTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.render(layers.cabinScene, layers.cabinCamera());
    } finally {
      renderer.setRenderTarget(prev);
      renderer.setClearColor(clear, alpha);
      renderer.autoClear = auto;
    }
    drawn++;
    const ms = performance.now() - t0;
    lastMs = ms; cpuMs += ms; cpuN++;
  }

  const layerNode = new CabinLayerNode(draw, cabinTarget.texture);
  const composite = ({ color }) => {
    if (inputColor !== color) {
      inputColor = color;
      copy.material.fragmentNode = vec4(color.rgb, float(1));
      copy.material.needsUpdate = true;
    }
    return Fn(() => {
      const c = vec4(color).toVar();
      If(on.greaterThan(0.5), () => {
        const k = layerNode;
        c.assign(vec4(k.rgb.add(c.rgb.mul(float(1).sub(k.a))), c.a));
      });
      return c;
    })();
  };
  const stage = { id: 'flight-cabin', at: 'afterBloom', node: composite };

  // probe(): the composed cabin's light at a point (NDC), before exposure, as pipeline.probe() does for the scene
  const probeTarget = new RenderTarget(1, 1, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  const probeUv = uniform(new Vector2(0.5, 0.5));
  const probeMat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  probeMat.fragmentNode = Fn(() => texture(cabinTarget.texture, probeUv))();
  const probeQuad = new QuadMesh(probeMat);

  const api = {
    stage,
    /** The finished outside picture with mips, for the pane: (uv, level) => colour node (buffer units). */
    outside: (uv, level) => outsideTex.sample(uv).level(level),
    outsideTexture: outsideTarget.texture,
    cabinTexture: cabinTarget.texture,
    get shown() { return shown; },
    get staged() { return !!staged; },
    /** Register the stage (Fly shown) or remove it (left; Map puts its graph back). */
    setStaged(v) {
      if (v && !staged && pipeline?.addStage && !pipeline.legacy) staged = pipeline.addStage(stage);
      else if (!v && staged) { staged(); staged = null; }
      return api;
    },
    /** Who reads the outside picture: `fn()` true while it must be made (the pane shown). Default: always. */
    useOutside(fn) { outsideUsed = typeof fn === 'function' ? fn : () => true; return api; },
    /** Each frame before drawing: whether the cabin pass runs (attached, a cabin, not the clean view). */
    setShown(v) { shown = !!v && !!staged; on.value = shown ? 1 : 0; return api; },
    /**
     * The cabin's light at a point of the screen (NDC, -1..1), before exposure: { rgb, alpha, luminanceCdM2 }, from the
     * last drawn cabin layer (premultiplied: rgb is what the cabin adds there). Draws a frame first.
     */
    async probe(ndcX, ndcY, exposure = 1) {
      pipeline.render();
      if (!shown) return { rgb: [0, 0, 0], alpha: 0, luminanceCdM2: 0 }; // not composed: the layer holds an old frame
      probeUv.value.set((ndcX + 1) / 2, (ndcY + 1) / 2); // as pipeline.probe()
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(probeTarget);
      probeQuad.render(renderer);
      renderer.setRenderTarget(prev);
      const px = await renderer.readRenderTargetPixelsAsync(probeTarget, 0, 0, 1, 1);
      const k = 1 / (exposure || 1);
      const rgb = [px[0] * k, px[1] * k, px[2] * k];
      return { rgb, alpha: px[3], luminanceCdM2: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] };
    },
    stats: () => ({ staged: !!staged, shown, drawn, outsideCopies: copies, samples: CABIN_SAMPLES, size: [outsideTarget.width, outsideTarget.height],
      cpuMs: cpuN ? +(cpuMs / cpuN).toFixed(3) : 0, lastMs: +lastMs.toFixed(3) }),
    dispose() {
      api.setStaged(false);
      outsideTarget.dispose(); cabinTarget.dispose(); probeTarget.dispose();
      copy.material.dispose(); probeMat.dispose();
    },
  };
  return api;
}
