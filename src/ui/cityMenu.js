// The city switcher: each city is its own page load, so its terrain and buildings start clean.
export function initCityMenu(app) {
  const { cities, cityId, city } = app;
  const cityBtn = document.getElementById('city'), cityMenu = document.getElementById('city-menu');
  cityBtn.querySelector('span').textContent = city.name;
  for (const [id, c] of Object.entries(cities)) {
    const a = Object.assign(document.createElement('a'), { textContent: c.name, href: `?city=${id}` });
    a.setAttribute('role', 'menuitem');
    if (id === cityId) a.setAttribute('aria-current', 'page');
    cityMenu.append(a);
  }
  function openCities(open) {
    if (open && app.closePopovers) app.closePopovers('cities');
    cityMenu.hidden = !open;
    cityBtn.setAttribute('aria-expanded', String(open));
  }
  cityBtn.addEventListener('click', () => openCities(cityMenu.hidden));
  document.getElementById('search').placeholder = `Search ${city.name} buildings`;
  app.openCities = openCities;
}
