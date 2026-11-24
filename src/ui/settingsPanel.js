// Map options (#settings) and the day/night button: settings are pushed into the scene and the interface here.
import { DEFAULTS, saveSettings } from '../app/settings.js';

export function initSettingsPanel(app) {
  const { settings, model, city, terrain, sky, canvas, format: { fmt, plural } } = app;
  const form = document.getElementById('settings');
  const optionsBtn = document.getElementById('options-toggle');
  const nightBtn = document.getElementById('night');
  const cutoffOut = document.getElementById('cutoff-out');
  const hint = document.getElementById('hint');

  /** Rebuild the towers and the list after the cutoff changes. Hidden towers that are still removable stay hidden. */
  function rebuild() {
    app.hovered = app.selected = null;
    app.select(null);
    canvas.classList.remove('grab');
    app.history.length = 0;
    app.hideToast();
    app.buildings.build();
    app.buildList();
    app.tall.forEach(app.paint);
    app.refresh();
    app.events.emit('buildings:rebuilt', () => ({ tall: app.tall }));
  }

  function describeCutoff(m) {
    const n = model.buildings.filter((b) => b.h >= m).length;
    cutoffOut.textContent = `${fmt(m)} · ${plural(n)}`;
  }

  /** Push the settings into the scene and the panel. `changed` is the key that just changed, or null for all. */
  function applySettings(changed = null) {
    if (changed === null || changed === 'cutoff') rebuild();
    if (changed === 'units') { app.buildList(); if (app.selected) app.select(app.selected); }
    if (changed === null || changed === 'imagery') {
      for (const t of terrain) {
        t.mesh.material.map = t.mesh.material.emissiveMap = settings.imagery ? t.map : null;
        t.mesh.material.color.set(settings.imagery ? 0xffffff : 0xbdb9ad);
        t.mesh.material.needsUpdate = true;
      }
    }
    if (changed === null || changed === 'night' || changed === 'imagery') sky.apply({ night: app.nightNow(), imagery: settings.imagery, terrain }); // drive seam
    if (changed === 'night' && app.look) app.look.seek(false); // a new pinned look is a seek for the exposure (T2.6)
    app.tall.forEach(app.paint);
    hint.querySelector('b').textContent = `Click a ${settings.highlight ? 'blue' : 'tall'} building to hide or move it.`;
    // the interface goes dark with the sky
    document.documentElement.dataset.theme = app.nightNow() ? 'dark' : 'light'; // drive seam
    nightBtn.setAttribute('aria-pressed', String(settings.night));
    // pinned: switch between the two looks; in the clock state the button pins the look opposite the real sky
    nightBtn.title = settings.night ? 'Switch to day' : 'Switch to night';
    nightBtn.setAttribute('aria-label', nightBtn.title);
    nightBtn.querySelector('use').setAttribute('href', settings.night ? '#i-sun' : '#i-moon');
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = settings[el.name];
      else if (el.type === 'radio') el.checked = settings[el.name] === el.value;
      else el.value = settings[el.name];
    }
    describeCutoff(settings.cutoff);
    applyDisplay(changed);
    app.refresh();
  }

  // plan 01, T2.7: quality, exposure and reduce flashes (the new renderer only; the classic one ignores them)
  const qualityOut = document.getElementById('quality-out'), exposureOut = document.getElementById('exposure-out');
  function applyDisplay(changed) {
    const q = app.quality;
    if (q && (changed === null || changed === 'quality')) {
      // ?q= (the landmark checker, the bench) wins at start-up; a choice made in #settings replaces it
      if (changed === 'quality') q.urlChoice = null;
      const r = q.set(q.urlChoice || (q.classic ? 'high' : settings.quality));
      if (!r.ok) { settings.quality = q.choice; saveSettings(settings); for (const el of form.elements.quality || []) el.checked = el.value === q.choice; }
    }
    if (app.look && (changed === null || changed === 'exposureMode' || changed === 'exposureComp')) {
      app.look.exposure.setMode(settings.exposureMode);
      app.look.exposure.setCompensation(Number(settings.exposureComp) || 0);
      app.invalidate();
    }
    if (q) {
      const name = (l) => l[0].toUpperCase() + l.slice(1);
      qualityOut.textContent = q.message || (q.choice === 'auto' ? `Detected: ${name(q.level)}` : name(q.level));
      qualityOut.title = q.detected ? q.detected.reasons.join('; ') : '';
    }
    const ev = Number(settings.exposureComp) || 0;
    exposureOut.textContent = ev === 0 ? 'Automatic' : `${ev > 0 ? '+' : '\u2212'}${Math.abs(ev)} EV`;
    document.documentElement.classList.toggle('reduce-flashes', !!settings.reduceFlashes);
  }

  function setSetting(key, value) {
    // in the clock state `night` is derived from the Sun; writing it always selects a pinned look (plan 01, 5.6)
    if (key === 'night' && app.env && app.env.mode === 'clock') {
      app.env.pin(!!value);
      saveSettings(settings);
      applySettings('night');
      return;
    }
    if (settings[key] === value) return;
    settings[key] = value;
    saveSettings(settings);
    applySettings(key);
  }
  form.addEventListener('input', (ev) => { if (ev.target.name === 'cutoff') describeCutoff(Number(ev.target.value)); });
  form.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el.name) return;
    setSetting(el.name, el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value);
  });
  document.getElementById('settings-reset').addEventListener('click', () => {
    Object.assign(settings, DEFAULTS);
    saveSettings(settings);
    applySettings();
  });
  nightBtn.addEventListener('click', () => setSetting('night', !settings.night));
  function openOptions(open) {
    if (open && app.closePopovers) app.closePopovers('settings');
    form.hidden = !open;
    optionsBtn.setAttribute('aria-expanded', String(open));
  }
  optionsBtn.addEventListener('click', () => openOptions(form.hidden));

  const counts = model.buildings.reduce((a, b) => ((a[b.src] = (a[b.src] || 0) + 1), a), {});
  document.getElementById('about').textContent =
    `${model.buildings.length.toLocaleString()} footprints from OpenStreetMap. Heights: ${(counts.lidar || 0).toLocaleString()} measured from USGS 3DEP LiDAR (${city.lidar.year}), `
    + `${counts['osm-height'] || 0} tagged, ${((counts['osm-levels'] || 0) + (counts.guess || 0)).toLocaleString()} estimated (marked ~). Terrain: USGS 3DEP, imagery USGS NAIP. True scale, 50 mm lens.`;
  Object.assign(app, { applySettings, setSetting, openOptions });
}
