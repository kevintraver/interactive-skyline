// three's BloomNode behind one module of ours (plan 01, R8: the TSL addons move between releases; each is wrapped
// once). Used with threshold 0, strength 1 and radius 0, so its output is the five blurred mips weighted 1.0, 0.8,
// 0.6, 0.4 and 0.2 (BloomNode's fixed factors); divided by their sum it is a blurred copy of the frame with the same
// total light, which the pipeline mixes in by the bloom strength (section 7.3). Presets change its resolution
// scale, not its mip count.
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { nodeObject } from 'three/tsl';
import { NodeUpdateType } from 'three/webgpu';

const WEIGHTS = 1.0 + 0.8 + 0.6 + 0.4 + 0.2;

export function createBloom(input, resolutionScale = 0.5, token = null) {
  const node = new BloomNode(nodeObject(input), 1, 0, 0);
  node.setResolutionScale(resolutionScale);
  // with the scene pass: once per pipeline.render() (`token`, pipeline.js), not once per animation frame
  if (token) {
    node.updateBeforeType = NodeUpdateType.RENDER;
    const run = node.updateBefore.bind(node);
    let done = -1;
    node.updateBefore = (frame) => { if (done === token.value) return; done = token.value; run(frame); };
  }
  return {
    node: node.div(WEIGHTS),
    bloomNode: node,
    setInput(color) { node.inputNode = nodeObject(color); },
    dispose() { node.dispose(); },
  };
}
