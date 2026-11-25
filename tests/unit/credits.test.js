// About the data (src/ui/credits.js): every source the shipped data names is credited, with a link, and no licence
// is claimed that the repository does not record.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CREDITS, creditsHtml } from '../../src/ui/credits.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const json = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const items = CREDITS.flatMap((g) => g.items);
const drive = CREDITS.find((g) => g.title.startsWith('Drive')).items;
const credited = (re) => drive.some((c) => re.test(`${c.name} ${c.use}`));

describe('credits', () => {
  it('names each source with what it is used for and a link', () => {
    expect(items.length).toBeGreaterThan(8);
    for (const c of items) {
      expect(c.name, JSON.stringify(c)).toBeTruthy();
      expect(c.use, c.name).toBeTruthy();
      expect(c.url, c.name).toMatch(/^https:\/\//);
      expect(c.licence === null || typeof c.licence === 'string', c.name).toBe(true);
      if (c.licenceUrl) expect(c.licenceUrl).toMatch(/^https:\/\//);
    }
  });

  it('gives OpenStreetMap the licence the sidecars record', () => {
    for (const f of ['roadnet.json', 'roadnet-i15s.json', 'roadnet-us93.json', 'signs.json', 'barriers.json']) {
      expect(json(`public/data/lv/${f}`).source.osmLicence, f).toMatch(/^ODbL/);
    }
    for (const c of items.filter((i) => /OpenStreetMap contributors/.test(i.name))) expect(c.licence).toBe('ODbL 1.0');
  });

  it('credits every street-light source of the lamp inventory', () => {
    const { credit, sources } = json('data/derived/lv/lights_report.json');
    for (const name of ['Clark County', 'City of Las Vegas', 'Henderson', 'Boulder City', 'OpenStreetMap']) {
      expect(credit, name).toContain(name);
      expect(drive.some((c) => c.name.includes(name) && /street (lights|lamps)/i.test(c.use)), name).toBe(true);
    }
    const urls = Object.values(sources).flatMap((s) => (s.provenance || []).map((p) => p.url));
    for (const c of drive.filter((i) => /^Street lights$/.test(i.use))) expect(urls, c.name).toContain(c.url);
  });

  it('credits the billboard, building and traffic sources the sidecars name', () => {
    const bb = json('public/data/lv/billboards.json').attribution;
    for (const name of ['OpenStreetMap', 'City of Las Vegas', 'Clark County']) expect(bb).toContain(name);
    expect(credited(/City of Las Vegas.*Clark County.*Billboard/)).toBe(true);
    expect(json('public/data/lv/corridor/index.json').attribution.join(' ')).toContain('Overture Maps Foundation');
    expect(credited(/Overture Maps Foundation/)).toBe(true);
    for (const r of ['i15n', 'i15s', 'us93']) {
      for (const s of json(`public/data/lv/traffic/${r}.json`).sources.filter((x) => x.id === 'tmas' || x.id === 'trina')) {
        expect(drive.map((c) => c.url), `${r} ${s.id}`).toContain(s.url);
      }
    }
  });

  it('credits the billboard advertisements made for this project, as fictional', () => {
    const { images } = json('public/textures/billboards/manifest.json');
    expect(images.length).toBe(40);
    const c = drive.find((i) => /advertisements/i.test(i.name));
    expect(c, 'a line for the billboard artwork').toBeTruthy();
    expect(c.use).toMatch(/forty/);
    expect(c.use).toMatch(/image model.*Codex/);
    expect(c.use).toMatch(/lettering set in code/);
    expect(c.use).toMatch(/fictional/);
    expect(c.use).toMatch(/resemblance to a real business is unintended/);
  });

  it('renders every source, escaped', () => {
    const html = creditsHtml([{ title: 'T <x>', items: [{ name: 'A & B', use: 'u', url: 'https://e.org/?a=1&b=2', licence: null }] }]);
    expect(html).toContain('T &lt;x&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('href="https://e.org/?a=1&amp;b=2"');
    const all = creditsHtml();
    for (const c of items) expect(all).toContain(c.use.replace(/&/g, '&amp;'));
  });
});
