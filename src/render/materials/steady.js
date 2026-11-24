// Per-object refresh on WebGPURenderer, for materials drawn many times a frame (the buildings and their edges).
//
// Before drawing an object the renderer asks the material's observer whether the object needs a refresh: FULL
// (its geometry, node and binding updates, about 20 microseconds a building here), SHARED (only the uniforms every
// object shares) or NONE. The observer answers FULL on every frame for any material whose build saw a node it cannot
// watch: a node property on the material, or a matrix in the renderer's context. `renderer.highPrecision`
// (src/render/renderer.js: the model-view matrix computed on the CPU in double precision, as the classic renderer
// did) puts one in the context of every material, so every object was refreshed in full on every frame, with the
// camera and the scene standing still.
//
// What the high-precision matrices depend on is the object's world matrix, which the observer already compares,
// and the camera's view matrix, which it does not. steadyRefresh() keeps the observer's ordinary comparison
// (material values, world matrix, geometry, lights, output target) and adds the view matrix, per object; for a
// material whose own nodes read only values that are watched that way or live in a shared uniform group
// (shared.js puts the app's uniforms in the render group). What a refresh writes is unchanged; only frames on which
// nothing it depends on moved skip it.
import { RenderObjectRefreshType } from 'three/webgpu';

/** Context entries the renderer's high-precision matrices add, and the observer treats as unwatchable. */
const HIGH_PRECISION = ['modelViewMatrix', 'modelNormalViewMatrix'];
const OTHER_CONTEXT = ['getAO', 'getShadow', 'getGI'];

/**
 * Make `observer` (from NodeMaterial.setupObserver) refresh an object in full only when its material, world matrix,
 * geometry, lights or output target changed (as for a material without nodes) or the camera's view matrix did.
 * Leaves the observer alone when its build depends on anything else it cannot watch.
 */
export function steadyRefresh(observer, builder) {
  const c = builder.context;
  if (!observer.hasNode || observer.hasAnimation || OTHER_CONTEXT.some((k) => c[k])) return observer;
  const highPrecision = HIGH_PRECISION.some((k) => c[k]);
  observer.hasNode = false;
  if (!highPrecision) return observer;
  const views = new WeakMap(); // render object -> the view matrix it was last refreshed with
  const needsRefresh = observer.needsRefresh.bind(observer);
  observer.needsRefresh = (renderObject, nodeFrame) => {
    let refresh = needsRefresh(renderObject, nodeFrame);
    const view = renderObject.camera.matrixWorldInverse;
    const last = views.get(renderObject);
    if (!last) { views.set(renderObject, view.clone()); refresh = RenderObjectRefreshType.FULL; }
    else if (!last.equals(view)) { last.copy(view); refresh = RenderObjectRefreshType.FULL; }
    return refresh;
  };
  return observer;
}

/** `Base` (a node material class) with steadyRefresh() for its observer. */
export const steady = (Base) => class extends Base {
  setupObserver(builder) {
    return steadyRefresh(super.setupObserver(builder), builder);
  }
};

