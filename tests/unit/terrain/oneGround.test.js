// The drive stands everything on one ground: the ground as drawn (terrain.surfaceAt / surfaceY, drawn.js). The
// bilinear height query (terrain.heightAt / groundY) is the map's, and differs from what is on screen by metres in the
// mountains, so no drive module may place anything on it. Test hooks (src/drive/index.js) may still expose it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../src/drive/', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
});

describe('one ground', () => {
  it('no drive module places anything on the bilinear height query', () => {
    const offenders = [];
    for (const f of files(ROOT)) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\bterrain\??\.(heightAt|groundY)\b/.test(line) && !/hooks\.terrain\s*=/.test(line)) offenders.push(`${f.slice(ROOT.length)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
