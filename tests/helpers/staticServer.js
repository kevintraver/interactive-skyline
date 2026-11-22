// A static server that runs the app with no bundler, the way the landmark skill's checker does
// (.claude/skills/blender-landmark-model/scripts/skyline_tool.py, RepoHandler): src/ and node_modules/ from the
// repo, everything else from public/; an import map generated from package.json; JSON imports in app source
// (data/cities.json) resolved against the repo and served as `export default ...` modules. Bare imports are also rewritten to paths inside
// the files themselves, because a module worker (three-mesh-bvh's) does not see the page's import map.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

const pick = (target) => (typeof target === 'string' ? target
  : target && (target.import || target.module || target.browser || target.default));

/** The import map for every dependency in package.json, from each package's `exports` (ESM conditions). */
export function importMap(root = ROOT) {
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies || {});
  const imports = {};
  for (const name of deps) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    const exports = pkg.exports && (typeof pkg.exports === 'string' || pkg.exports.import ? { '.': pkg.exports } : pkg.exports);
    const entries = exports || { '.': pkg.module || pkg.main };
    for (const [key, target] of Object.entries(entries)) {
      const file = pick(target);
      if (!file || key.startsWith('./src/') || key.startsWith('./examples/')) continue;
      const spec = key === '.' ? name : `${name}/${key.slice(2)}`;
      const url = `/node_modules/${name}/${file.replace(/^\.\//, '')}`;
      if (spec.endsWith('/*')) imports[spec.slice(0, -1)] = url.slice(0, -1);
      else imports[spec] = url;
    }
  }
  return imports;
}

/** Make app source loadable without a bundler: JSON imports become `?module` requests; bare imports become paths. */
export function rewriteImports(source, imports) {
  source = source.replace(/(\bfrom\s*)(['"])(\.{0,2}\/[^'"]+\.json)\2/g, (_, a, q, p) => `${a}${q}${p}?module${q}`);
  const resolve = (spec) => {
    if (imports[spec]) return imports[spec];
    const prefix = Object.keys(imports).filter((k) => k.endsWith('/') && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return prefix ? imports[prefix] + spec.slice(prefix.length) : null;
  };
  return source.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"./][^'"]*)\2/g, (m, a, q, spec) => {
    const url = resolve(spec);
    return url ? `${a}${q}${url}${q}` : m;
  });
}

function page(root, imports) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const at = html.indexOf('<script type="module"');
  return html.slice(0, at) + `<script type="importmap">${JSON.stringify({ imports })}</script>\n` + html.slice(at);
}

/** Start the server on a free port. Resolves to { url, close, missing } (missing: paths answered 404). */
export function startStaticServer(root = ROOT) {
  const imports = importMap(root), missing = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    if (rel === '' || rel === 'index.html') return send(200, page(root, imports), TYPES['.html']);
    // a JSON import in app source resolves against the repo (as in Vite; data/cities.json), anything else that is
    // not src/ or node_modules/ against public/ (so /data/<city>/ is the city's terrain and buildings)
    const fromRepo = /^(src|node_modules)\//.test(rel) || (url.search === '?module' && rel.endsWith('.json'));
    const base = fromRepo ? root : path.join(root, 'public');
    const full = path.normalize(path.join(base, rel));
    if (!full.startsWith(base + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      missing.push(url.pathname);
      return send(404, 'not found', 'text/plain');
    }
    const ext = path.extname(full);
    if (ext === '.json' && url.search === '?module') return send(200, `export default ${fs.readFileSync(full, 'utf8')};`, TYPES['.js']);
    if (ext === '.js' && /^(src|node_modules)\//.test(rel)) return send(200, rewriteImports(fs.readFileSync(full, 'utf8'), imports), TYPES['.js']);
    return send(200, fs.readFileSync(full), TYPES[ext] || 'application/octet-stream');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, missing, imports,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}
