// The cabin's two displays (plan 02, D4.5), drawn on canvases that become textures on the model's
// Instruments and CenterScreen faces: the instrument cluster (speed in the visitor's units, the city's local
// time, the outside temperature when the environment has one) and a plain route display (the route's line,
// the car's place on it, the next exit). Generic and original: no logo, no product's look.
//
// instrumentText and screenText are pure, so the unit tests pin every string; the drawing only places them.
// Canvases are drawn with u to the right and v up as the driver reads them (cabin.json "displaysNote").

import { MPH, formatClock, formatDistance } from '../ui/format.js';
import { nextExit, markerLabel } from '../ui/track.js';
import { routeShape } from '../ui/routemap.js';

/**
 * What the instrument cluster shows.
 * @param {{ speed: number, simMs: number, tz: string, units: 'ft'|'m', tempC?: number|null }} st
 *   speed m/s; tempC null or missing when the environment offers no temperature
 * @returns {{ speed: string, unit: string, clock: string, temp: string|null }}
 */
export function instrumentText({ speed, simMs, tz, units, tempC = null }) {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  const metric = units === 'm';
  const clock = Number.isFinite(simMs) ? formatClock(simMs, tz) : '';
  let temp = null;
  if (Number.isFinite(tempC)) temp = metric ? `${Math.round(tempC)}°C` : `${Math.round(tempC * 1.8 + 32)}°F`;
  return { speed: String(Math.round(metric ? v * 3.6 : v / MPH)), unit: metric ? 'km/h' : 'mph', clock, temp };
}

/**
 * What the route display says: the next exit ahead and how far, or the destination once past the last.
 * @param {{ s: number, s1: number, markers: object[], to?: string, units: 'ft'|'m' }} st
 * @returns {{ title: string, dist: string, foot: string }}
 */
export function screenText({ s, s1, markers, to, units }) {
  const next = nextExit(markers, s);
  if (next) {
    const name = markerLabel(next);
    return { title: name, dist: formatDistance(next.s - s, units), foot: to ? `To ${to}` : '' };
  }
  const left = Math.max(0, s1 - s);
  return { title: to || 'Destination', dist: left > 30 ? formatDistance(left, units) : 'Arrived', foot: '' };
}

const FONT = '"Inter", "Helvetica Neue", Arial, sans-serif';

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Text squeezed to a width, the font shrunk until it fits. */
function fitText(g, text, x, y, maxW, size, weight, align = 'left') {
  let px = size;
  g.textAlign = align;
  for (; px > 10; px -= 2) {
    g.font = `${weight} ${px}px ${FONT}`;
    if (g.measureText(text).width <= maxW) break;
  }
  g.fillText(text, x, y);
}

/**
 * The instrument cluster: a canvas 3:1 like the face (0.3 x 0.1 m).
 * @returns {{ canvas: HTMLCanvasElement, draw: (t: ReturnType<typeof instrumentText>, night: number) => void }}
 */
export function createInstrumentCanvas() {
  const W = 600, H = 200;
  const canvas = canvasOf(W, H);
  const g = canvas.getContext('2d');
  return {
    canvas,
    draw(t, night = 0) {
      // a near-black face, the numbers warm white; the accent ring dims with the night
      g.fillStyle = '#05070a';
      g.fillRect(0, 0, W, H);
      const ink = '#eef1f4', muted = '#8f99a3';
      // the speed arc behind the number, a quiet gauge of 0..max
      const max = t.unit === 'km/h' ? 200 : 120;
      const frac = Math.min(1, (+t.speed || 0) / max);
      const cx = W / 2, cy = H * 0.98, r = H * 0.82;
      g.lineCap = 'round';
      g.lineWidth = 7;
      g.strokeStyle = '#1b222a';
      g.beginPath(); g.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
      g.strokeStyle = night > 0.5 ? '#3f86c7' : '#5aa3e6';
      g.beginPath(); g.arc(cx, cy, r, Math.PI * 1.08, Math.PI * (1.08 + 0.84 * frac)); g.stroke();
      g.fillStyle = ink;
      g.textBaseline = 'alphabetic';
      fitText(g, t.speed, cx, H * 0.7, 220, 112, 650, 'center');
      g.fillStyle = muted;
      fitText(g, t.unit, cx, H * 0.9, 160, 30, 500, 'center');
      // the local time on the left, the temperature (when there is one) on the right
      g.fillStyle = ink;
      fitText(g, t.clock, 28, H * 0.58, 150, 38, 600, 'left');
      if (t.temp) fitText(g, t.temp, W - 28, H * 0.58, 130, 38, 600, 'right');
    },
  };
}

/**
 * The route display: the route's line north up on the left, the next exit on the right. A canvas about 7:4
 * like the face (0.27 x 0.155 m).
 * @returns {{ canvas: HTMLCanvasElement, setRoute: (road: object, route: object) => void,
 *            draw: (t: ReturnType<typeof screenText>, s: number, night: number) => void }}
 */
export function createScreenCanvas() {
  const W = 560, H = 320;
  const canvas = canvasOf(W, H);
  const g = canvas.getContext('2d');
  const MAP = H - 40; // the square map's side, with a margin
  let shape = null, path = null, done = null, lastS = null, s0 = 0;
  return {
    canvas,
    setRoute(road, route) {
      shape = null; path = null;
      if (!road || !route) return;
      s0 = route.s0 ?? 0;
      try {
        shape = routeShape(road, { s0: route.s0, s1: route.s1, size: MAP, pad: 16, tol: 4 });
        path = new Path2D(shape.d);
      } catch { shape = null; }
      done = null; lastS = null;
    },
    draw(t, s, night = 0) {
      g.fillStyle = '#0a0d11';
      g.fillRect(0, 0, W, H);
      const ox = 20, oy = 20;
      g.fillStyle = '#10151b';
      g.fillRect(ox, oy, MAP, MAP);
      if (shape && path) {
        g.save();
        g.translate(ox, oy);
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = '#3a4653'; g.lineWidth = 6;
        g.stroke(path);
        // the part already driven, brighter: the route's line up to the car, re-traced when the car moves
        if (s !== lastS) {
          lastS = s;
          done = new Path2D();
          const n = Math.max(1, Math.ceil((s - s0) / 150));
          for (let i = 0; i <= n; i++) {
            const [x, y] = shape.at(s0 + ((s - s0) * i) / n);
            if (i) done.lineTo(x, y); else done.moveTo(x, y);
          }
        }
        g.strokeStyle = night > 0.5 ? '#3f86c7' : '#5aa3e6'; g.lineWidth = 6;
        g.stroke(done);
        const [x, y] = shape.at(s);
        g.fillStyle = '#ffffff';
        g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#5aa3e6';
        g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      // the text column
      const tx = ox + MAP + 22, tw = W - tx - 20;
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#8f99a3';
      fitText(g, t.title.startsWith('Exit') ? 'Next exit' : 'Ahead', tx, 62, tw, 24, 500);
      g.fillStyle = '#eef1f4';
      // the name over up to three lines
      const words = t.title.split(' ');
      const lines = [];
      g.font = `600 30px ${FONT}`;
      for (const w of words) {
        const cur = lines[lines.length - 1];
        if (cur && g.measureText(`${cur} ${w}`).width <= tw) lines[lines.length - 1] = `${cur} ${w}`;
        else lines.push(w);
      }
      lines.slice(0, 3).forEach((l, i) => fitText(g, l, tx, 104 + i * 38, tw, 30, 600));
      g.fillStyle = '#eef1f4';
      fitText(g, t.dist, tx, 250, tw, 44, 650);
      if (t.foot) { g.fillStyle = '#8f99a3'; fitText(g, t.foot, tx, 290, tw, 22, 500); }
    },
  };
}
