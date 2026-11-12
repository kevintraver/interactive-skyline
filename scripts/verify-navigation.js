(async () => {
  const app = window.__skyline;
  if (!app) throw new Error('Open the skyline app and wait for it to load first.');
  const passed = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    passed.push(message);
  };
  const frame = () => new Promise(requestAnimationFrame);
  async function settled() {
    const deadline = performance.now() + 5000;
    do {
      await frame();
      if (performance.now() > deadline) throw new Error('Camera flight did not settle.');
    } while (app.flying());
    await frame();
  }
  const pose = () => ({ position: app.camera.position.clone(), target: app.controls.target.clone() });
  const same = (a, b) => a.position.distanceTo(b.position) < 0.1 && a.target.distanceTo(b.target) < 0.1;
  const button = (name) => document.querySelector(`[data-nav="${name}"]`);
  async function command(name) {
    const control = button(name);
    if (!control || control.disabled) throw new Error(`Unavailable camera command: ${name}`);
    control.click();
    await settled();
  }
  const presets = [...document.querySelectorAll('.views button')];
  check(presets.length >= 2, 'The city has selectable viewpoints.');
  app.setView(presets[0].dataset.view);
  await settled();
  const initial = pose();
  const firstLabel = presets[0].textContent.trim();
  check(button('home').getAttribute('aria-label').includes(firstLabel), 'Home names the chosen viewpoint.');

  for (const name of ['pan-left', 'pan-right', 'pan-forward', 'pan-back']) {
    app.setView(presets[0].dataset.view);
    const before = pose();
    const right = app.camera.position.clone().set(1, 0, 0).applyQuaternion(app.camera.quaternion);
    right.y = 0;
    right.normalize();
    const forward = app.controls.target.clone().sub(app.camera.position);
    forward.y = 0;
    forward.normalize();
    await command(name);
    const after = pose();
    const shift = after.target.clone().sub(before.target);
    const axis = name.includes('left') || name.includes('right') ? right : forward;
    const sign = name.includes('left') || name.includes('back') ? -1 : 1;
    check(shift.dot(axis) * sign > 1, `${name} moves the view in the expected direction.`);
    check(after.position.distanceTo(before.position) > 1, `${name} moves the camera with its target.`);
  }

  presets.at(-1).click();
  await settled();
  const aerial = pose();
  await command('zoom-in');
  check(app.camera.position.distanceTo(app.controls.target) < aerial.position.distanceTo(aerial.target), 'Zoom in reduces the viewing distance.');
  const closerDistance = app.camera.position.distanceTo(app.controls.target);
  await command('zoom-out');
  check(app.camera.position.distanceTo(app.controls.target) > closerDistance, 'Zoom out increases the viewing distance.');

  for (const name of ['turn-left', 'turn-right', 'tilt-up', 'tilt-down']) {
    presets.at(-1).click();
    await settled();
    const before = pose();
    const angle = name.startsWith('turn') ? app.controls.getAzimuthalAngle() : app.controls.getPolarAngle();
    await command(name);
    const afterAngle = name.startsWith('turn') ? app.controls.getAzimuthalAngle() : app.controls.getPolarAngle();
    check(Math.abs(afterAngle - angle) > 0.01, `${name} changes the camera angle.`);
    check(app.controls.target.distanceTo(before.target) < 0.1, `${name} preserves the orbit target.`);
    const direction = app.controls.target.clone().sub(app.camera.position);
    const heading = ((Math.atan2(direction.x, -direction.z) * 180 / Math.PI) % 360 + 360) % 360;
    check(document.querySelector('#camera-status').textContent === `View heading ${Math.round(heading)} degrees.`, `${name} announces the actual viewing heading.`);
  }
  await command('north');
  check(Math.abs(app.controls.getAzimuthalAngle()) < 0.01, 'Face north restores the north bearing.');
  await command('home');
  check(same(pose(), aerial), 'Home restores the last chosen viewpoint after navigation.');

  const building = app.tall.find((entry) => entry.mesh.visible);
  app.select(building.data.id);
  document.querySelector('#editor [data-act="hide"]').click();
  check(app.hiddenIds().includes(building.data.id), 'The building Hide action still works.');
  await command('pan-left');
  await command('home');
  check(app.hiddenIds().includes(building.data.id), 'Camera home preserves hidden buildings.');
  document.querySelector('#edit-undo').click();
  check(!app.hiddenIds().includes(building.data.id), 'Undo restores the hidden building.');

  presets.at(-1).click();
  await settled();
  for (let i = 0; i < 12; i++) button('zoom-in').click();
  await settled();
  let distance = app.camera.position.distanceTo(app.controls.target);
  check(Number.isFinite(distance) && distance >= app.controls.minDistance - 0.1, 'Repeated zoom input stays within the near limit.');
  button('turn-right').click();
  presets[0].click();
  await settled();
  check(same(pose(), initial), 'Choosing a viewpoint interrupts a camera flight without drifting.');

  const search = document.querySelector('#search');
  for (const element of [search, document.querySelector('input[name="cutoff"]')]) {
    const before = pose();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settled();
    check(same(pose(), before), `Keyboard navigation leaves ${element.id || element.name} input alone.`);
  }
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  document.body.append(editor);
  const beforeEditing = pose();
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
  await settled();
  editor.remove();
  check(same(pose(), beforeEditing), 'Typing in editable content does not move the camera.');

  const beforeShortcut = pose();
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settled();
  check(!same(pose(), beforeShortcut), 'Arrow-key navigation moves the view outside inputs.');
  await command('home');
  const originalNight = app.settings.night;
  document.querySelector('#night').click();
  check(app.settings.night !== originalNight, 'Day and night still switch from the top bar.');
  document.querySelector('#night').click();
  check(search.placeholder === 'Search buildings', 'The search placeholder fits without repeating the city.');
  check([...document.querySelectorAll('[data-nav]')].every((control) => control.getAttribute('aria-label')), 'Every camera control has an accessible name.');

  function atLimit(radius, phi) {
    app.controls.target.set(0, 10000, 0);
    app.camera.position.set(Math.sin(phi) * radius, 10000 + Math.cos(phi) * radius, 0);
    app.controls.update();
    app.invalidate();
  }
  atLimit(app.controls.minDistance, 0.7);
  check(button('zoom-in').disabled, 'Zoom in disables at the near limit.');
  button('zoom-in').click();
  check(app.camera.position.distanceTo(app.controls.target) >= app.controls.minDistance - 0.1, 'The near limit cannot be crossed.');
  atLimit(app.controls.maxDistance, 0.7);
  check(button('zoom-out').disabled, 'Zoom out disables at the far limit.');
  button('zoom-out').click();
  check(app.camera.position.distanceTo(app.controls.target) <= app.controls.maxDistance + 0.1, 'The far limit cannot be crossed.');
  atLimit(2000, app.controls.maxPolarAngle);
  check(button('tilt-up').disabled, 'Tilting up disables at the upper limit.');
  atLimit(2000, Math.max(0.05, app.controls.minPolarAngle));
  check(button('tilt-down').disabled, 'Tilting down disables at the lower limit.');
  app.setView(presets[0].dataset.view);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    button('pan-left').click();
    check(!app.flying(), 'Reduced-motion navigation completes without a flight.');
    await command('home');
  }
  return { city: document.title, checks: passed.length, passed };
})()
