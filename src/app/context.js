import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadSettings } from './settings.js';
import { DEFAULTS } from './settings.js';
import { createEmitter } from './events.js';
import { createFrameLoop } from '../render/frameLoop.js';
import { startDownloads } from '../city/data.js';
import { createRenderer, onDeviceLost } from '../render/renderer.js';

const CITY_STORE = 'skyline-city';

/** Which city to show: ?city=<id> in the address, else the one used last time. */
function pickCity(cities) {
  let cityId = new URLSearchParams(location.search).get('city');
  if (!cities[cityId]) { try { cityId = localStorage.getItem(CITY_STORE); } catch { /* no storage */ } }
  if (!cities[cityId]) cityId = Object.keys(cities)[0];
  try { localStorage.setItem(CITY_STORE, cityId); } catch { /* no storage */ }
  return cityId;
}

/**
 * The shared application context: city, downloads, settings, renderer, scene, camera, controls, frame loop and
 * event bus. Modules add their own functions to it as they are set up. Asynchronous since phase 2: the renderer
 * chooses its backend and initializes before anything is built (T2.1); the downloads start first.
 */
export async function createApp(cities) {
  const cityId = pickCity(cities);
  const city = cities[cityId];
  document.title = `Interactive Skyline · ${city.name}`;
  const pending = startDownloads(cityId);

  // World units are meters. x = east, y = up, z = south, origin at the city's reference point.
  const base = city.base; // elevation subtracted from everything to keep numbers small
  const settings = { ...DEFAULTS, ...loadSettings() };

  const canvas = document.getElementById('scene');
  const scene = new THREE.Scene();
  const { renderer, kind, backend, reason } = await createRenderer({ canvas, scene });
  if (kind === 'webgpu' && backend === 'webgpu') onDeviceLost(renderer);

  const camera = new THREE.PerspectiveCamera(27, 1, 5, 150000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;
  // Map-style: drag slides the ground, right-drag (or Cmd/Ctrl/Shift-drag) turns and tilts the view.
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.minDistance = 150;
  controls.maxDistance = 30000;

  const loop = createFrameLoop();
  const invalidate = loop.invalidate;
  controls.addEventListener('change', invalidate);

  return { cities, cityId, city, base, pending, settings, canvas, renderer, scene, camera, controls, loop, invalidate,
    rendererKind: kind, backend, backendReason: reason, events: createEmitter() };
}
