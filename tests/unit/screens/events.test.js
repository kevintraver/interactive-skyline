// The screens part follows hide, move and the height cutoff through the app's edit events (ctx.app.events), with
// one read when it starts and no polling per frame.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createEmitter } from '../../../src/app/events.js';
import { createScreensPart, SPHERE_ID } from '../../../src/drive/screens/index.js';

/** A removable building with an LED skin: a 40 m square face, as the tall entries carry them. */
function tower(id, x = 0) {
  const g = new THREE.BufferGeometry();
  const p = [x, 0, 0, x + 40, 0, 0, x + 40, 40, 0, x, 0, 0, x + 40, 40, 0, x, 40, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('led', new THREE.Float32BufferAttribute(new Array(6).fill(1), 1));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  return { data: { id, name: id }, mesh, offset: new THREE.Vector3() };
}

function make(tall) {
  const events = createEmitter();
  let invalidated = 0;
  const app = { tall, events, invalidate: () => { invalidated++; } };
  const part = createScreensPart({ app, session: null, group: new THREE.Group(), materials: {}, ground: [] });
  const frame = { simMs: 0, dtSimMs: 16, rate: 1, playing: false, camera: { position: new THREE.Vector3(20, 20, 100) } };
  return { part, events, app, frame, invalidated: () => invalidated };
}

describe('screens: the Sphere followed through the edit events', () => {
  it('reads the Sphere once at the start, then only on buildings:changed', () => {
    const sphere = tower(SPHERE_ID);
    const { part, events, frame, invalidated } = make([sphere]);
    expect(part.stats().sphereLight.state).toBe('shown 20.0,20.0,0.0');
    // no event, no change: nothing polls the building per frame
    sphere.mesh.visible = false;
    sphere.offset.set(100, 0, 0);
    for (let i = 0; i < 60; i++) { part.update(frame); part.beforeRender(frame); }
    expect(part.stats().sphereLight.state).toBe('shown 20.0,20.0,0.0');
    events.emit('buildings:changed', {});
    expect(part.stats().sphereLight.state).toBe('hidden 120.0,20.0,0.0');
    expect(part.uniforms.uScrSphere.value.x).toBeCloseTo(120, 6);
    expect(invalidated()).toBe(1);
    sphere.mesh.visible = true;
    events.emit('buildings:changed', {});
    expect(part.stats().sphereLight.state).toBe('shown 120.0,20.0,0.0');
    part.dispose();
    events.emit('buildings:changed', {}); // let go of the bus
    expect(invalidated()).toBe(2);
  });

  it('rescans the removable buildings on buildings:rebuilt (the height cutoff)', () => {
    const { part, events, app } = make([]);
    expect(part.stats().sphereLight.state).toBe('none');
    expect(part.registry.get('sphere')).toBeFalsy();
    app.tall = [tower('other', 500), tower(SPHERE_ID, 1000)];
    events.emit('buildings:rebuilt', {});
    expect(part.registry.get('sphere')).toBeTruthy();
    expect(part.stats().sphereLight.state).toBe('shown 1020.0,20.0,0.0');
    app.tall = [];
    events.emit('buildings:rebuilt', {});
    expect(part.registry.get('sphere')).toBeFalsy();
    expect(part.stats().sphereLight.state).toBe('none');
    part.dispose();
  });
});
