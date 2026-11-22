// GLSL of the visitor's headlamps (plan 02, D5.1 and D5.2): the beam as a surface term on the drive's materials, and
// the retroreflected return of signs, markings, delineators and barrier reflectors. Every line here has a JavaScript
// mirror in headlampMirror.js, tested against beam.js and retro.js (tests/unit/lights/headlamps.test.js). A port to
// another renderer reproduces these functions; the uniforms are set by headlights.js once a frame.
//
// Terms (surfaceLight.js): `headlights` (HEAD, diffuseBody) on every lit material; `retro` (RETRO_HEAD and a
// retroBody variant) after it on the reflective ones. Inputs from surfaceLight: slWorld, slNormal, slView, slAlbedo;
// outputs slE (irradiance, scene units) and slL (radiance, scene units).
//
// Frames. World positions are scene metres. The beam map is indexed in the car frame of beam.js (x right, y up,
// z forward): uHlCar holds the car's right, up and forward as columns, so `d * uHlCar` is the car-frame vector.

/**
 * The retroreflected return's soft shoulder, in displayed cd/m^2 (after ageing): below `knee` the return is as
 * computed; above it the brighter of a body's two rows (a sign's legend, a marking's white) is compressed toward
 * `ceiling`, and both rows are scaled by the same factor, so the hue and the legend's contrast with its field stay.
 * Today's fixed exposure (env.js lighting.units.nit, ACES) shows a green field nearly white above about 10 cd/m^2:
 * under the high beam a guide sign 150 m ahead returns about 390 cd/m^2 from its legend and 39 from its field, which
 * would burn the whole face to white. The low beam's legends (under 30 cd/m^2 at 60 to 300 m) are below the knee.
 * STAND-IN for plan 01's exposure, like the units. Mirrors: retroShoulder (hlShoulder).
 */
export const RETRO_SHOULDER = Object.freeze({ knee: 30, ceiling: 60 });

/** Shared by both terms: the beam map and the lamps. Mirrors: beamCandela (hlCandela). */
export const HEAD = /* glsl */ `
uniform sampler2D uHlBeam;    // I / peak, h along u, v along v; rows from vMin up (beam.json's grid)
uniform vec4 uHlBeamUv;       // uv = (h * x + y, v * z + w): degrees to texel-centred uv
uniform vec3 uHlLamp[2];      // lamp positions (scene)
uniform mat3 uHlCar;          // columns: the car's right, up, forward
uniform vec4 uHlSpec;         // x on (0 or 1), y peak candela x gain, z scene per lux, w scene per cd/m^2
uniform vec4 uHlRange;        // x range of the diffuse term (m), y 1 / fade length (m)
uniform vec3 uHlColour;       // the lamps' colour, luminance 1

// candela toward d (lamp to point, scene), over the peak: one texture fetch
float hlCandela( vec3 d ) {
  vec3 c = d * uHlCar;
  float h = degrees( atan( c.x, c.z ) );
  if ( abs( h ) > 90.0 ) return 0.0;
  float v = degrees( atan( c.y, length( c.xz ) ) );
  return texture( uHlBeam, vec2( h * uHlBeamUv.x + uHlBeamUv.y, v * uHlBeamUv.z + uHlBeamUv.w ) ).r;
}`;

/** The beam on a Lambert surface: E = I cos(i) / d^2. Mirrors: headlampIrradiance. */
export const diffuseBody = () => /* glsl */ `
if ( uHlSpec.x > 0.5 ) {
  for ( int i = 0; i < 2; i++ ) {
    vec3 d = slWorld - uHlLamp[ i ];
    float d2 = dot( d, d );
    float dist = sqrt( d2 );
    float cosi = -dot( slNormal, d ) / max( dist, 1e-3 );
    float fade = clamp( ( uHlRange.x - dist ) * uHlRange.y, 0.0, 1.0 );
    if ( cosi > 0.0 && fade > 0.0 ) {
      slE += uHlColour * ( hlCandela( d ) * uHlSpec.y * uHlSpec.z * cosi * fade / max( d2, 0.25 ) );
    }
  }
}`;

/**
 * Retroreflection: the table of coefficients (rows of the RETRO_ROWS types, alpha across, beta down in the
 * piecewise nodes of retro.js's sheeting tables) and the return of both lamps for two rows at once (a sign's
 * background and legend, or the white and yellow lines of a marking), sharing the geometry and the beam fetch.
 * Mirrors: retroTableLookup (hlRetroCoef), retroReturn (hlRetro).
 */
export const RETRO_HEAD = ({ width, rowsPerType, height, alphaMax, betaNodes }) => /* glsl */ `
uniform sampler2D uHlRetro;   // coefficient table (R_A cd/lx/m^2 for sheeting, R_L cd/m^2/lx for markings)
uniform vec3 uHlChroma[5];    // colour of each sheeting code at luminance 1 (0: black ink)
uniform vec3 uHlInk[5];       // albedo of each sheeting code as the sign atlas draws it (for the legend share)

float hlBetaRow( float b ) {
  ${betaNodes.slice(1).map((n, i) => `if ( b < ${n.toFixed(1)} ) return ${i.toFixed(1)} + ( b - ${betaNodes[i].toFixed(1)} ) / ${(n - betaNodes[i]).toFixed(1)};`).join('\n  ')}
  return ${(betaNodes.length - 1).toFixed(1)};
}
float hlRetroCoef( float row, float alphaDeg, float betaDeg ) {
  float x = clamp( alphaDeg / ${alphaMax.toFixed(2)}, 0.0, 1.0 ) * ${(width - 1).toFixed(1)} + 0.5;
  float y = row * ${rowsPerType.toFixed(1)} + hlBetaRow( betaDeg ) + 0.5;
  return texture( uHlRetro, vec2( x / ${width.toFixed(1)}, y / ${height.toFixed(1)} ) ).r;
}
// luminance (cd/m^2) returned toward the eye by two coefficient rows; marking > 0.5: R_L (no 1 / cos nu)
vec2 hlRetro( vec3 p, vec3 n, vec3 toEye, vec2 rows, float marking ) {
  vec2 l = vec2( 0.0 );
  float cosNu = dot( n, toEye );
  if ( uHlSpec.x < 0.5 || cosNu <= 0.0 ) return l;
  for ( int i = 0; i < 2; i++ ) {
    vec3 tl = uHlLamp[ i ] - p;
    float dl2 = dot( tl, tl );
    vec3 ul = tl * inversesqrt( dl2 );
    float cosB = dot( n, ul );
    if ( cosB <= 0.0 ) continue;
    float alpha = degrees( 2.0 * asin( min( 1.0, 0.5 * length( ul - toEye ) ) ) );
    float beta = degrees( acos( min( cosB, 1.0 ) ) );
    float e = hlCandela( -tl ) * uHlSpec.y / dl2;
    l += e * vec2( hlRetroCoef( rows.x, alpha, beta ), hlRetroCoef( rows.y, alpha, beta ) );
  }
  return marking > 0.5 ? l : l / max( cosNu, 0.05 );
}
// the soft shoulder (RETRO_SHOULDER): both rows scaled by one factor, from the brighter
vec2 hlShoulder( vec2 l ) {
  float m = max( l.x, l.y );
  if ( m <= ${RETRO_SHOULDER.knee.toFixed(1)} ) return l;
  float x = m - ${RETRO_SHOULDER.knee.toFixed(1)};
  return l * ( ( ${RETRO_SHOULDER.knee.toFixed(1)} + x / ( 1.0 + x / ${(RETRO_SHOULDER.ceiling - RETRO_SHOULDER.knee).toFixed(1)} ) ) / m );
}`;

/**
 * The retro term's body for a kind of surface.
 *  'road'        markings by the mask (uHlMark, read at the road atlas' uv: r white paint, g yellow paint), barrier
 *                reflectors by the vertex attribute `retro` (vHl_retro)
 *  'sign'        background `retro` and legend `retroLegend` sheeting, the legend's share from the texel's colour
 *  'delineator'  one sheeting for the whole material (uHlRow)
 * Each body passes its two rows through hlShoulder after ageing. Mirrors: retroSurface, retroShoulder.
 */
export function retroBody(kind, { markingRows, ageing }) {
  const out = (expr) => `slL += ( ${expr} ) * uHlSpec.w;`;
  if (kind === 'road') {
    return /* glsl */ `
#ifdef USE_MAP
{
  float code = floor( vHl_retro + 0.5 );
  if ( code > 0.5 ) {
    vec2 l = hlShoulder( hlRetro( slWorld, slNormal, slView, vec2( code - 1.0 ), 0.0 ) * ${ageing.sheeting.toFixed(3)} );
    ${out('uHlChroma[ int( code ) ] * l.x')}
  } else {
    vec2 m = texture( uHlMark, vMapUv ).rg;
    if ( m.r + m.g > 0.002 ) {
      vec2 l = hlShoulder( hlRetro( slWorld, slNormal, slView, vec2( ${markingRows[0].toFixed(1)}, ${markingRows[1].toFixed(1)} ), 1.0 ) * ${ageing.marking.toFixed(3)} );
      ${out('vec3( m.r * l.x ) + uHlChroma[ 2 ] * ( m.g * l.y )')}
    }
  }
}
#endif`;
  }
  if (kind === 'sign') {
    return /* glsl */ `
{
  float bg = floor( vHl_retro + 0.5 ), lg = floor( vHl_retroLegend + 0.5 );
  if ( bg + lg > 0.5 ) {
    int ib = int( bg ), il = int( lg );
    vec3 cb = uHlInk[ ib ], cl = uHlInk[ il ], dc = cl - cb;
    float w = clamp( dot( slAlbedo - cb, dc ) / max( dot( dc, dc ), 1e-4 ), 0.0, 1.0 );
    vec3 ref = mix( cb, cl, w );
    float lumRef = dot( ref, vec3( 0.2126, 0.7152, 0.0722 ) );
    float ink = clamp( dot( slAlbedo, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( lumRef, 1e-3 ), 0.0, 1.0 );
    vec2 l = hlRetro( slWorld, slNormal, slView, vec2( max( bg - 1.0, 0.0 ), max( lg - 1.0, 0.0 ) ), 0.0 ) * ${ageing.sheeting.toFixed(3)};
    l = hlShoulder( l * vec2( step( 0.5, bg ), step( 0.5, lg ) ) );
    ${out('mix( uHlChroma[ ib ] * l.x, uHlChroma[ il ] * l.y, w ) * ink')}
  }
}`;
  }
  if (kind === 'delineator') {
    return /* glsl */ `
{
  vec2 l = hlShoulder( hlRetro( slWorld, slNormal, slView, vec2( uHlRow ), 0.0 ) * ${ageing.sheeting.toFixed(3)} );
  ${out('uHlChroma[ int( uHlRow ) + 1 ] * l.x')}
}`;
  }
  throw new Error(`headlamps: no retro body for "${kind}"`);
}

/** Extra declarations a kind needs in the fragment shader (beyond RETRO_HEAD). */
export const retroHeadFor = (kind) => ({
  road: 'uniform sampler2D uHlMark;',
  sign: '',
  delineator: 'uniform float uHlRow;',
}[kind]);
