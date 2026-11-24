// The `valley` part on plan 01's renderer (parts.js picks it when ctx.legacy is false): valley.node.js with the light's
// scale and display of the page. In the shipped look the ribbons write scene light (cd/m^2 x the pre-exposure x the
// lights-out slider) and follow the vehicles' lit share; at ?display=classic they keep the classic tone and fade and
// hand the output pass the scene value it shows as the classic one (classicDisplay.node.js), for the parity tool.
// Detail follows plan 01's quality level (valleyCore.js VALLEY_CLASSES).
import { createValleyPart as createNodeValley } from './valley.node.js';
import { photometryContext, artificialScale } from '../lights/photometry.node.js';
import { toScene } from './classicDisplay.node.js';

/** @param {object} ctx the part context (parts.js) */
export function createValleyPart(ctx) {
  const photometry = photometryContext({ nodes: ctx.env.nodes });
  const classic = photometry.display === 'classic';
  return createNodeValley(ctx, {
    lightScale: artificialScale(photometry),
    tone: classic ? 'sprite' : 'scene',
    toScene,
    quality: ctx.app?.plan01?.quality ?? null,
  });
}
