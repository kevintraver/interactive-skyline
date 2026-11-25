// The delta-gzip height encoding of the nested terrain grids (plan 03, sections 6.7 and 7.9): the browser's reader of
// the files scripts/lib/grids.py writes (encode_delta_gzip), word for word. Pure, no three.js; runs under Node.
//
// From the grid's `encodingSpec` in terrain.json: the file is one gzip member. Inflated it is 2 * nx * ny bytes, the low
// bytes of nx * ny 16-bit words and then their high bytes, row-major, row 0 = south, column 0 = west. Each word is the
// difference d = (q - p) mod 65536 between a post's quantised height q and a prediction p from the posts before it:
// 0 at the first post, the left neighbour along row 0, the one below (to the south) up column 0, and
// left + below - below-left everywhere else. Heights are h = q * scale + offset.

/**
 * Inflate one gzip member. DecompressionStream('gzip') where the platform has it (every browser the app runs on, and
 * Node 18 and later), else Node's zlib. `opts.stream: false` forces the fallback (for its test).
 * @param {ArrayBuffer | ArrayBufferView} data
 * @returns {Promise<Uint8Array>}
 */
export async function gunzip(data, { stream = true } = {}) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (stream && typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Node without the stream (none the repository supports, but the fallback the tests name): its zlib, reached without
  // an import statement so the browser build never sees it
  const zlib = globalThis.process?.getBuiltinModule?.('node:zlib');
  if (!zlib) throw new Error('gunzip: no DecompressionStream and no node:zlib');
  const out = zlib.gunzipSync(bytes);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * The quantised heights q of an inflated delta-gzip body: the byte planes joined and the prediction undone.
 * @param {Uint8Array} body  2 * nx * ny bytes
 * @param {number} nx  @param {number} ny
 * @returns {Uint16Array} q, row-major, row 0 = south (a Uint16Array wraps mod 65536 by itself)
 */
export function decodeDeltaPlanes(body, nx, ny) {
  const n = nx * ny;
  if (body.length !== 2 * n) throw new Error(`delta-gzip: ${body.length} bytes inflated, expected 2 * ${nx} * ${ny} = ${2 * n}`);
  const q = new Uint16Array(n);
  // row 0: the left neighbour
  let run = 0;
  for (let i = 0; i < nx; i++) {
    run = (run + body[i] + 256 * body[n + i]) & 0xffff;
    q[i] = run;
  }
  // every other row: q[j][i] = d + q[j][i-1] + q[j-1][i] - q[j-1][i-1], which for column 0 is d + q[j-1][0]. Written as
  // q[j][i] = q[j-1][i] + (running sum of d along row j): the column-0 term carries the row's first difference.
  for (let j = 1; j < ny; j++) {
    const row = j * nx, prev = row - nx;
    let sum = 0;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      sum = (sum + body[k] + 256 * body[n + k]) & 0xffff;
      q[k] = q[prev + i] + sum; // stored mod 65536
    }
  }
  return q;
}

/**
 * A grid entry of terrain.json decoded: its posts as q, with what is needed to turn them into metres.
 * @param {ArrayBuffer | ArrayBufferView} data  the .bin.gz file's bytes
 * @param {{ nx: number, ny: number, x0?: number, y0?: number, step?: number, scale: number, offset?: number }} entry
 * @returns {Promise<{ nx: number, ny: number, x0: number, y0: number, step: number, scale: number, offset: number,
 *   q: Uint16Array, min: number, max: number, decodeMs: number, bytes: number, inflatedByServer: boolean }>}
 */
export async function decodeGrid(data, entry) {
  const t0 = now();
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // a server that sends the .gz file with Content-Encoding: gzip (Vite's dev server does) has the browser inflate it
  // before we see it: then there is no gzip magic and the body is already the byte planes
  // (and should the planes happen to begin with the magic, a failed inflate of a body of the planes' length means the same)
  const planes = bytes.length === 2 * entry.nx * entry.ny;
  let body = bytes, inflatedByServer = planes && !isGzip(bytes);
  if (!inflatedByServer) {
    try { body = await gunzip(bytes); } catch (err) { if (!planes) throw err; inflatedByServer = true; }
  }
  const q = decodeDeltaPlanes(body, entry.nx, entry.ny);
  let lo = 65535, hi = 0;
  for (let k = 0; k < q.length; k++) {
    const v = q[k];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const scale = entry.scale, offset = entry.offset ?? 0;
  return {
    nx: entry.nx, ny: entry.ny, x0: entry.x0 ?? 0, y0: entry.y0 ?? 0, step: entry.step ?? 1, scale, offset, q,
    min: lo * scale + offset, max: hi * scale + offset, decodeMs: now() - t0, bytes: q.byteLength, inflatedByServer,
  };
}

/** Whether bytes begin with the gzip magic (RFC 1952: 0x1f 0x8b). */
export const isGzip = (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Metres above sea level of post (i, j) of a decoded grid. */
export const heightOf = (g, i, j) => g.q[j * g.nx + i] * g.scale + g.offset;

const now = () => (globalThis.performance ? performance.now() : Date.now());
