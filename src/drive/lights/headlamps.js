// The visitor's headlamps on the classic renderer's materials (plan 02, D5.1 and D5.2): the beam and retro terms of
// headlamps.glsl.js put on materials through surfaceLight.js, with their textures and uniforms. headlights.js (the part)
// picks this module or headlamps.node.js (plan 01's renderer) by ctx.legacy; both have the same factory and methods:
//
//   const terms = createHeadlampTerms({ ctx, maps, table, ink, chroma, mask, ageing });
//   terms.attach(material, kind, row)   kind null (the beam only), 'road', 'sign' or 'delineator' (row 0 white, 1 yellow);
//                                       returns a remover, or null when nothing was added
//   terms.set({ which, peak, on, lamps, basis })   each frame: the beam ('low' | 'high'), peak candela x gain, on,
//                                       the two lamps' scene positions and the car's { right, up, forward }
//   terms.dispose()
//
// This is the code headlights.js held before the port, moved unchanged: the classic renderer draws the same pixels.

import * as THREE from 'three';
import { addSurfaceTerm } from './surfaceLight.js';
import { HEAD, diffuseBody, RETRO_HEAD, retroBody, retroHeadFor } from './headlamps.glsl.js';
import { MARKING_ROWS } from './headlampMirror.js';

function halfTexture(half, width, height) {
  const t = new THREE.DataTexture(half, width, height, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Varyings for vertex attributes the retro term reads (`retro`, `retroLegend`), chained on the material's hook. */
function addVaryings(material, names) {
  const prev = material.onBeforeCompile;
  const hook = function headlampVaryings(shader, renderer) {
    prev.call(this, shader, renderer);
    if (!shader.fragmentShader.includes('hlRetro(')) return; // the retro term is not on: nothing reads them
    const decl = (kw) => names.map((n) => `${kw === 'attribute' ? `attribute float ${n};\n` : ''}varying float vHl_${n};`).join('\n');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${decl('attribute')}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${names.map((n) => `vHl_${n} = ${n};`).join('\n')}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${decl('varying')}`);
  };
  material.onBeforeCompile = hook;
  material.needsUpdate = true;
  return () => { if (material.onBeforeCompile === hook) { material.onBeforeCompile = prev; material.needsUpdate = true; } };
}

/**
 * @param {{ ctx: object, maps: { low: object, high: object }, table: object, ink: number[][], chroma: number[][],
 *   mask: { data: Uint8Array, width: number, height: number } | null, ageing: { sheeting: number, marking: number },
 *   colour: number[] }} o  maps: headlampMirror.js beamTexture of each beam; table: retroTable(); ink and chroma: per
 *   sheeting code (0 black ... 4 green), linear; mask: the road's marking mask (markingMask.js); colour: the lamps', luminance 1
 */
export function createHeadlampTerms({ ctx, maps, table, ink, chroma, mask, ageing, colour, range }) {
  const units = ctx.env.lighting.units;
  const beamTex = { low: halfTexture(maps.low.half, maps.low.width, maps.low.height), high: halfTexture(maps.high.half, maps.high.width, maps.high.height) };
  const retroTex = halfTexture(table.half, table.width, table.height);
  const spec = new THREE.Vector4(0, 0, units.lux, units.nit), specOff = new THREE.Vector4(0, 0, units.lux, units.nit);
  const shared = {
    uHlBeam: { value: beamTex.low },
    uHlBeamUv: { value: new THREE.Vector4(...maps.low.uv) },
    uHlLamp: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uHlCar: { value: new THREE.Matrix3() },
    // read by three at every draw: off whenever the drive is hidden, so the map's own ground never shows the beam
    uHlSpec: { get value() { return ctx.group.visible ? spec : specOff; } },
    uHlRange: { value: new THREE.Vector4(range.range, 1 / range.fade, 0, 0) },
    uHlColour: { value: new THREE.Vector3(...colour) },
    uHlRetro: { value: retroTex },
    uHlChroma: { value: chroma.map((c) => new THREE.Vector3(...c)) },
    uHlInk: { value: ink.map((c) => new THREE.Vector3(...c)) },
  };

  // the road's marking mask, from its atlas
  let markTex = null;
  if (mask) {
    markTex = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    const src = ctx.materials.map;
    markTex.wrapS = src?.wrapS ?? THREE.ClampToEdgeWrapping;
    markTex.wrapT = src?.wrapT ?? THREE.RepeatWrapping;
    markTex.flipY = false;
    markTex.minFilter = THREE.LinearMipmapLinearFilter;
    markTex.magFilter = THREE.LinearFilter;
    markTex.generateMipmaps = true;
    markTex.anisotropy = src?.anisotropy ?? 1;
    markTex.needsUpdate = true;
  }

  const retroHead = RETRO_HEAD(table);
  const opts = { markingRows: MARKING_ROWS, ageing };
  const basis = new THREE.Matrix3();

  return {
    hasMask: !!markTex,
    attach(material, kind = null, row = 0) {
      const undo = [addSurfaceTerm(material, { id: 'headlights', key: 'v1', uniforms: shared, head: HEAD, body: diffuseBody() })];
      if (!kind || (kind === 'road' && !markTex)) return { undo: () => undo.reverse().forEach((u) => u()), retro: false };
      const uniforms = { ...shared, ...(kind === 'delineator' ? { uHlRow: { value: row } } : {}) };
      if (kind === 'road') uniforms.uHlMark = { value: markTex };
      undo.push(addSurfaceTerm(material, { id: 'retro', key: `${kind}-v1`, uniforms, head: `${retroHead}\n${retroHeadFor(kind)}`, body: retroBody(kind, opts) }));
      if (kind === 'road') undo.push(addVaryings(material, ['retro']));
      if (kind === 'sign') undo.push(addVaryings(material, ['retro', 'retroLegend']));
      return { undo: () => undo.reverse().forEach((u) => u()), retro: true };
    },
    set({ which, peak, on, lamps, basis: b }) {
      shared.uHlBeam.value = beamTex[which];
      shared.uHlBeamUv.value.set(...maps[which].uv);
      spec.x = on ? 1 : 0;
      spec.y = peak;
      if (lamps) {
        shared.uHlLamp.value[0].set(lamps[0][0], lamps[0][1], lamps[0][2]);
        shared.uHlLamp.value[1].set(lamps[1][0], lamps[1][1], lamps[1][2]);
      }
      if (b) {
        const r = b.right, u = b.up, f = b.forward;
        basis.set(r.x, u.x, f.x, r.y, u.y, f.y, r.z, u.z, f.z); // columns: right, up, forward
        shared.uHlCar.value.copy(basis);
      }
    },
    dispose() { for (const t of [beamTex.low, beamTex.high, retroTex, markTex]) t?.dispose(); },
  };
}
