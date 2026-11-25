// The car's inside as the interior mirror shows it (plan 02, D4.3), for the mirror passes (mirrors.js).

import * as THREE from 'three';

/**
 * The car's inside as the interior mirror sees it (cabin coordinates, metres; assumed proportions of a crossover
 * of cabin.json's body: 1.85 m wide, roof at 1.66, rear at 2.2): the rear window's opening in a frame (C-pillars,
 * headliner, parcel shelf), the headliner over the rear seats, and the two outboard rear headrests. `material(params)`
 * makes each material from MeshStandardMaterial parameters (mirrors.js: a node material).
 */
export function buildInterior(material = (p) => new THREE.MeshStandardMaterial(p)) {
  const g = new THREE.Group();
  g.name = 'mirror-interior';
  const cx = 0.37; // the car's centre line
  const trim = material({ color: new THREE.Color(0.055, 0.055, 0.058), roughness: 0.9, side: THREE.DoubleSide });
  const liner = material({ color: new THREE.Color(0.2, 0.19, 0.18), roughness: 0.95, side: THREE.DoubleSide });
  const seat = material({ color: new THREE.Color(0.04, 0.04, 0.042), roughness: 0.85 });
  // the rear window's frame: a plane across the back with the opening cut out, raked (top forward)
  const W = 0.56, bottom = 0.98, top = 1.47;
  const frame = new THREE.Shape();
  frame.moveTo(-1.2, -0.4); frame.lineTo(1.2, -0.4); frame.lineTo(1.2, 1.0); frame.lineTo(-1.2, 1.0); frame.closePath();
  const hole = new THREE.Path();
  const hb = bottom - 1.2, ht = top - 1.2, r = 0.06;
  hole.moveTo(-W + r, hb); hole.lineTo(W - r, hb); hole.quadraticCurveTo(W, hb, W - 0.01, hb + r);
  hole.lineTo(W - 0.05, ht - r); hole.quadraticCurveTo(W - 0.06, ht, W - 0.06 - r, ht);
  hole.lineTo(-W + 0.06 + r, ht); hole.quadraticCurveTo(-W + 0.06, ht, -W + 0.05, ht - r);
  hole.lineTo(-W + 0.01, hb + r); hole.quadraticCurveTo(-W, hb, -W + r, hb);
  frame.holes.push(hole);
  const back = new THREE.Mesh(new THREE.ShapeGeometry(frame, 6), trim);
  back.position.set(cx, 1.2, 2.0);
  back.rotation.x = -0.35; // raked: the top leans forward
  g.add(back);
  // the headliner from the front seats to the rear window
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.0), liner);
  roof.rotation.x = Math.PI / 2;
  roof.position.set(cx, 1.58, 1.0);
  g.add(roof);
  // the outboard rear headrests (the centre one sits lower, below the mirror's view)
  for (const dx of [-0.4, 0.4]) {
    // a pill: rounded top and sides, 0.26 m wide and 0.16 m tall
    const hr = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.1, 6, 12), seat);
    hr.rotation.z = Math.PI / 2;
    hr.scale.set(1, 1, 0.55);
    hr.position.set(cx + dx, 1.13, 1.18);
    g.add(hr);
    const back2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.12), seat);
    back2.position.set(cx + dx * 1.05, 0.83, 1.3);
    back2.rotation.x = -0.25;
    g.add(back2);
  }
  return g;
}
