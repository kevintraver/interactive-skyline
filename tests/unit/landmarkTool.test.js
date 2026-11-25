// T0.3: the landmark skill still recognises the app. `upgrade` must find every integration hook (now spread
// over src/) and have nothing to do, for both cities.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('re-installing an extra keeps the keys it does not set (an extra\'s "building"), and --building sets it', () => {
    // install_extra's own code on a scratch models.json, with the steps that touch a repo (the integration, the GLB
    // copy) stood in for
    const dir = mkdtempSync(join(tmpdir(), 'landmark-tool-'));
    try {
      const manifest = join(dir, 'public', 'models', 'models.json');
      execFileSync('mkdir', ['-p', join(dir, 'public', 'models')]);
      writeFileSync(manifest, JSON.stringify({ extras: { lv: [
        { name: 'Canopy', url: '/models/lv/canopy.glb', east: 1, north: 2, rotation_deg: 0, visible: 'always', blend: 'additive', building: 'w123', future: 7 },
        { name: 'Other', url: '/models/lv/other.glb', east: 5, north: 5, rotation_deg: 0, visible: 'always' },
      ] } }));
      writeFileSync(join(dir, 'canopy.glb'), 'glTF');
      const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(ROOT, '.claude/skills/blender-landmark-model/scripts'))})
import skyline_tool as T
T.check_repo = lambda repo, city: None
T.cities_path = lambda repo: ${JSON.stringify(join(dir, 'cities.json'))}
T.ensure_integration = lambda repo, force, city=None: []
T.copy_glb = lambda repo, glb, city: '/models/lv/canopy.glb'
T.finish_install = lambda repo, done: None
assert T.merge_extra({'name': 'a', 'blend': 'additive', 'spin': {}, 'building': 'w1', 'x': 1}, {'name': 'a'}) == {'building': 'w1', 'x': 1, 'name': 'a'}
assert T.merge_extra(None, {'name': 'a'}) == {'name': 'a'}
repo = ${JSON.stringify(dir)}
T.install_extra(repo, 'lv', 'Canopy', repo + '/canopy.glb', 10, 20, 0, 'night', 'opaque', False)
first = json.load(open(${JSON.stringify(manifest)}))['extras']['lv']
T.install_extra(repo, 'lv', 'Canopy', repo + '/canopy.glb', 10, 20, 0, 'night', 'opaque', False, None, 'w999')
second = json.load(open(${JSON.stringify(manifest)}))['extras']['lv']
print(json.dumps({'first': first, 'second': second}))
`;
      writeFileSync(join(dir, 'cities.json'), JSON.stringify({ lv: {} }));
      const out = JSON.parse(execFileSync(python, ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
      const canopy = (list) => list.find((e) => e.name === 'Canopy');
      // the tool's own keys are what this install says (opaque: no blend), the rest kept
      expect(canopy(out.first)).toEqual({ name: 'Canopy', url: '/models/lv/canopy.glb', east: 10, north: 20, rotation_deg: 0, visible: 'night', building: 'w123', future: 7 });
      expect(out.first.find((e) => e.name === 'Other')).toEqual({ name: 'Other', url: '/models/lv/other.glb', east: 5, north: 5, rotation_deg: 0, visible: 'always' });
      expect(canopy(out.second).building).toBe('w999');
      expect(canopy(out.second).future).toBe(7);
      expect(readFileSync(manifest, 'utf8')).toContain('"building": "w999"');
      // and the command line takes --building
      expect(execFileSync(python, [TOOL, 'install', '--help'], { encoding: 'utf8' })).toContain('--building');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the check page\'s import map serves every package the app imports bare (astronomy-engine since phase 1)', () => {
    const code = 'import sys; sys.path.insert(0, sys.argv[1]); import skyline_tool as t; print(t.import_map(sys.argv[2]))';
    const out = execFileSync(python, ['-c', code, '.claude/skills/blender-landmark-model/scripts', ROOT], { cwd: ROOT, encoding: 'utf8' });
    const map = JSON.parse(out.replace(/^<script type="importmap">|<\/script>\s*$/g, '')).imports;
    for (const name of ['three', 'three/addons/', 'three-mesh-bvh', 'three-mesh-bvh/worker', 'astronomy-engine']) expect(map[name], name).toBeTruthy();
    expect(map['astronomy-engine']).toBe('/node_modules/astronomy-engine/esm/astronomy.js');
  });
  it('find and locate read data/cities.json', () => {
    expect(execFileSync(python, [TOOL, 'find', '--repo', ROOT, '--city', 'lv', '--id', 'w135457469'], { encoding: 'utf8' })).toContain('Stratosphere Tower');
    const at = JSON.parse(execFileSync(python, [TOOL, 'locate', '--repo', ROOT, '--city', 'slc', '--lat', '40.7704', '--lon', '-111.8919'], { encoding: 'utf8' }));
    expect([at.east, at.north]).toEqual([0, 0]);
  });
});
