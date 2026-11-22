// About the data: every source the map and the drive are built from, with its licence as the repository records it
// (README.md, the reports in data/derived/lv/ and the sidecars in public/data/lv/). Opened from the Settings popover
// and from the corner label, in Map and in Drive. Loaded by its own script tag in index.html; it needs nothing from
// the app, so main.js does not know about it.
//
// `licence` is null where the repository names no licence for a source: the source is credited and nothing is
// claimed for it.

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const ODBL = 'https://opendatacommons.org/licenses/odbl/';

/** @typedef {{ name: string, use: string, url: string, licence: string|null, licenceUrl?: string }} Credit */

/** @type {{ title: string, items: Credit[] }[]} */
export const CREDITS = [
  {
    title: 'The map',
    items: [
      { name: '© OpenStreetMap contributors', use: 'Building footprints, names and tagged heights', url: OSM_COPYRIGHT, licence: 'ODbL 1.0', licenceUrl: ODBL },
      { name: 'U.S. Geological Survey, 3DEP LiDAR', use: 'Measured building heights', url: 'https://www.usgs.gov/3d-elevation-program', licence: 'Public domain' },
      { name: 'U.S. Geological Survey, 3DEP elevation, via AWS Terrain Tiles', use: 'Terrain', url: 'https://registry.opendata.aws/terrain-tiles/', licence: 'Public domain' },
      { name: 'NAIP aerial photography, via USGS', use: 'Ground imagery', url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer', licence: 'Public domain' },
    ],
  },
  {
    title: 'Drive (Las Vegas)',
    items: [
      { name: '© OpenStreetMap contributors', use: 'Roads, lanes and exits, sign destinations, barriers, some billboards and street lamps, building footprints', url: OSM_COPYRIGHT, licence: 'ODbL 1.0', licenceUrl: ODBL },
      { name: 'Overture Maps Foundation', use: 'Building heights, and footprints from OpenStreetMap and Microsoft Global ML Building Footprints', url: 'https://docs.overturemaps.org/attribution/', licence: 'ODbL 1.0', licenceUrl: ODBL },
      { name: 'U.S. Geological Survey, 3DEP elevation (via AWS Terrain Tiles) and NAIP imagery', use: 'The wide ground around the routes, and the finer patch at Hoover Dam', url: 'https://www.usgs.gov/3d-elevation-program', licence: 'Public domain' },
      { name: 'FHWA Travel Monitoring Analysis System, 2025, via the BTS National Transportation Atlas', use: 'Hourly traffic counts', url: 'https://www.arcgis.com/home/item.html?id=5a9462b519854ec6a2334b3c0bdfc3c1', licence: null },
      { name: 'Nevada Department of Transportation', use: 'Annual traffic counts (TRINA, 2025) and truck shares (2023)', url: 'https://gis.dot.nv.gov/arcgis/rest/services/Applications/TRINA/MapServer/1', licence: null },
      { name: 'Clark County Public Works', use: 'Street lights', url: 'https://services2.arcgis.com/MLoS3Qx4BXmDoTIY/arcgis/rest/services/Fixtures_View/FeatureServer/0', licence: 'No licence stated; used with this credit' },
      { name: 'City of Las Vegas', use: 'Street lights', url: 'https://services1.arcgis.com/F1v0ufATbBQScMtY/arcgis/rest/services/stlights/FeatureServer/0', licence: 'No licence stated; used with this credit' },
      { name: 'City of Henderson, via its lighting contractor’s public layer', use: 'Street lights', url: 'https://services6.arcgis.com/clPWQMwZfdWn4MQZ/arcgis/rest/services/HendersonPublish/FeatureServer/125', licence: 'No licence stated; used with this credit' },
      { name: 'Boulder City', use: 'Street lights', url: 'https://services6.arcgis.com/ENlYDFfLXlpg7FOQ/arcgis/rest/services/Dark_Skies_Light_Replacement_view/FeatureServer/0', licence: 'No licence stated; used with this credit' },
      { name: 'City of Las Vegas; Clark County, Nevada', use: 'Billboard positions', url: 'https://services1.arcgis.com/F1v0ufATbBQScMtY/arcgis/rest/services/CLV_Billboards/FeatureServer', licence: null },
    ],
  },
];

/** What the drive draws by rule rather than from data, said once under the list. */
export const MADE_HERE = 'Sign faces, billboard and screen faces, vehicles and the cabin are drawn by this project. '
  + 'They carry no trade names or logos.';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

/** The dialog's body, as HTML. */
export function creditsHtml(groups = CREDITS) {
  return groups.map((g) => `<h3>${esc(g.title)}</h3><ul>${g.items.map((c) => `<li>${link(c.url, c.name)}`
    + `<span class="use">${esc(c.use)}${c.licence ? ` · ${c.licenceUrl ? link(c.licenceUrl, c.licence) : esc(c.licence)}` : ''}</span></li>`).join('')}</ul>`).join('')
    + `<p class="note">${esc(MADE_HERE)}</p>`;
}

/** Build the dialog and wire its two openers: the Settings popover's link and the corner label's. */
export function initCredits() {
  const el = document.createElement('div');
  el.id = 'credits';
  el.className = 'pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-labelledby', 'credits-title');
  el.hidden = true;
  el.innerHTML = `<div class="head"><h2 id="credits-title">About the data</h2>`
    + `<button class="x" type="button" aria-label="Close"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#i-x" /></svg></button></div>`
    + `<div class="body">${creditsHtml()}</div>`;
  document.body.append(el);

  const openers = [...document.querySelectorAll('[data-credits]')];
  const form = document.getElementById('settings'), optionsBtn = document.getElementById('options-toggle');
  let returnTo = null;

  function open(on, from = null) {
    if (on === !el.hidden) return;
    el.hidden = !on;
    for (const b of openers) b.setAttribute('aria-expanded', String(on));
    if (on) {
      returnTo = from;
      // it takes the Settings popover's place (settingsPanel.js's openOptions does the same two things)
      if (form && !form.hidden) { form.hidden = true; optionsBtn?.setAttribute('aria-expanded', 'false'); }
      el.querySelector('.x').focus({ preventScroll: true });
    } else if (returnTo?.isConnected && returnTo.offsetParent !== null) returnTo.focus({ preventScroll: true });
  }

  for (const b of openers) {
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-controls', 'credits');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => open(el.hidden, b));
  }
  el.querySelector('.x').addEventListener('click', () => open(false));
  // closes like the app's other popovers: on a press outside it and on Escape (ui/popovers.js), before they act
  addEventListener('pointerdown', (ev) => {
    if (!el.hidden && !el.contains(ev.target) && !openers.some((b) => b.contains(ev.target))) open(false);
  }, true);
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || el.hidden) return;
    ev.stopImmediatePropagation();
    open(false);
  }, true);
  return { open, el };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initCredits(), { once: true });
  else initCredits();
}
