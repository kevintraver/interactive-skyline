// The headlight stand-in's glow on plan 01's renderer (plan 02, third stretch, decision 6). The road, the signs and the
// delineators glow at night in classic scene units (LIGHTING_UNITS: 0.1 of a unit per cd/m2 at the classic fixed
// exposure). In the shipped look that glow is a luminance in cd/m2 times the pre-exposure (env.nodes.exposure); at the
// classic display (?display=classic, exposure held at 1) it is the classic value unchanged, so parity holds. The
// stand-in goes when the headlights part is ported (materials' setHeadlights).
import { materialEmissive, mix, float } from 'three/tsl';
import { exposure, physical } from '../../render/materials/shared.js';
import { LIGHTING_UNITS } from '../env.js';

let shared = null;

/**
 * The material's own emissive (colour x map x intensity), in classic units, as the frame needs it. One node for every
 * material: what differs between them (colour, map, intensity) is read per material, so they share one build.
 */
export const standInEmissive = () => (shared ||= materialEmissive.mul(mix(float(1), exposure.div(LIGHTING_UNITS.nit), physical)));
