// Custom shader code of the billboard faces (plan 02, D7.4), patched into a MeshLambertMaterial so the faces take
// the scene's lights and fog like everything else. Listed in the renderer port table (every custom shader in a
// file of its own). The schedule and the hash are src/drive/screens/digital.js and art.js, in JavaScript; the two
// must agree (tests/unit/screens/billboards.test.js reads this text for the constants).
//
// Per instance: aFace = (seed (24 bits), digital (0/1), phase (s), unused). A static face shows atlas design
// seed mod DESIGNS as its albedo and, at night, is lit from below by its own lamps: emissive = art x uStaticLevel x
// a gradient (brighter at the bottom, where the lamps are). A digital face shows frame k = floor((uTime + phase) /
// HOLD) as emissive x uDigitalLevel, cross-faded from frame k - 1 over FADE seconds, on a dark, low-reflectance
// screen surface.

import { ATLAS_COLS, ATLAS_ROWS, CELL_H, CELL_W, DESIGNS } from '../screens/art.js';
import { FADE_S, HOLD_S } from '../screens/digital.js';

const f1 = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

export const FACE_VERTEX_HEAD = /* glsl */ `
attribute vec4 aFace;
varying vec4 vFace;
varying vec2 vFaceUv;`;

export const FACE_VERTEX_BODY = /* glsl */ `
vFace = aFace;
vFaceUv = uv;`;

export const FACE_FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D uArt;
uniform float uTime;
uniform float uDigitalLevel;
uniform float uStaticLevel;
varying vec4 vFace;
varying vec2 vFaceUv;
uint bbHash( uint x ) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
uint bbDesign( uint seed, int k ) { return bbHash( seed ^ ( uint( k ) * 0x9e3779b9u ) ) % ${DESIGNS}u; }
vec3 bbArt( uint design, vec2 uv ) {
  vec2 cell = vec2( float( design % ${ATLAS_COLS}u ), float( design / ${ATLAS_COLS}u ) );
  vec2 inset = vec2( 2.0 / ${f1(CELL_W)}, 2.0 / ${f1(CELL_H)} );
  vec2 p = ( cell + clamp( uv, inset, 1.0 - inset ) ) / vec2( ${f1(ATLAS_COLS)}, ${f1(ATLAS_ROWS)} );
  return texture2D( uArt, p ).rgb;
}`;

// replaces three's map_fragment: the face's albedo; sets bbEmit for the emissive stage
export const FACE_MAP = /* glsl */ `
uint bbSeed = uint( vFace.x + 0.5 );
vec3 bbEmit = vec3( 0.0 );
if ( vFace.y > 0.5 ) {
  float bbU = uTime + vFace.z;
  int bbK = int( floor( bbU / ${f1(HOLD_S)} ) );
  float bbInto = clamp( ( bbU - float( bbK ) * ${f1(HOLD_S)} ) / ${f1(FADE_S)}, 0.0, 1.0 );
  float bbFade = bbInto * bbInto * ( 3.0 - 2.0 * bbInto );
  vec3 bbArtNow = mix( bbArt( bbDesign( bbSeed, bbK - 1 ), vFaceUv ), bbArt( bbDesign( bbSeed, bbK ), vFaceUv ), bbFade );
  diffuseColor.rgb *= 0.06 * bbArtNow; // a screen's surface reflects little
  bbEmit = bbArtNow * uDigitalLevel;
} else {
  vec3 bbArtNow = bbArt( bbSeed % ${DESIGNS}u, vFaceUv );
  diffuseColor.rgb *= bbArtNow;
  bbEmit = bbArtNow * uStaticLevel * mix( 1.35, 0.65, vFaceUv.y );
}`;

export const FACE_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += bbEmit;`;

/** Patch a MeshLambertMaterial into the face material; `uniforms` are shared objects. */
export function faceMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${FACE_VERTEX_HEAD}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>${FACE_VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FACE_FRAGMENT_HEAD}`)
      .replace('#include <map_fragment>', FACE_MAP)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${FACE_EMISSIVE}`);
  };
  material.customProgramCacheKey = () => 'billboard-face-v1';
  return material;
}
