// Viewpoints: each city lists its own in cities.json, in local meters: an eye (above ground, or at a fixed
// elevation, optionally snapped to the nearest summit) and the point it looks at. Each gets a button with a
// picture of the live scene.
import * as THREE from 'three';
import { summit } from './terrain.js';
import { stopMomentum } from '../interaction/cameraLimits.js';

const LENS_HFOV = 39.6; // horizontal field of view of a 50 mm lens on full frame
const THUMB = { w: 176, h: 116 };

export function createViews(app, { near, groundY }) {
  const { city, camera, controls, renderer, scene, canvas, invalidate, base: BASE } = app;
  const VIEWS = {};
  const views = { VIEWS, stale: true, active: null, snap: snapViews, set: setView, resize };
  const viewBar = document.querySelector('.views');
  for (const v of city.views) {
    const e = v.eye.summit ? summit(near, v.eye, v.eye.summit) : v.eye;
    const eyeY = v.eye.elev !== undefined ? v.eye.elev - BASE : groundY(e.x, e.y) + v.eye.agl;
    VIEWS[v.id] = {
      pos: new THREE.Vector3(e.x, eyeY, -e.y),
      target: new THREE.Vector3(v.target.x, groundY(v.target.x, v.target.y) + v.target.agl, -v.target.y),
    };
    const btn = document.createElement('button');
    btn.dataset.view = v.id;
    btn.title = `View: ${v.label}`;
    VIEWS[v.id].thumb = Object.assign(document.createElement('canvas'), { width: THUMB.w, height: THUMB.h });
    btn.append(VIEWS[v.id].thumb, Object.assign(document.createElement('span'), { textContent: v.label }));
    viewBar.append(btn);
  }
  /** Draw each viewpoint's tile from the live scene, so the tiles follow night, the photo and hidden buildings. */
  function snapViews() {
    const pos = camera.position.clone();
    for (const v of Object.values(VIEWS)) {
      camera.position.copy(v.pos);
      camera.lookAt(v.target);
      renderer.render(scene, camera);
      // crop the middle of the frame to the tile's shape
      const w = Math.min(canvas.width, canvas.height * THUMB.w / THUMB.h), h = w * THUMB.h / THUMB.w;
      v.thumb.getContext('2d').drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h, 0, 0, THUMB.w, THUMB.h);
    }
    camera.position.copy(pos);
    camera.lookAt(controls.target);
  }
  function setView(name) {
    views.active = name;
    // the rest of the last drag is dropped, not added to the view
    stopMomentum(controls);
    camera.position.copy(VIEWS[name].pos);
    controls.target.copy(VIEWS[name].target);
    controls.update();
    for (const btn of document.querySelectorAll('.views button')) btn.classList.toggle('active', btn.dataset.view === name);
    invalidate();
  }
  for (const btn of document.querySelectorAll('.views button')) btn.addEventListener('click', () => setView(btn.dataset.view));
  controls.addEventListener('change', () => {
    if (views.active && camera.position.distanceTo(VIEWS[views.active].pos) > 1) {
      views.active = null;
      document.querySelectorAll('.views button').forEach((b) => b.classList.remove('active'));
    }
    // keep the camera out of the ground
    const floor = groundY(camera.position.x, -camera.position.z) + 1.7;
    if (camera.position.y < floor) camera.position.y = floor;
  });

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // hold the horizontal field of view of a 50 mm lens, whatever the window shape
    const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(LENS_HFOV) / 2) / camera.aspect);
    camera.fov = Math.min(THREE.MathUtils.radToDeg(v), 60);
    camera.updateProjectionMatrix();
    invalidate();
  }
  addEventListener('resize', resize);
  return views;
}
