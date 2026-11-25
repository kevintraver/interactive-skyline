// Handing plan 01's pipeline back to the map as the drive found it.
//
// Every pipeline.addStage() and every stage's removal rebuilds plan 01's graph (src/render/pipeline.js build()), and
// the drive adds stages: the adaptation stage while it is shown (session.js), the cabin's veil, rain and mirrors when
// its part loads. A rebuild makes a bloom when the look asks for one and there is none. The map, as plan 01 leaves
// it, can have none: its quality governor calls pipeline.configure({ bloomScale }) on every profile it applies
// (src/render/setupQuality.js apply()), and at the scale the pipeline already has, configure() disposes the bloom
// without rebuilding the graph, so the map's frame mixes in the dead bloom's texture (about 6 % darker, no halo)
// until something rebuilds. A visit to Drive was that something: the map came back with a live bloom, brighter and
// hazier towards the horizon than before the visit (2 % of its pixels at the default view).
//
// So the drive notes, before it touches the pipeline, whether the map drew the bloom its look asks for, and on leaving
// puts the same state back through the same call plan 01 used. Once plan 01's configure() no longer drops a bloom
// it keeps, the map always has its bloom here and this does nothing.

/**
 * Note the map's pipeline state before the drive adds stages; the returned function puts it back.
 * @param {object} [pipeline]  plan 01's pipeline (app.plan01.pipeline)
 * @returns {() => void}
 */
export function saveMapPipeline(pipeline) {
  if (!pipeline) return () => {};
  const bloomDead = pipeline.settings.bloom > 0 && !pipeline.bloom;
  return () => {
    // still asked for, and made by a rebuild while driving: the map did not draw it
    if (bloomDead && pipeline.bloom && pipeline.settings.bloom > 0) pipeline.configure({ bloomScale: pipeline.settings.bloomScale });
  };
}
