// Anything that pops open closes on a press outside it or on Escape: the menu, the list, the city list and the
// options. Also the app-wide keyboard shortcuts.
export function initPopovers(app) {
  const menu = document.getElementById('menu');
  const results = document.getElementById('results');
  const search = document.getElementById('search');
  const cityMenu = document.getElementById('city-menu'), cityBtn = document.getElementById('city');
  const form = document.getElementById('settings'), optionsBtn = document.getElementById('options-toggle');
  const POPS = [
    { open: () => !menu.hidden, inside: () => [menu], close: () => app.closeMenu() },
    { open: () => !results.hidden, inside: () => [results, document.getElementById('bar')], close: () => app.browse(false) },
    { open: () => !cityMenu.hidden, inside: () => [cityMenu, cityBtn], close: () => app.openCities(false) },
    { open: () => !form.hidden, inside: () => [form, optionsBtn], close: () => app.openOptions(false) },
  ];
  addEventListener('pointerdown', (ev) => {
    for (const pop of POPS) if (pop.open() && !pop.inside().some((el) => el.contains(ev.target))) pop.close();
  }, true);

  addEventListener('keydown', (ev) => {
    const typing = ev.target instanceof HTMLInputElement;
    if (ev.key === 'Escape') {
      const pop = POPS.find((p) => p.open());
      if (pop) pop.close(); else app.select(null);
    } else if (ev.key === '/' && !typing) { ev.preventDefault(); search.focus(); }
    else if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); app.undo(); }
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && app.selected && menu.hidden && !typing) { ev.preventDefault(); app.apply([app.selected], true); }
  });
}
