// GLSL of the wet road (plan 02, D8.1): one surface term (lights/surfaceLight.js) on the road and ground materials,
// added last so it sees every other term's light. Mirror: wetMirror.js wetFragment (tests/unit/weather/wet.test.js).
// To be ported with the renderer (plan 02, port table).
//
// Per fragment: the water's cover (wetness, and on the road the wheel paths' wear read from the atlas coordinate),
// faded out on anything steeper than about 30 degrees from level (walls, barriers, their reflectors). Then
//   three's diffuse light and the other terms' irradiance x k, k = 1 - cover x (1 - wet/dry diffuse ratio)
//   the other terms' irradiance x (1 - cover x F(view)) as well: light arriving at grazing angles (the visitor's own
//       headlamps, whose lamps are beside the eye, so their incidence is the view's) mostly glances off the film
//       forward and does not come back; a street lamp's pool goes the same way into its reflected twin (sprites)
//   the other terms' radiance (the markings' retroreflection) x (1 - cover x (1 - WET_RETRO))
//   plus the sky near the horizon mirrored by the film: sky x cover x gloss x F(view)
// With uWet.x (the wetness) at 0 the block is skipped: the term adds exactly nothing.

/** Declarations: uniforms and Fresnel. */
export const WET_HEAD = /* glsl */ `
uniform vec4 uWet;        // x wetness 0..1, y wet/dry diffuse ratio, z marking retro kept wet, w gloss
uniform vec3 uWetSky;     // radiance of the sky near the horizon (scene units)
uniform vec4 uWetLanes;   // the atlas' lane regions in u: lane [x, y), right-hand lane [z, w)
uniform vec4 uWetPath;    // wheel paths' centres across a lane region (x, y), their sigma (z); w: unused
uniform vec2 uWetDirt;    // the atlas' dirt region in u: [x, y) gets the ground's gloss
float wetFresnel( float c ) {
  c = clamp( c, 0.0, 1.0 );
  float st = sqrt( max( 0.0, 1.0 - c * c ) ) / 1.333;
  float ct = sqrt( max( 0.0, 1.0 - st * st ) );
  float rs = ( c - 1.333 * ct ) / ( c + 1.333 * ct );
  float rp = ( ct - 1.333 * c ) / ( ct + 1.333 * c );
  return 0.5 * ( rs * rs + rp * rp );
}
float wetGauss( float t, float m, float s ) { float u = ( t - m ) / s; return exp( -0.5 * u * u ); }`;

/** The term's body. kind 'road' reads the atlas coordinate for the wheel paths; 'ground' has none. */
export function wetBody(kind) {
  const road = kind === 'road';
  return /* glsl */ `
if ( uWet.x > 0.0 ) {
  float path = 0.0;
  float gloss = uWet.w;
  ${road ? `#ifdef USE_MAP
  {
    float u = vMapUv.x, t = -1.0;
    if ( u >= uWetLanes.x && u < uWetLanes.y ) t = ( u - uWetLanes.x ) / ( uWetLanes.y - uWetLanes.x );
    else if ( u >= uWetLanes.z && u < uWetLanes.w ) t = ( u - uWetLanes.z ) / ( uWetLanes.w - uWetLanes.z );
    if ( t >= 0.0 ) path = max( wetGauss( t, uWetPath.x, uWetPath.z ), wetGauss( t, uWetPath.y, uWetPath.z ) );
    if ( u >= uWetDirt.x && u < uWetDirt.y ) gloss = ${(0.15).toFixed(2)};
  }
  #endif` : ''}
  float cover = clamp( uWet.x * ( 1.0 + path ), 0.0, 1.0 ) * smoothstep( 0.5, 0.9, slNormal.y );
  float F = wetFresnel( dot( slNormal, slView ) );
  float k = 1.0 - cover * ( 1.0 - uWet.y );
  reflectedLight.directDiffuse *= k;
  reflectedLight.indirectDiffuse *= k;
  slE *= k * ( 1.0 - cover * F );
  slL *= 1.0 - cover * ( 1.0 - uWet.z );
  slL += uWetSky * ( cover * gloss * F );
}`;
}
