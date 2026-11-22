// One frame as a PNG (plan 01, T2.1). The classic renderer kept its drawing buffer (preserveDrawingBuffer) so the
// canvas could be read at any time; WebGPU has no such option, and neither has WebGPURenderer's WebGL2 backend. A
// canvas's picture can still be read in the task that drew it, before it is presented, so capture() renders the
// current view and takes the canvas's bitmap at once (toBlob snapshots synchronously, then encodes).
export function createCapture({ renderer, scene, camera, canvas, draw = () => renderer.render(scene, camera) }) {
  return function capture(type = 'image/png') {
    draw();
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the canvas gave no picture'))), type));
  };
}
