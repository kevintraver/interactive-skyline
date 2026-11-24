// Custom shader code of the screens' light on their surroundings (plan 02, D7.5), as surfaceLight.js terms.
// Listed in the renderer port table (plan 02, "Decisions for the second stretch": every custom shader in a file of
// its own).
//
// sphereTerm: a spherical emitter of mean luminance L (scene emissive units, the content's mean colour x level)
// and radius R lights a surface at distance d (from the centre) with normal n by E = pi L (R / d)^2 cos(theta),
// the exact illuminance of a uniform sphere wholly above the surface's horizon, where theta is the angle between n
// and the direction to the centre. It fades out between 60% and 100% of the range. No shadows (nothing is
// precomputed per facade): a wall turned away from the Sphere gets nothing, one behind another building still does.
//
// glowTerm: up to GLOW_MAX flat emitters (digital billboard faces) of area A, normal m and mean luminance L light a
// point at distance d by E = L A cos(theta_e) cos(theta_r) / (d^2 + A / pi), the far-field formula softened near the
// face so it stays finite (the +A/pi keeps E at most pi L, a face's own luminance, at the face).
//
// createSphereLight and createGlowLight make the terms with their uniforms; light.node.js has the same two for plan
// 01's renderer (in lux there), and the screens and billboards parts pick by ctx.legacy.

import * as THREE from 'three';
import { addSurfaceTerm } from '../lights/surfaceLight.js';

export const GLOW_MAX = 6;

export const SPHERE_HEAD = /* glsl */ `
uniform vec4 uScrSphere;      // centre (scene metres), radius
uniform vec3 uScrSphereL;     // mean luminance, scene units (colour x level), 0 when off
uniform vec4 uScrSphereSpec;  // range (m), on (0/1), unused, unused`;

export const SPHERE_BODY = /* glsl */ `
if ( uScrSphereSpec.y > 0.5 ) {
  vec3 scV = uScrSphere.xyz - slWorld;
  float scD = length( scV );
  if ( scD < uScrSphereSpec.x ) {
    float scR = uScrSphere.w;
    float scDd = max( scD, scR * 1.02 );
    float scCos = clamp( dot( slNormal, scV / max( scD, 1e-3 ) ), 0.0, 1.0 );
    float scFade = 1.0 - smoothstep( 0.6 * uScrSphereSpec.x, uScrSphereSpec.x, scD );
    slE += uScrSphereL * ( 3.14159265 * scR * scR / ( scDd * scDd ) * scCos * scFade );
  }
}`;

export const GLOW_HEAD = /* glsl */ `
uniform vec4 uScrGlowP[${GLOW_MAX}];   // face centre (scene metres), area (m^2)
uniform vec4 uScrGlowN[${GLOW_MAX}];   // face normal (unit), range (m)
uniform vec3 uScrGlowL[${GLOW_MAX}];   // mean luminance (colour x level), 0 when off`;

export const GLOW_BODY = /* glsl */ `
for ( int scI = 0; scI < ${GLOW_MAX}; scI++ ) {
  vec3 scL = uScrGlowL[ scI ];
  if ( scL.r + scL.g + scL.b <= 0.0 ) continue;
  vec3 scV = slWorld - uScrGlowP[ scI ].xyz;
  float scD2 = dot( scV, scV );
  float scRange = uScrGlowN[ scI ].w;
  if ( scD2 > scRange * scRange ) continue;
  float scD = sqrt( scD2 );
  vec3 scU = scV / max( scD, 1e-3 );
  float scCe = max( dot( uScrGlowN[ scI ].xyz, scU ), 0.0 );
  float scCr = max( dot( slNormal, -scU ), 0.0 );
  float scA = uScrGlowP[ scI ].w;
  float scFade = 1.0 - smoothstep( 0.5 * scRange, scRange, scD );
  slE += scL * ( scA * scCe * scCr / ( scD2 + scA / 3.14159265 ) * scFade );
}`;

/**
 * The Sphere's light (sphereTerm above) with its uniforms: { uniforms, display: 'legacy', attach(material) -> detach }.
 * uScrSphereL is the mean luminance in scene units (the content's mean colour x its level).
 * @param {{ range: number }} o  metres from the centre within which the light is drawn
 */
export function createSphereLight({ range }) {
  const uniforms = {
    uScrSphere: { value: new THREE.Vector4(0, 0, 0, 1) },
    uScrSphereL: { value: new THREE.Vector3() },
    uScrSphereSpec: { value: new THREE.Vector4(range, 0, 0, 0) },
  };
  const term = { id: 'screenSphere', key: 'v1', uniforms, head: SPHERE_HEAD, body: SPHERE_BODY };
  return { uniforms, display: 'legacy', attach: (material) => addSurfaceTerm(material, term) };
}

/**
 * The digital faces' glow (glowTerm above) with its uniforms: { uniforms, count, display: 'legacy', attach }. The
 * uniforms' values are arrays of GLOW_MAX vectors (P: centre, area; N: normal, range; L: mean luminance, scene units).
 * @param {{ range: number }} o  metres in front of a face that its glow reaches
 */
export function createGlowLight({ range }) {
  const uniforms = {
    uScrGlowP: { value: Array.from({ length: GLOW_MAX }, () => new THREE.Vector4()) },
    uScrGlowN: { value: Array.from({ length: GLOW_MAX }, () => new THREE.Vector4(0, 0, 1, range)) },
    uScrGlowL: { value: Array.from({ length: GLOW_MAX }, () => new THREE.Vector3()) },
  };
  const term = { id: 'screenGlow', key: 'v1', uniforms, head: GLOW_HEAD, body: GLOW_BODY };
  return { uniforms, count: GLOW_MAX, display: 'legacy', attach: (material) => addSurfaceTerm(material, term) };
}
