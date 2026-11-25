// The drive's source rules (plan 02, third stretch): the drive and its world run on plan 01's renderer alone. Nothing
// under src/drive or src/world names a classic-renderer class, patches a shader (onBeforeCompile), reads `legacy`, or
// keeps a GLSL module or a `.node.js` twin; and, as everywhere in src (sourceHygiene.test.js), the files load without a
// bundler: no Vite-only suffixes, no import.meta.env, and here no JSON imports either. Comments may name what is gone.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const files = ['src/drive', 'src/world'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
  .filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)));

/** The code of a file without its comments (strings and template literals kept as they are). */
function codeOf(text) {
  let out = '', i = 0, quote = null;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
    } else if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i = text.indexOf('*/', i + 2);
      i = i < 0 ? text.length : i + 2;
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
      i++;
    }
  }
  return out;
}

describe('the drive\'s source rules', () => {
  it('finds the drive\'s sources', () => expect(files.length).toBeGreaterThan(100));

  it('keeps no GLSL module and no .node.js twin', () => {
    expect(files.filter((f) => /\.(glsl|node)\.js$/.test(f))).toEqual([]);
  });

  it('strips comments and keeps strings', () => {
    expect(codeOf("a = 'x // y'; // legacy\n/* WebGLRenderer */ b = `/* z */`;")).toBe("a = 'x // y'; \n b = `/* z */`;");
  });

  for (const file of files) {
    it(file, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const code = codeOf(text);
      expect(code, `${file}: a classic-renderer class`).not.toMatch(/\b(WebGLRenderer|ShaderMaterial|RawShaderMaterial|WebGLRenderTarget)\b/);
      expect(code, `${file}: a shader patch`).not.toMatch(/\bonBeforeCompile\b/);
      expect(code, `${file}: reads legacy`).not.toMatch(/\blegacy\b/);
      expect(code, `${file}: import.meta.env`).not.toMatch(/import\.meta\.env/);
      for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\1/g)) {
        expect(m[2], `${file}: Vite-only suffix`).not.toMatch(/\?(raw|url|worker|inline)\b/);
        expect(m[2], `${file}: a JSON import`).not.toMatch(/\.json$/);
      }
    });
  }
});
