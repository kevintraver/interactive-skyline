// The pane's textures (plan 03, sections 6.6 and 9.2; F5.1), made by scripts/build_pane_textures.py from fixed seeds and
// served from public/textures/pane/. Each starts as a 1 x 1 stand-in that means "nothing there" (no scratches, no
// dirt, never frozen), so the material compiles and draws at once; the files replace them as they arrive.
//
//   surface  R, G the scratches' doubled-angle direction premultiplied by density, B density, A dirt
//   frost    R, G, B, A four growth maps (the share of the pane frozen when each texel froze)
//   facets   R, G, B, A each growth map's crystal id (High and Ultra only)

import { DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, ClampToEdgeWrapping, NoColorSpace, TextureLoader } from 'three';

export const PANE_TEXTURE_URL = '/textures/pane/';
export const TEXTURE_SIZE = Object.freeze([512, 704]);
/** The span of the textures on the pane, metres (the inner pane's opening; build_pane_textures.py PANE_W, PANE_H). */
export const TEXTURE_SPAN = Object.freeze([0.29, 0.38]);

function standIn(rgba) {
  const t = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat, UnsignedByteType);
  t.magFilter = t.minFilter = LinearFilter;
  t.colorSpace = NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** GPU bytes of an RGBA8 texture with its mip chain (four thirds of the base). */
export const textureBytes = (w, h) => Math.round(w * h * 4 * (4 / 3));

/**
 * The textures, loading. `ready` resolves when every file is in (or failed: the stand-ins stay and `errors` says why).
 * onLoad(name, texture) runs as each arrives, so a material can swap it in.
 * @param {{ baseUrl?: string, facets?: boolean, loader?: { loadAsync(url: string): Promise<import('three').Texture> },
 *   onLoad?: (name: string, texture: import('three').Texture) => void }} [o]
 */
export function loadPaneTextures({ baseUrl = PANE_TEXTURE_URL, facets = true, loader = null, onLoad = () => {} } = {}) {
  const set = {
    surface: standIn([128, 128, 0, 0]),
    frost: standIn([255, 255, 255, 255]),
    facets: standIn([0, 0, 0, 0]),
  };
  const errors = [];
  const loaded = new Set();
  const names = facets ? ['surface', 'frost', 'facets'] : ['surface', 'frost'];
  const get = loader ?? new TextureLoader();
  const ready = Promise.all(names.map((name) => get.loadAsync(`${baseUrl}pane-${name}.png`).then((t) => {
    t.flipY = false; // row 0 is the top of the pane (v = +0.19 m) on both backends
    t.colorSpace = NoColorSpace; // data, not colour
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    const old = set[name];
    set[name] = t;
    loaded.add(name);
    onLoad(name, t);
    old.dispose();
  }, (e) => { errors.push(`${name}: ${e?.message ?? e}`); }))).then(() => set);
  void RepeatWrapping;
  return {
    get surface() { return set.surface; },
    get frost() { return set.frost; },
    get facets() { return set.facets; },
    ready,
    errors,
    get loaded() { return [...loaded]; },
    /** GPU bytes of what is loaded (stand-ins count as nothing). */
    get bytes() { return [...loaded].reduce((s, n) => s + textureBytes(set[n].image?.width ?? 0, set[n].image?.height ?? 0), 0); },
    dispose() { for (const t of Object.values(set)) t.dispose(); },
  };
}
