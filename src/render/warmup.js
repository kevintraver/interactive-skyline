// Link the first frame's GL programs in parallel before drawing it (WebGL2 backend only).
//
// WebGPURenderer's WebGL2 backend links a program the first time an object needs it and then asks for its link
// status at once, which blocks the main thread until the driver has finished: the first frame's dozen programs were
// linked one after another, most of the time between the app being ready and its first frame (measured on ANGLE
// Metal, Apple M4). The backend can link in parallel (KHR_parallel_shader_compile) when it is given a list to put
// its promises in, as renderer.compileAsync() does; compileAsync() itself does not see the render pipeline's passes
// (the scene pass into its HDR target, the shadow map, bloom, the output), so this draws one frame of the pipeline
// with that list in place: every program the frame needs starts linking, objects whose program is not linked yet are
// skipped, and nothing else changes. The frame it draws is thrown away (the loading cover still hides the canvas),
// the shadow map, drawn with objects missing, is marked for redrawing, and the first real frame then finds every
// program ready. The WebGPU backend creates its pipelines without blocking and the classic renderer is untouched.
export async function warmUp({ renderer, pipeline }) {
  if (pipeline.legacy || !renderer.backend.isWebGLBackend || !renderer.backend.parallel) return;
  const pipelines = renderer._pipelines;
  const promises = [];
  const updateForRender = pipelines.updateForRender;
  pipelines.updateForRender = (renderObject) => pipelines.getForRender(renderObject, promises);
  try {
    pipeline.render();
  } finally {
    pipelines.updateForRender = updateForRender;
  }
  await Promise.all(promises);
  renderer.shadowMap.needsUpdate = true;
}
