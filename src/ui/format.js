// How heights, names and counts are written, in the units the visitor chose.
const M_TO_FT = 3.28084;

export function createFormat(settings, city) {
  const SOURCE = {
    'osm-height': 'tagged in OpenStreetMap',
    lidar: `measured from ${city.lidar.year} USGS LiDAR`,
    'osm-levels': 'estimated from floor count',
    guess: 'unknown, assumed',
  };
  const inFeet = (m) => `${Math.round(m * M_TO_FT).toLocaleString()} ft`;
  const inMeters = (m) => `${Math.round(m * 10) / 10} m`;
  const fmt = (m) => (settings.units === 'm' ? inMeters(m) : inFeet(m));
  const fmtOther = (m) => (settings.units === 'm' ? inFeet(m) : inMeters(m));
  const label = (b) => b.name || 'Unnamed building';
  const details = (b) => `${fmt(b.h)} · ${fmtOther(b.h)}${b.levels ? ` · ${b.levels} floors` : ''}`;
  const plural = (n) => `${n} building${n === 1 ? '' : 's'}`;
  return { SOURCE, fmt, fmtOther, label, details, plural };
}
