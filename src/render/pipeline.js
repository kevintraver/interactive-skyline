// The render pipeline (plan 01, sections 5.4, 5.7 and 11.8; task T2.4): the scene pass in half float, the stages
// other plans hook into, bloom, tone mapping, and probe() for reading scene-referred light at a pixel.
//
//   scene pass (HDR colour and depth, MSAA)          sceneColor, sceneDepth
//     -> stages afterScene, afterWorld, beforeBloom, afterAA   (node stages, in that order; render stages draw into
//                                                               the scene pass's own targets right after it)
//     -> bloom (BloomNode, mixed in, not added)       bloom
//     -> stage afterBloom
//     -> tone map (ACES, AgX or Neutral) and sRGB
//     -> stage overlay
//
// Stage `beforeScene` render callbacks run before the scene pass. The classic renderer (?renderer=legacy) has no
// pipeline: createPipeline() returns a stand-in whose render() is renderer.render(scene, camera).
import { RenderPipeline, RenderTarget, QuadMesh, MeshBasicNodeMaterial, FloatType, RGBAFormat, NearestFilter, NodeUpdateType,
  NoToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, SRGBColorSpace } from 'three/webgpu';
import { pass, uniform, vec2, vec4, float, texture, mix, renderOutput, saturation, luminance } from 'three/tsl';
import { createBloom } from './bloom.js';

export const TONE_MAPPINGS = { aces: ACESFilmicToneMapping, agx: AgXToneMapping, neutral: NeutralToneMapping };
const ORDER = ['afterScene', 'afterWorld', 'beforeBloom', 'afterAA', 'afterBloom', 'overlay'];
/** Rec. 709 luminance of linear RGB (the working space) */
export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The classic renderer's stand-in: no post, the renderer draws the scene as it always has. */
function legacyPipeline({ renderer, scene, camera }) {
  let cam = camera;
  return {
    legacy: true,
    render() { renderer.render(scene, cam); },
    setCamera(c) { cam = c; },
    addStage() { return () => {}; },
    configure() {},
    get settings() { return { toneMapping: 'aces', bloom: 0, contrast: 0, saturation: 0 }; },
    sceneColor: null, sceneDepth: null, bloom: null,
    probe() { return Promise.reject(new Error('probe() needs the new renderer (the classic one has no HDR target)')); },
  };
}

/**
 * @param {{ renderer, scene, camera, legacy?: boolean, exposure?: { value: number } }} o
 *   `exposure`: the pre-exposure uniform (env.nodes.exposure, section 7.2) that probe() divides out.
 */
export function createPipeline({ renderer, scene, camera, legacy = false, exposure = { value: 1 } }) {
  if (legacy) return legacyPipeline({ renderer, scene, camera });
  const scenePass = pass(scene, camera);
  // once per pipeline.render(), not once per animation frame (the default): the view tiles, probe(), capture() and the
  // performance hook draw the scene several times within one animation frame, from different cameras. Checked on
  // every render call (RENDER), run only when the token moved: bloom's own passes sample the scene pass too, and a
  // plain RENDER update would draw the scene again for each of them
  scenePass.updateBeforeType = NodeUpdateType.RENDER;
  const token = { value: 0 };
  const sceneColor = scenePass.getTextureNode('output');
  const sceneDepth = scenePass.getTextureNode('depth');
  const stages = [];
  const settings = { toneMapping: 'aces', bloom: 0, contrast: 0, saturation: 0, bloomScale: 0.5 };
  const bloomStrength = uniform(0), contrast = uniform(0), sat = uniform(0);
  const output = new RenderPipeline(renderer);
  output.outputColorTransform = false; // tone mapping and sRGB happen in the graph, so `overlay` can follow them
  let bloom = null;

  // render callbacks of the stages after the scene pass draw into its own colour and depth, right after it
  const drawScene = scenePass.updateBefore.bind(scenePass);
  let drawnToken = -1;
  scenePass.updateBefore = (frame) => {
    if (drawnToken === token.value) return undefined;
    drawnToken = token.value;
    for (const s of stages) if (s.at === 'beforeScene' && s.render) s.render(renderer, frame, null);
    const result = drawScene(frame);
    const late = stages.filter((s) => s.render && s.at !== 'beforeScene' && s.at !== 'overlay');
    if (late.length) {
      const target = renderer.getRenderTarget(), autoClear = renderer.autoClear;
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.autoClear = false;
      for (const s of late) s.render(renderer, frame, scenePass.renderTarget);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(target);
    }
    return result;
  };

  function build() {
    let color = sceneColor;
    const inputs = () => ({ color, depth: sceneDepth, bloom: bloom ? bloom.node : vec4(0) });
    const nodeStages = (at) => { for (const s of stages) if (s.at === at && s.node) color = s.node(inputs()); };
    nodeStages('afterScene');
    nodeStages('afterWorld');
    nodeStages('beforeBloom');
    nodeStages('afterAA');
    if (settings.bloom > 0) {
      if (!bloom) bloom = createBloom(color, settings.bloomScale, token);
      else bloom.setInput(color);
      // mixed in, not added: a share of each pixel's light moves into the halo, so light is conserved
      color = vec4(mix(color.rgb, bloom.node.rgb, bloomStrength), color.a);
    } else if (bloom) { bloom.dispose(); bloom = null; }
    nodeStages('afterBloom');
    // a mild contrast and saturation lift after tone mapping keeps daylight from looking flat under AgX (7.3)
    let display = renderOutput(color, TONE_MAPPINGS[settings.toneMapping], SRGBColorSpace);
    if (settings.contrast || settings.saturation) {
      const rgb = saturation(display.rgb, sat.add(1));
      const c = rgb.sub(0.5).mul(contrast.add(1)).add(0.5);
      display = vec4(c.clamp(0, 1), display.a);
    }
    for (const s of stages) if (s.at === 'overlay' && s.node) display = s.node({ ...inputs(), color: display });
    output.outputNode = display;
    output.needsUpdate = true;
  }
  build();

  // probe(): copy one pixel of the scene pass into a float target, read it back, divide out the exposure
  const probeTarget = new RenderTarget(1, 1, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  const probeUv = uniform(vec2(0.5, 0.5));
  const probeMaterial = new MeshBasicNodeMaterial();
  probeMaterial.fragmentNode = vec4(texture(scenePass.getTexture('output'), probeUv).rgb, float(1));
  const probeQuad = new QuadMesh(probeMaterial);

  const pipeline = {
    legacy: false,
    /** Draw one frame of the current view. */
    render() {
      token.value++;
      renderer.toneMapping = NoToneMapping; // the graph tone-maps; the renderer must not do it again
      output.render();
      renderer.toneMapping = TONE_MAPPINGS[settings.toneMapping];
    },
    /** The active view: shadows, atmosphere and exposure follow it. */
    setCamera(c) { scenePass.camera = c; output.needsUpdate = true; },
    /**
     * Add work to the frame (section 11.8): { id, at, render?(renderer, frame, target), node?({ color, depth, bloom }) }.
     * Returns a function that removes it.
     */
    addStage(stage) {
      if (!['beforeScene', ...ORDER].includes(stage.at)) throw new Error(`unknown stage slot ${stage.at}`);
      stages.push(stage);
      build();
      return () => { const i = stages.indexOf(stage); if (i >= 0) { stages.splice(i, 1); build(); } };
    },
    /** Change the display: { toneMapping: 'aces' | 'agx' | 'neutral', bloom: 0..1, contrast, saturation }. */
    configure(o) {
      const rebuild = (o.toneMapping && o.toneMapping !== settings.toneMapping) || (o.bloom !== undefined && (o.bloom > 0) !== (settings.bloom > 0))
        || (o.contrast !== undefined && !!o.contrast !== !!settings.contrast) || (o.saturation !== undefined && !!o.saturation !== !!settings.saturation)
        || (o.bloomScale !== undefined && o.bloomScale !== settings.bloomScale);
      if (o.bloomScale !== undefined && bloom) { bloom.dispose(); bloom = null; }
      Object.assign(settings, o);
      bloomStrength.value = settings.bloom;
      contrast.value = settings.contrast;
      sat.value = settings.saturation;
      if (rebuild) build();
    },
    get settings() { return { ...settings }; },
    sceneColor, sceneDepth,
    get bloom() { return bloom ? bloom.node : null; },
    /** The scene pass node, for stages that need its targets. */
    scenePass,
    /**
     * The scene-referred light at a point of the screen (NDC, -1..1), before exposure: { luminanceCdM2, rgb }. Draws
     * a frame first, then copies the pixel to a float target and reads it back.
     */
    async probe(ndcX, ndcY) {
      pipeline.render();
      probeUv.value.set((ndcX + 1) / 2, (ndcY + 1) / 2);
      const target = renderer.getRenderTarget();
      renderer.setRenderTarget(probeTarget);
      probeQuad.render(renderer);
      renderer.setRenderTarget(target);
      const px = await renderer.readRenderTargetPixelsAsync(probeTarget, 0, 0, 1, 1);
      const k = 1 / (exposure.value || 1);
      const rgb = [px[0] * k, px[1] * k, px[2] * k];
      return { luminanceCdM2: lum(...rgb), rgb };
    },
    dispose() { output.dispose(); if (bloom) bloom.dispose(); probeTarget.dispose(); probeMaterial.dispose(); },
  };
  void luminance;
  return pipeline;
}
