// T0.6: src/ stays valid browser ESM (plan 01, section 5.1, principle 5): no Vite-only import suffixes, no
// import.meta.env, and bare imports only for specifiers the buildless import map provides. Relative JSON
// imports are allowed: Vite and the buildless servers both serve them as modules.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, importMap } from '../helpers/staticServer.js';

const files = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => path.join('src', f));
const imports = importMap();
const allowed = (spec) => imports[spec] || Object.keys(imports).some((k) => k.endsWith('/') && spec.startsWith(k));
const specifiers = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm)].map((m) => m[2]);

describe('source hygiene', () => {
  it('finds the app sources', () => expect(files.length).toBeGreaterThan(10));
  for (const file of files) {
    it(file, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text).not.toMatch(/import\.meta\.env/);
      for (const spec of specifiers(text)) {
        expect(spec, `${file}: Vite-only suffix`).not.toMatch(/\?(raw|url|worker|inline)\b/);
        if (spec.startsWith('.') || spec.startsWith('/')) {
          expect(fs.existsSync(path.resolve(path.dirname(path.join(ROOT, file)), spec)), `${file}: ${spec} exists`).toBe(true);
        } else {
          expect(allowed(spec), `${file}: bare import ${spec} is not in the import map`).toBeTruthy();
        }
      }
    });
  }
  it('maps three, its addons, webgpu and tsl, and three-mesh-bvh', () => {
    for (const k of ['three', 'three/addons/', 'three/webgpu', 'three/tsl', 'three-mesh-bvh', 'three-mesh-bvh/worker']) expect(imports[k], k).toBeTruthy();
  });
});
