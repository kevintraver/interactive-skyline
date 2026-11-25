// The regional terrain as the mode uses it (plan 03, sections 7.9, 7.14 and 9.1; F4.7): the committed grids loaded
// through createRegionTerrain, the five harness cameras, what is loaded and cut at each, the triangle budget, and the
// height steps at every border as drawn. Images are left out (Node has no createImageBitmap); the meshes are built.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Euler } from 'three';
import { createRegionTerrain } from '../../../src/flight/terrain/index.js';
import { BUDGET, SINK } from '../../../src/flight/terrain/meshes.js';
import { createTerrain } from '../../../src/world/terrain/index.js';
import { createFrame, curveDrop } from '../../../src/world/frame.js';
import { nearFar } from '../../../src/flight/view/layers.js';
import { VIEWS, placeCamera } from '../../manual/flight-terrain-views.js';
import cities from '../../../data/cities.json';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
const raw = (name) => { const b = readFileSync(new URL(name, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const frame = createFrame(cities.lv);
const BASE = cities.lv.base;
const fetched = [];
const fetchStub = async (url) => {
  const f = url.split('/').pop();
  fetched.push(f);
  return { ok: true, status: 200, arrayBuffer: async () => raw(f) };
};
const provider = createTerrain({ meta, buffers: { near: raw(meta.grids.near.file), far: raw(meta.grids.far.file) }, base: BASE, fetchBinary: async (f) => raw(f) });

function make(level = 'high') {
  return createRegionTerrain({ meta, baseUrl: '/data/lv', frame, terrain: provider, quality: { level }, fetch: fetchStub, loadImage: async () => null });
}
function camera(name, aspect = 16 / 9) {
  const v = VIEWS[name], c = new PerspectiveCamera(v.fov, aspect, 0.5, 1);
  placeCamera(c, v, { base: BASE, Quaternion, Euler });
  const { near, far } = nearFar(v.agl);
  c.near = near; c.far = far;
  c.updateProjectionMatrix();
  return c;
}
async function settle(region, cam, opts = {}) {
  region.update({ camera: cam, height: 1080, ...opts });
  await region.whenSettled();
  return region.update({ camera: cam, height: 1080, ...opts });
}

describe('loading by what the eye can see', () => {
  it('loads every grid at cruise, coarsest first, and cuts each finer one out of its parent', async () => {
    fetched.length = 0;
    const region = make();
    const s = await settle(region, camera('cruise'));
    expect(s.needed).toEqual(['region', 'approaches', 'valley']);
    expect(fetched).toEqual(['terrain-region.bin.gz', 'terrain-approaches.bin.gz', 'terrain-valley.bin.gz']);
    const { loaded } = region.stats();
    for (const n of ['region', 'approaches', 'valley']) expect(loaded[n].state).toBe('ready');
    const ext = (n) => { const g = meta.grids[n]; return { x0: g.x0, x1: g.x0 + (g.nx - 1) * g.step, y0: g.y0, y1: g.y0 + (g.ny - 1) * g.step }; };
    expect(loaded.region.holes).toEqual([{ ...ext('approaches'), sink: 0 }]);
    expect(loaded.approaches.holes).toEqual([{ ...ext('valley'), sink: 0 }]);
    expect(loaded.valley.holes).toEqual([{ ...ext('far'), sink: SINK, curtain: true }]); // and a curtain from far's edge
    expect(region.stats().outer).toBe(true);
    region.dispose();
  });

  it('on final loads approaches and valley but not region', async () => {
    fetched.length = 0;
    const region = make();
    const s = await settle(region, camera('final'));
    expect(s.needed).toEqual(['approaches', 'valley']);
    expect(region.stats().loaded.region.state).toBe('idle');
    expect(region.stats().loaded.approaches.holes[0].sink).toBe(0);
    region.dispose();
  });

  it('answers heights from the provider before anything is loaded and from the grids after', async () => {
    const region = make();
    const p = frame.toLocal(36.06, -114.76); // Lake Mead
    expect(region.heightAt(p.x, p.y)).toBeCloseTo(provider.heightAt(p.x, p.y), 6);
    await settle(region, camera('lake-mead'));
    expect(region.sourceAt(p.x, p.y)).toBe('valley');
    expect(region.heightAt(p.x, p.y)).toBeCloseTo(366.7, 0);
    expect(region.surfaceY(p.x, p.y)).toBeCloseTo(region.heightAt(p.x, p.y) - BASE - curveDrop(p.x, p.y), 0);
    region.dispose();
  });
});

describe('the triangle budget of section 9.1 at the five harness views', () => {
  const views = ['cruise', 'cruise-right', 'fl180', 'lake-mead', 'east-valley', 'final'];
  for (const level of ['high', 'low']) {
    it(`holds ${BUDGET[level].toLocaleString('en')} triangles on ${level}`, async () => {
      const region = make(level);
      const rows = [];
      for (const name of views) {
        const s = await settle(region, camera(name));
        expect(s.triangles, name).toBeLessThanOrEqual(BUDGET[level]);
        expect(s.drawCalls, name).toBeLessThanOrEqual(100);
        rows.push(`${name}: ${s.triangles} triangles, ${s.drawCalls} draws, target ${s.targetPx} px, ${JSON.stringify(Object.fromEntries(Object.entries(s.grids).map(([n, g]) => [n, `${g.drawn}/${g.chunks} ${JSON.stringify(g.strides)}`])))}`);
      }
      console.log(`${level}\n${rows.join('\n')}`);
      region.dispose();
    });
  }
});

describe('the borders as drawn', () => {
  it('meets each child\'s edge at stride 1 within the encodings\' rounding', async () => {
    const region = make();
    await settle(region, camera('cruise'));
    const g = (n) => region.stats().loaded[n];
    expect(g('valley').state).toBe('ready');
    // the parent's triangles against the child's along the child's edge: both drawn at stride 1
    const steps = {};
    for (const [child, parent] of [['approaches', 'region'], ['valley', 'approaches']]) {
      const e = meta.grids[child], x1 = e.x0 + (e.nx - 1) * e.step, y1 = e.y0 + (e.ny - 1) * e.step;
      const pg = { ...meta.grids[parent] };
      const cs = [], ps = [];
      for (let t = 0.013; t < 1; t += 0.0071) {
        for (const [x, y] of [[e.x0 + t * (x1 - e.x0), e.y0], [e.x0 + t * (x1 - e.x0), y1], [e.x0, e.y0 + t * (y1 - e.y0)], [x1, e.y0 + t * (y1 - e.y0)]]) {
          cs.push(region.grid(child).triangles(x, y));
          ps.push(region.grid(parent).triangles(x, y));
        }
      }
      const d = cs.map((h, k) => Math.abs(h - ps[k]));
      steps[child] = { max: Math.max(...d), median: d.sort((a, b) => a - b)[d.length >> 1] };
      expect(pg).toBeTruthy();
    }
    console.log('drawn steps at stride 1', JSON.stringify(steps));
    expect(steps.approaches.max).toBeLessThan(1.0);
    expect(steps.valley.max).toBeLessThan(0.5);
    region.dispose();
  });
});
