// Dev page: the traffic bodies drawn the way the renderer will draw them, one InstancedMesh (one draw call)
// per body and level, with the paint rule from public/models/drive/vehicles.json:
//   colour = COLOR_0.rgb * mix(1, instanceColor, _paint)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const lod = new URLSearchParams(location.search).get('lod') || 'lod0';
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb3cc);
scene.add(new THREE.HemisphereLight(0xdde8ff, 0x404040, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-30, 50, 20);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x3a3a3a }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

/** Paint only where `_paint` is 1: replaces three's own instance-colour multiply, which would tint everything. */
function paintMaterial(base) {
  const m = base.clone();
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _paint;')
      .replace('#include <color_vertex>', `
        vColor = vec4(1.0);
        #ifdef USE_COLOR_ALPHA
          vColor *= color;
        #elif defined(USE_COLOR)
          vColor.rgb *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, _paint);
        #endif`);
  };
  return m;
}

const sidecar = await (await fetch('/models/drive/vehicles.json')).json();
const gltf = await new GLTFLoader().loadAsync('/models/drive/vehicles.glb');
const palette = sidecar.palette.colors.map((c) => new THREE.Color(`#${c.hex}`));
let x = -26;
let calls = 0;
for (const body of Object.keys(sidecar.bodies)) {
  const src = gltf.scene.getObjectByName(`${body}_${lod}`);
  const spec = sidecar.bodies[body];
  const inst = new THREE.InstancedMesh(src.geometry, paintMaterial(src.material), 3);
  for (let k = 0; k < 3; k++) {
    const m = new THREE.Matrix4().makeRotationY(k === 1 ? Math.PI * 0.85 : Math.PI * 0.2);
    m.setPosition(x, 0, -k * Math.max(8, spec.length + 3));
    inst.setMatrixAt(k, m);
    inst.setColorAt(k, palette[(k * 5 + calls * 3) % palette.length]);
  }
  scene.add(inst);
  calls++;
  x += spec.width + 7;
}
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 1000);
camera.position.set(-6, 14, 30);
camera.lookAt(-6, 1, -12);
renderer.render(scene, camera);
window.__info = { lod, instancedMeshes: calls, drawCalls: renderer.info.render.calls };
window.__ready = true;
