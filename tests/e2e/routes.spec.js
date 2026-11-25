// The drive on each of its three routes (plan 02, D9.4): the basic cases of drive.spec.js parameterised by route,
// each opened cold from its address, and switching routes while driving without leaking GPU memory. State only
// (poses, visibility, renderer.info), no goldens: the picture of each route is looked at by hand
// (tests/manual/routes-app-shots.mjs). The clean camera, so the cases judge the road and the sight line, not the car.
import { test, expect } from '@playwright/test';
import { openAt, watchConsole, DRIVE_TIMEOUT } from '../helpers/drive.js';

test.describe.configure({ timeout: DRIVE_TIMEOUT });

const ROUTES = ['i15n', 'i15s', 'us93'];
const run = (page, fn, arg) => page.evaluate(fn, arg);
/** Wait until entering is done (the bar no longer says it is loading), then pause. */
const untilEntered = (page) => run(page, async () => {
  const d = window.__skyline.drive;
  while (!d.active() || !d.pose() || document.getElementById('drivebar').classList.contains('busy')) await new Promise((r) => requestAnimationFrame(r));
  d.pause();
  return d.pose();
});
/** Seek, wait until the frame is settled and drawn, and return the pose. */
const seekSettled = (page, at) => run(page, async (a) => {
  const d = window.__skyline.drive;
  d.seek(a);
  await d.whenSettled();
  return d.pose();
}, at);

for (const id of ROUTES) {
  test(`route ${id}: opened cold from its address, speed, seeking, the reveal`, async ({ page }) => {
    const problems = watchConsole(page);
    await openAt(page, `city=lv&mode=drive&route=${id}&view=clean`);
    const entered = await untilEntered(page);
    const route = await run(page, () => window.__skyline.drive.route());

    await test.step('the address opens this route, at its default start', async () => {
      expect(route.id).toBe(id);
      expect(entered.route).toBe(id);
      expect(entered.s).toBeGreaterThanOrEqual(route.starts.reveal - 1);
      expect(entered.s).toBeLessThan(route.starts.reveal + 400); // the clock ran a little before the pause
      expect(await run(page, () => new URLSearchParams(location.search).get('route'))).toBe(id);
      expect(await run(page, () => window.__skyline.drive.pickerState())).toMatchObject({ shown: true, open: false, current: id });
      expect(await run(page, () => window.__skyline.drive.stats().roads.route)).toBe(id);
    });

    await test.step('the car covers the posted speed', async () => {
      // ten seconds at one posted limit (not easing between two): the first such stretch of a few along the route
      const { a, b } = await run(page, (r) => {
        const d = window.__skyline.drive;
        let out = null;
        for (const f of [0.5, 0.3, 0.7, 0.2, 0.8, 0.6, 0.4]) {
          d.seek({ s: r.s0 + (r.s1 - r.s0) * f });
          const a = d.pose();
          d.seek({ t: a.t + 10_000 });
          const b = d.pose();
          out = { a, b };
          if (a.accel === 0 && b.accel === 0 && a.speed === b.speed) break;
        }
        return out;
      }, { s0: route.s0, s1: route.s1 });
      expect(a.accel).toBe(0);
      expect(Math.abs(a.mph - Math.round(a.mph / 5) * 5)).toBeLessThan(1e-6); // a posted limit, in steps of 5 mph
      expect(a.mph).toBeGreaterThanOrEqual(45);
      expect(a.mph).toBeLessThanOrEqual(75);
      expect((b.s - a.s) / 10).toBeGreaterThan(a.speed * 0.98);
      expect((b.s - a.s) / 10).toBeLessThan(a.speed * 1.02);
    });

    await test.step('seeking backward and forward returns identical poses', async () => {
      const [a, b] = await run(page, (r) => {
        const d = window.__skyline.drive;
        const at = r.s0 + (r.s1 - r.s0) * 0.4;
        d.seek({ s: at });
        const a = d.pose();
        d.seek({ s: r.s0 + 100 });
        d.seek({ s: r.s1 - 100 });
        d.seek({ s: at });
        return [a, d.pose()];
      }, { s0: route.s0, s1: route.s1 });
      expect(b).toEqual(a);
    });

    await test.step('the reveal target is hidden shortly before the reveal and in view shortly after', async () => {
      const target = route.reveal.target;
      const seen = async (s) => { await seekSettled(page, { s }); return run(page, (t) => window.__skyline.drive.visible(t), target); };
      expect(await seen(route.reveal.s - 1500)).toBe(false);
      expect(await seen(route.reveal.s + 1500)).toBe(true);
    });

    await test.step('the settle hook resolves', async () => {
      const p = await seekSettled(page, { s: route.s1 - 1000 });
      expect(p.s).toBeCloseTo(route.s1 - 1000, 3);
      expect(await run(page, () => window.__skyline.drive.whenSettled().then(() => 'settled'))).toBe('settled');
    });

    expect(problems).toEqual([]);
  });
}

test('switching i15n -> us93 -> i15s -> i15n leaves GPU memory where it was, and i15n still drives', async ({ page }) => {
  const problems = watchConsole(page);
  await openAt(page, 'city=lv&mode=drive&route=i15n&view=clean');
  await untilEntered(page);
  // every part in and drawn, so what the first frame of each route allocates is counted alike
  const settle = () => run(page, async () => {
    const d = window.__skyline.drive;
    for (let i = 0; i < 1200 && !(d.stats()?.traffic && d.stats()?.lamps && d.stats()?.headlights); i++) await new Promise((r) => setTimeout(r, 50));
    d.pause();
    await d.whenSettled();
    const m = window.__skyline.renderer.info.memory;
    return { geometries: m.geometries, textures: m.textures, route: d.pose().route };
  });
  const before = await settle();
  const seen = [];
  for (const id of ['us93', 'i15s', 'i15n']) {
    await run(page, (r) => window.__skyline.drive.start(r).then(() => window.__skyline.drive.pause()), id);
    const m = await settle();
    expect(m.route).toBe(id);
    seen.push({ id, ...m });
  }
  const after = seen[seen.length - 1];
  test.info().annotations.push({ type: 'memory', description: JSON.stringify({ before, seen }) });
  // each route draws its own chunk meshes and signs: the counts may differ on the way, but not once back on i15n
  expect(Math.abs(after.geometries - before.geometries)).toBeLessThanOrEqual(8);
  expect(Math.abs(after.textures - before.textures)).toBeLessThanOrEqual(2);

  await test.step('i15n still drives', async () => {
    const { a, b } = await run(page, () => {
      const d = window.__skyline.drive;
      d.seek({ s: 30000 });
      const a = d.pose();
      d.seek({ t: a.t + 10_000 });
      return { a, b: d.pose() };
    });
    expect(a.route).toBe('i15n');
    expect((b.s - a.s) / 10).toBeCloseTo(a.speed, 0);
    const p = await seekSettled(page, { s: 50000 });
    expect(p.s).toBeCloseTo(50000, 3);
  });

  expect(problems).toEqual([]);
});
