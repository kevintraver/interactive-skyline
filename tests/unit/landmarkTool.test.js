// T0.3: the landmark skill still recognises the app. `upgrade` must find every integration hook (now spread
// over src/) and have nothing to do, for both cities.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT } from '../helpers/staticServer.js';

const TOOL = '.claude/skills/blender-landmark-model/scripts/skyline_tool.py';
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const srcStatus = () => execFileSync('git', ['status', '--porcelain', '--', 'src', 'public/models'], { cwd: ROOT, encoding: 'utf8' });

describe.skipIf(!python)('skyline_tool.py', () => {
  for (const city of ['lv', 'slc']) {
    it(`upgrade --city ${city} has nothing to do`, () => {
      const before = srcStatus();
      const out = execFileSync(python, [TOOL, 'upgrade', '--repo', ROOT, '--city', city], { cwd: ROOT, encoding: 'utf8' });
      expect(out).toContain('nothing to do');
      expect(srcStatus()).toBe(before);
    });
  }
  it('find and locate read data/cities.json', () => {
    expect(execFileSync(python, [TOOL, 'find', '--repo', ROOT, '--city', 'lv', '--id', 'w135457469'], { encoding: 'utf8' })).toContain('Stratosphere Tower');
    const at = JSON.parse(execFileSync(python, [TOOL, 'locate', '--repo', ROOT, '--city', 'slc', '--lat', '40.7704', '--lon', '-111.8919'], { encoding: 'utf8' }));
    expect([at.east, at.north]).toEqual([0, 0]);
  });
});
