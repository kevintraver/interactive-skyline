// The corridor's windows (src/drive/corridor/material.js and mesher.js windowShare): the app's lit-window shader
// with a share per wall, none on canopies, sheds, blank or low walls, fewer lit in warehouses and stores.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { corridorMaterial, patchCorridorShader } from '../../../src/drive/corridor/material.js';
import { meshCell, groundUnder, windowShare, WINDOW_MIN_M } from '../../../src/drive/corridor/mesher.js';
import { encodeCell, decodeCell, TYPE } from '../../../src/drive/corridor/format.js';

const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

function mesh(buildings) {
  const buf = encodeCell({ origin: [0, 0], buildings });
  const { groundMin, groundMean } = groundUnder(decodeCell(buf), () => 700);
  return meshCell({ buf, groundMin, groundMean, base: 620, earthR: 7.4e6 });
}
/** winLit of the wall vertices (normal level) of a mesh. */
const walls = (m) => Array.from(m.winLit).filter((_, k) => Math.abs(m.normals[3 * k + 1]) < 0.5);

describe('corridor windows', () => {
  it('extends the night shader it is given, and refuses one it does not recognise', () => {
    const mat = corridorMaterial();
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    mat.onBeforeCompile(shader);
    expect(shader.vertexShader).toContain('attribute float winLit;');
    expect(shader.vertexShader).toContain('vWinLit = winLit;');
    expect(shader.fragmentShader).toContain('vWinLit > 0.0 && facadeFacing()');
    expect(shader.fragmentShader).toContain('* vWinLit;');
    expect(shader.uniforms.uNight).toBeTruthy();
    expect(mat.customProgramCacheKey()).not.toBe('night-v5');
    expect(() => patchCorridorShader({ vertexShader: '#include <common>', fragmentShader: '' })).toThrow(/night shader/);
  });

  it('gives no windows to canopies, sheds or low walls, and fewer lit to warehouses and stores than hotels', () => {
    expect(windowShare('canopy', 6, 6, 400, 0.99)).toBe(0);
    expect(windowShare('shed', 4, 4, 30, 0.99)).toBe(0);
    expect(windowShare('house', 2.5, 2.5, 100, 0.99)).toBe(0);
    expect(windowShare('hotel', 30, WINDOW_MIN_M - 0.1, 3000, 0.99)).toBe(0);
    expect(windowShare('warehouse', 10, 10, 5000, 0.99)).toBeLessThan(windowShare('hotel', 10, 10, 5000, 0.99) / 4);
    expect(windowShare('retail', 8, 8, 5000, 0.99)).toBeLessThan(windowShare('apartments', 8, 8, 5000, 0.99) / 2);
    // an untyped big box is lit like a store; an untyped small building like any other
    expect(windowShare('other', 8, 8, 9000, 0.99)).toBe(windowShare('retail', 8, 8, 9000, 0.99));
    expect(windowShare('other', 8, 8, 400, 0.99)).toBeGreaterThan(windowShare('retail', 8, 8, 400, 0.99));
  });

  it('leaves a share of warehouse walls blank, by a hash of the wall', () => {
    const blank = (t) => { let n = 0; for (let i = 0; i < 1000; i++) n += windowShare(t, 10, 10, 5000, (i + 0.5) / 1000) === 0; return n / 1000; };
    expect(blank('warehouse')).toBeGreaterThan(0.6);
    expect(blank('hotel')).toBeLessThan(0.1);
    // a tower's faces all have windows
    for (let i = 0; i < 100; i++) expect(windowShare('other', 60, 60, 2000, i / 100)).toBeGreaterThan(0);
  });

  it('writes the share on every wall vertex and none on roofs and canopies', () => {
    const m = mesh([{ rings: [sq(0, 0, 30)], height: 20, type: TYPE.hotel, rung: 0 }, { rings: [sq(100, 0, 20)], height: 5, type: TYPE.canopy, rung: 3 }]);
    expect(m.winLit.length).toBe(m.positions.length / 3);
    const roofs = Array.from(m.winLit).filter((_, k) => Math.abs(m.normals[3 * k + 1]) > 0.5);
    expect(roofs.every((v) => v === 0)).toBe(true);
    const w = walls(m);
    expect(w.slice(0, 16).some((v) => v === 255)).toBe(true); // the hotel (its walls come first)
    expect(w.slice(16).every((v) => v === 0)).toBe(true); // the canopy's edges
  });
});
