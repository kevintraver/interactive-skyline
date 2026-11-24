import { loadCustomModels } from '../customModels.js';
import { separateModels } from './coplanar.js';

/** Start every download for a city at once, so the files arrive while the renderer is being set up. */
export function startDownloads(cityId) {
  const DATA = `/data/${cityId}`;
  const download = (file, kind) => fetch(`${DATA}/${file}`).then((r) => r[kind]());
  return {
    model: download('buildings.json', 'json'),
    terrain: download('terrain.json', 'json').then(async (meta) => {
      const [far, near] = await Promise.all(['far', 'near'].map((k) => download(meta.grids[k].file, 'arrayBuffer')));
      return { meta, far, near };
    }),
    // decoded off the main thread; flipped here because WebGL ignores its own flip setting for bitmaps
    maps: ['far', 'near'].map((k) => download(`ground-${k}.jpg`, 'blob')
      .then((blob) => createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))),
    // faces of one model in one plane are moved apart, so they cannot flicker (coplanar.js)
    custom: loadCustomModels(cityId).then(separateModels),
  };
}
