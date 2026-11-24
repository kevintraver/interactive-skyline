// The cabin on plan 01's renderer (plan 02, third stretch): what the quality levels set, the displays' luminance, the sun
// the cabin lets in, the mirror cameras' projection on the new renderer, and the rain on the glass fed exactly as the
// classic renderer feeds it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Texture } from 'three/webgpu';
import { cabinModelForLevel, chooseCabinModel, createDisplayDriver, cabinGlass, REDRAW_MS } from '../../../src/drive/vehicle/cabinCommon.js';
import { glassPresetForLevel, QUALITY_GLASS, mirrorsDue, mirrorPixels, GLASS_PRESETS } from '../../../src/drive/vehicle/glassPresets.js';
import { glassOf, siteLayout } from '../../../src/drive/vehicle/drops.js';
import { displayLuminance, classicDisplay, DISPLAY_CD, sunIntoCabin, CABIN_ORDER } from '../../../src/drive/vehicle/cabin.node.js';
import { glassFrame } from '../../../src/drive/vehicle/veil.js';
import { createMirrors } from '../../../src/drive/vehicle/mirrors.node.js';
import { mirrorView } from '../../../src/drive/vehicle/mirrorGeometry.js';
import { createGlassRain as classicRain } from '../../../src/drive/vehicle/glassRain.js';
import { createGlassRain as nodeRain } from '../../../src/drive/vehicle/glassRain.node.js';
import { createWeather } from '../../../src/drive/env.js';
import { createJourney } from '../../../src/drive/journey.js';
import { fixture } from '../drive/helpers.js';

const meta = JSON.parse(readFileSync(new URL('../../../public/models/drive/cabin.json', import.meta.url), 'utf8'));
const corners = Object.fromEntries(Object.entries(meta.windshield.corners).map(([k, v]) => [k, new THREE.Vector3(...v)]));

describe('quality levels (decision 8)', () => {
  it('pick the model: cabin-low.glb on Low, cabin.glb on High and Ultra', () => {
    expect(cabinModelForLevel('low')).toBe('low');
    expect(cabinModelForLevel('high')).toBe('high');
    expect(cabinModelForLevel('ultra')).toBe('high');
    expect(cabinModelForLevel(undefined)).toBe('high');
    expect(chooseCabinModel({ software: true })).toBe('low'); // the classic renderer's probe is unchanged
  });

  it('set the mirrors and the rain per level, with the numbers the report states', () => {
    expect(glassPresetForLevel('low', 'low')).toBe(GLASS_PRESETS.low);
    expect(glassPresetForLevel('high', 'high')).toBe(GLASS_PRESETS.high);
    expect(glassPresetForLevel(undefined, 'low')).toBe(GLASS_PRESETS.low);
    const glass = glassOf(corners);
    const table = Object.fromEntries(Object.entries(QUALITY_GLASS).map(([level, p]) => [level, {
      center: [...p.mirrors.center.size, p.mirrors.center.every], left: [...p.mirrors.left.size, p.mirrors.left.every],
      right: [...p.mirrors.right.size, p.mirrors.right.every], samples: p.mirrors.samples, sites: siteLayout(glass, p.rain.siteM).count,
    }]));
    expect(table).toEqual({
      low: { center: [256, 72, 4], left: [160, 96, 8], right: [160, 96, 8], samples: 0, sites: 1512 },
      high: { center: [512, 144, 2], left: [320, 192, 4], right: [320, 192, 4], samples: 4, sites: 3403 },
      ultra: { center: [576, 162, 2], left: [384, 230, 4], right: [384, 230, 4], samples: 4, sites: 5304 },
    });
  });

  it('never draw more than one mirror on a playing frame, at any level; all three on a paused one', () => {
    for (const p of Object.values(QUALITY_GLASS)) {
      let pixels = 0;
      for (let f = 0; f < 64; f++) { expect(mirrorsDue(f, p.mirrors).length).toBeLessThanOrEqual(1); pixels += mirrorPixels(f, p.mirrors); }
      expect(mirrorsDue(5, p.mirrors, true)).toEqual(['center', 'left', 'right']);
      expect(pixels / 64).toBeLessThan(100000); // section 9.1's mirror pixels per frame (High 100 k)
    }
  });
});

describe('the displays (decision 6)', () => {
  it('emit DISPLAY_CD by day and dim geometrically toward night; the classic display keeps cabin.js values', () => {
    expect(displayLuminance(0)).toBe(DISPLAY_CD.day);
    expect(displayLuminance(1)).toBeCloseTo(DISPLAY_CD.night, 9);
    expect(displayLuminance(0.5)).toBeCloseTo(Math.sqrt(DISPLAY_CD.day * DISPLAY_CD.night), 9);
    for (let d = 0; d < 1; d += 0.1) expect(displayLuminance(d + 0.1)).toBeLessThan(displayLuminance(d));
    expect(classicDisplay(0)).toBe(1);
    expect(classicDisplay(1)).toBeCloseTo(0.32, 12);
    expect(CABIN_ORDER).toBeLessThan(0);
  });

  it('redraw on a route change, a jump, a units or dusk change, and otherwise at most every REDRAW_MS', () => {
    const f = fixture();
    const journey = createJourney({ route: f.route('test'), road: f.road('test.main'), frame: f.frame, departMs: 0 });
    const drawn = [];
    let look = { dusk: 0 };
    const session = { journey, net: { roadOf: () => null }, locked: false, arrived: false };
    const settings = { units: 'ft' };
    const d = createDisplayDriver({
      session, settings, city: { tz: 'America/Los_Angeles' }, env: null, look: () => look, onDrawn: (w) => drawn.push(w),
      instruments: { draw: () => {} }, screen: { draw: () => {}, setRoute: () => {} },
    });
    const frame = (simMs, playing = true) => ({ simMs, pose: journey.poseAt(simMs), rate: 1, playing });
    d.update(frame(1000));
    expect(drawn).toEqual(['instruments', 'screen']);
    drawn.length = 0;
    d.update(frame(1016)); // 16 ms later, playing: not yet
    expect(drawn).toEqual([]);
    settings.units = 'm';
    d.update(frame(1032));
    expect(drawn).toContain('instruments');
    expect(d.readout.unit).toBe('km/h');
    drawn.length = 0;
    look = { dusk: 0.5 };
    d.update(frame(1048));
    expect(drawn).toEqual(['instruments', 'screen']);
    expect(REDRAW_MS).toBe(100);
  });
});

describe('the sun inside the cabin (shipped look)', () => {
  const { glassOut } = glassFrame(corners);
  const dir = (az, el) => { const r = Math.PI / 180; return new THREE.Vector3(Math.sin(az * r) * Math.cos(el * r), Math.sin(el * r), -Math.cos(az * r) * Math.cos(el * r)); };
  it('comes in through the windshield (raked: from overhead too) and the front side windows, not from behind', () => {
    expect(sunIntoCabin(dir(0, 10), glassOut)).toBeCloseTo(1, 6); // ahead, low: through the windshield
    expect(sunIntoCabin(dir(90, 5), glassOut)).toBeCloseTo(1, 6); // from the right, low: a side window
    expect(sunIntoCabin(dir(-90, 5), glassOut)).toBeCloseTo(1, 6);
    expect(sunIntoCabin(dir(180, 1), glassOut)).toBe(0); // behind, at the horizon (the beige dashboard of the first look)
    expect(sunIntoCabin(dir(150, 10), glassOut)).toBe(0);
    expect(sunIntoCabin(dir(180, 85), glassOut)).toBeGreaterThan(0.9); // nearly overhead: the raked glass faces up
  });
});

describe('the mirror cameras on plan 01\'s renderer', () => {
  it('project in the renderer\'s clip space and depth direction (a WebGL projection kept only the farthest surfaces)', () => {
    const scene = new THREE.Scene();
    const car = new THREE.Group();
    scene.add(car);
    const { mirrors: faces } = cabinGlass(meta, {});
    for (const f of Object.values(faces)) f.mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    const used = [];
    const renderer = {
      coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: true, info: { render: { drawCalls: 0 } },
      getRenderTarget: () => null, setRenderTarget: () => {}, autoClear: true,
      render: (s, cam) => used.push(cam.projectionMatrix.clone()),
    };
    const m = createMirrors({ renderer, scene, session: {}, car, carGroup: car, faces, options: QUALITY_GLASS.high.mirrors, lightsNode: null });
    const head = new THREE.Matrix4().setPosition(...meta.eye);
    m.render({ playing: false, pose: { s: 0 }, simMs: 0, viewport: { height: 720 } }, { head, body: new THREE.Matrix4() });
    expect(used.length).toBe(3);
    const view = mirrorView(new THREE.Vector3(...meta.eye), faces.center);
    const want = new THREE.Matrix4().makePerspective(view.left, view.right, view.top, view.bottom, view.near, view.far, THREE.WebGPUCoordinateSystem, true);
    expect(used[0].elements.map((v) => +v.toFixed(9))).toEqual(want.elements.map((v) => +v.toFixed(9)));
    for (const name of ['center', 'left', 'right']) {
      expect(m.mirrors[name].camera.coordinateSystem).toBe(THREE.WebGPUCoordinateSystem);
      expect(m.mirrors[name].camera.reversedDepth).toBe(true);
    }
    m.dispose();
  });
});

describe('rain on the glass on plan 01\'s renderer', () => {
  it('gets the same values as the classic renderer\'s shaders, frame by frame', () => {
    const f = fixture();
    const journey = createJourney({ route: f.route('test'), road: f.road('test.main'), frame: f.frame, departMs: 0 });
    const session = { journey, locked: false };
    const env = { weather: createWeather() };
    env.weather.setPreset('heavy');
    const pipeline = { scenePass: { getTexture: () => new Texture(), renderTarget: { width: 1, height: 1 } }, addStage: () => () => {} };
    const a = classicRain({ cabinScene: new THREE.Scene(), corners, options: { siteM: 0.02 }, env, session, renderer: null });
    const b = nodeRain({ car: new THREE.Group(), corners, options: { siteM: 0.02 }, env, session, renderer: null, pipeline, occluders: new THREE.Scene(), scene: new THREE.Scene() });
    const ua = a.meshes[0].material.uniforms;
    for (const t of [2000, 9000, 9016, 40000]) {
      const frame = { simMs: t, pose: journey.poseAt(t), rate: 1, playing: true };
      a.update(frame, {});
      b.update(frame, { camera: new THREE.PerspectiveCamera(), L: { body: new THREE.Matrix4() } });
      expect(b.raining).toBe(true);
      expect(JSON.stringify(b.state())).toBe(JSON.stringify(a.state()));
      const node = b.uniforms;
      expect(node.bins.array.map((v) => v.toArray())).toEqual(ua.uBins.value.map((v) => v.toArray()));
      expect(node.q.array).toEqual(ua.uQ.value);
      for (const [k, n] of [['uK0', 'k0'], ['uTw', 'tw'], ['uRenewOffset', 'renewOffset'], ['uComfort', 'comfort'], ['uMistRate', 'mistRate'], ['uHaze', 'haze'], ['uQStep', 'qStep']]) {
        expect(node[n].value, k).toBe(ua[k].value);
      }
      expect(node.wipe.value.toArray()).toEqual(ua.uWipe.value.toArray());
    }
    env.weather.setPreset('clear');
    b.update({ simMs: 50000, pose: journey.poseAt(50000), rate: 1, playing: true }, { camera: new THREE.PerspectiveCamera(), L: { body: new THREE.Matrix4() } });
    expect(b.raining).toBe(false);
    b.dispose();
  });
});
