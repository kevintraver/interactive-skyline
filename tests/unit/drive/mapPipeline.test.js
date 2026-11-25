// Handing plan 01's pipeline back to the map (src/drive/mapPipeline.js). The fake below copies what plan 01's
// pipeline (src/render/pipeline.js) does with its bloom: build() makes one when the look asks for bloom and there is
// none; addStage() and a stage's removal build; configure({ bloomScale }) at the scale it already has disposes the
// bloom and does not build, so the graph keeps the dead bloom's texture until the next build.
import { describe, it, expect } from 'vitest';
import { saveMapPipeline } from '../../../src/drive/mapPipeline.js';

function fakePipeline({ bloom = 0.06, bloomScale = 0.5 } = {}) {
  const settings = { toneMapping: 'agx', bloom, contrast: 0.08, saturation: 0.12, bloomScale };
  const stages = [];
  let live = null, builds = 0, made = 0;
  const build = () => {
    builds++;
    if (settings.bloom > 0) { if (!live) live = { id: ++made }; } else live = null;
  };
  build();
  return {
    get settings() { return { ...settings }; },
    get bloom() { return live; },
    get builds() { return builds; },
    get stages() { return stages.length; },
    addStage(s) { stages.push(s); build(); return () => { const i = stages.indexOf(s); if (i >= 0) { stages.splice(i, 1); build(); } }; },
    configure(o) {
      const rebuild = o.bloomScale !== undefined && o.bloomScale !== settings.bloomScale;
      if (o.bloomScale !== undefined && live) live = null;
      Object.assign(settings, o);
      if (rebuild) build();
    },
  };
}

/** The map as plan 01 leaves it once its quality governor has applied a profile: bloom asked for, none drawn. */
function deadBloomMap() {
  const p = fakePipeline();
  p.configure({ bloomScale: 0.5 });
  expect(p.bloom).toBe(null);
  return p;
}

describe('saveMapPipeline', () => {
  it('gives the map back a bloom that was not drawn before the visit, after a stage came and went', () => {
    const p = deadBloomMap();
    const restore = saveMapPipeline(p);
    const remove = p.addStage({ id: 'drive-adaptation', at: 'afterBloom' });
    expect(p.bloom).not.toBe(null); // the drive's stage rebuilt the graph, which made a bloom
    remove();
    expect(p.bloom).not.toBe(null);
    restore();
    expect(p.bloom).toBe(null);
    expect(p.settings).toEqual(fakePipeline().settings);
  });

  it('also when a stage stays registered (a part keeps its stage until it is disposed)', () => {
    const p = deadBloomMap();
    const restore = saveMapPipeline(p);
    p.addStage({ id: 'cabin-veil', at: 'afterBloom' });
    restore();
    expect(p.bloom).toBe(null);
  });

  it('leaves a live bloom alone (the map drew it before the visit)', () => {
    const p = fakePipeline();
    const before = p.bloom;
    const restore = saveMapPipeline(p);
    p.addStage({ id: 'drive-adaptation', at: 'afterBloom' })();
    const builds = p.builds;
    restore();
    expect(p.bloom).toBe(before);
    expect(p.builds).toBe(builds);
  });

  it('does nothing when the look has no bloom, when nothing rebuilt, or without a pipeline', () => {
    const none = fakePipeline({ bloom: 0 });
    saveMapPipeline(none)();
    expect(none.bloom).toBe(null);

    const untouched = deadBloomMap();
    const builds = untouched.builds;
    saveMapPipeline(untouched)();
    expect(untouched.builds).toBe(builds);

    expect(() => saveMapPipeline(undefined)()).not.toThrow();
  });
});
