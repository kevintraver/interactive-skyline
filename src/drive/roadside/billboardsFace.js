// Custom shader code of the billboard faces (plan 02, D7.4), patched into a MeshLambertMaterial so the faces take
// the scene's lights and fog like everything else. Listed in the renderer port table (every custom shader in a
// file of its own). The schedules and the hash are JavaScript in src/drive/screens/digital.js, art.js and
// roadside/billboardsImages.js; they must agree (tests/unit/screens/programs.test.js and
// tests/unit/roadside/billboards-images.test.js read this text for the constants).
//
// uMode: 0 a plain face (the images are still loading), 1 the generated abstract artwork (the images failed to
// load), 2 the advertisements.
//
// Per instance: aFace = (seed (24 bits), digital (0/1), phase (s), unused); aAd = (base, n, start, step): the
// advertisement of hold k is image base + (start + k * step) mod n (step 0 for a static face); aFit = (sx, sy):
// image uv = (uv - 0.5) * aFit + 0.5, outside 0..1 the letterbox bars in the image's mean colour.
// uAdTable is a float texture of two rows, one texel per image: row 0 its rectangle in the atlas (u0, v0, du, dv),
// row 1 its mean colour (linear).
//
// Light. A static face is printed vinyl: its albedo is the image (times VINYL, as no print reflects all the
// light) under the scene's light by day; at night it is lit from below by its own lamps: emissive = image x
// uStaticLevel x a gradient (brighter at the bottom, where the lamps are). A digital face shows hold k as emissive
// x uDigitalLevel, cross-faded from hold k - 1 over FADE seconds, on a dark, low-reflectance screen surface.

import { ATLAS_COLS, ATLAS_ROWS, CELL_H, CELL_W, DESIGNS } from '../screens/art.js';
import { FADE_S, HOLD_S } from '../screens/digital.js';

/** Share of the light a printed face reflects at a white of the image. */
export const VINYL = 0.82;
/** Linear albedo of a face with nothing on it yet (blank white-grey vinyl). */
export const PLAIN = [0.5, 0.5, 0.48];

const f1 = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

export const FACE_VERTEX_HEAD = /* glsl */ `
attribute vec4 aFace;
attribute vec4 aAd;
attribute vec2 aFit;
varying vec4 vFace;
varying vec4 vAd;
varying vec2 vFit;
varying vec2 vFaceUv;`;

export const FACE_VERTEX_BODY = /* glsl */ `
vFace = aFace;
vAd = aAd;
vFit = aFit;
vFaceUv = uv;`;

export const FACE_FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D uArt;
uniform sampler2D uAds;
uniform highp sampler2D uAdTable;
uniform vec2 uAdTexel;
uniform float uMode;
uniform float uTime;
uniform float uDigitalLevel;
uniform float uStaticLevel;
varying vec4 vFace;
varying vec4 vAd;
varying vec2 vFit;
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
}
int bbImage( int k ) {
  int n = int( vAd.y + 0.5 );
  int i = ( int( vAd.z + 0.5 ) + k * int( vAd.w + 0.5 ) ) % n;
  return int( vAd.x + 0.5 ) + ( i < 0 ? i + n : i );
}
// the image's colour at image uv; the taps stay half a texel inside its rectangle (the gutter around it in the
// atlas repeats its edge for the mipmaps), and the bars outside take its mean colour
vec3 bbAd( int image, vec2 uv ) {
  vec4 rect = texelFetch( uAdTable, ivec2( image, 0 ), 0 );
  vec3 mean = texelFetch( uAdTable, ivec2( image, 1 ), 0 ).rgb;
  vec2 inset = 0.5 * uAdTexel / rect.zw;
  vec3 c = texture2D( uAds, rect.xy + clamp( uv, inset, 1.0 - inset ) * rect.zw ).rgb;
  float inside = step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
  return mix( mean * 0.7, c, inside );
}
vec3 bbShow( int k, uint seed, vec2 adUv ) {
  if ( uMode > 1.5 ) return bbAd( bbImage( k ), adUv );
  if ( uMode > 0.5 ) return vFace.y > 0.5 ? bbArt( bbDesign( seed, k ), vFaceUv ) : bbArt( seed % ${DESIGNS}u, vFaceUv );
  return vec3( ${PLAIN.map(f1).join(', ')} );
}`;

// replaces three's map_fragment: the face's albedo; sets bbEmit for the emissive stage
export const FACE_MAP = /* glsl */ `
uint bbSeed = uint( vFace.x + 0.5 );
vec2 bbAdUv = ( vFaceUv - 0.5 ) * vFit + 0.5;
vec3 bbEmit = vec3( 0.0 );
if ( vFace.y > 0.5 ) {
  float bbU = uTime + vFace.z;
  int bbK = int( floor( bbU / ${f1(HOLD_S)} ) );
  float bbInto = clamp( ( bbU - float( bbK ) * ${f1(HOLD_S)} ) / ${f1(FADE_S)}, 0.0, 1.0 );
  float bbFade = bbInto * bbInto * ( 3.0 - 2.0 * bbInto );
  vec3 bbNow = mix( bbShow( bbK - 1, bbSeed, bbAdUv ), bbShow( bbK, bbSeed, bbAdUv ), bbFade );
  diffuseColor.rgb *= 0.06 * bbNow; // a screen's surface reflects little
  bbEmit = bbNow * uDigitalLevel;
} else {
  vec3 bbNow = bbShow( 0, bbSeed, bbAdUv );
  diffuseColor.rgb *= ${f1(VINYL)} * bbNow;
  bbEmit = bbNow * uStaticLevel * mix( 1.35, 0.65, vFaceUv.y );
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
  material.customProgramCacheKey = () => 'billboard-face-v2';
  return material;
}
