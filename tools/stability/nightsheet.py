# Statistics and a contact sheet for night.mjs's pictures: for each night scene the shipped look against the classic
# one on the crop x 0..1180, y 60..660 (mean luma, share brighter than 0.85, share darker than 0.08, mean
# saturation), and a sheet with the classic picture beside the shipped one, night scenes then the dusk sequences.
# usage: uv run --python 3.12 --with numpy --with pillow python tools/stability/nightsheet.py <out>
import sys, os, json
import numpy as np
from PIL import Image, ImageDraw

d = sys.argv[1]
CROP = (0, 60, 1180, 660)


def stats(path):
    a = np.asarray(Image.open(path).convert('RGB').crop(CROP)).astype(np.float32) / 255
    l = a @ [0.2126, 0.7152, 0.0722]
    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 1e-4, (mx - mn) / np.maximum(mx, 1e-4), 0)
    return dict(mean=float(l.mean()), bright=float((l > 0.85).mean()), dark=float((l < 0.08).mean()), sat=float(sat.mean()))


night = ['lv-aerial', 'lv-east', 'lv-strat', 'slc-aerial', 'slc-ensign']
rows, report = [], {}
for v in night:
    c, s = stats(f'{d}/classic-{v}-night.png'), stats(f'{d}/shipped-{v}-night.png')
    r = dict(classic=c, shipped=s, ratio=s['mean'] / c['mean'], bright_pts=100 * (s['bright'] - c['bright']), dark_ratio=s['dark'] / max(c['dark'], 1e-6), sat_ratio=s['sat'] / max(c['sat'], 1e-6))
    r['pass'] = 0.8 <= r['ratio'] <= 1.4 and r['bright_pts'] <= 1.5 and r['dark_ratio'] >= 0.7 and (v != 'lv-strat' or r['sat_ratio'] >= 0.8)
    report[v] = r
    print(f"{v:12} mean {c['mean']:.3f} -> {s['mean']:.3f} (x{r['ratio']:.2f})  >0.85 {100*c['bright']:.1f}% -> {100*s['bright']:.1f}%  <0.08 {100*c['dark']:.0f}% -> {100*s['dark']:.0f}% (x{r['dark_ratio']:.2f})  sat {c['sat']:.2f} -> {s['sat']:.2f}  {'ok' if r['pass'] else 'FAIL'}")
    rows.append((f'{v} night', f'{d}/classic-{v}-night.png', f'{d}/shipped-{v}-night.png'))
for v in ['lv-strat', 'slc-ensign']:
    for alt in [10, 2, -3, -9, -18]:
        p = f'{d}/classic-{v}-dusk{alt}.png'
        if os.path.exists(p):
            rows.append((f'{v} Sun {alt:+d} deg', p, f'{d}/shipped-{v}-dusk{alt}.png'))
            c, s = stats(p), stats(f'{d}/shipped-{v}-dusk{alt}.png')
            print(f"{v:12} sun {alt:+3d}  mean {c['mean']:.3f} -> {s['mean']:.3f}")
json.dump(report, open(f'{d}/night-stats.json', 'w'), indent=1)
W, H = 590, 300
sheet = Image.new('RGB', (2 * W + 10, len(rows) * (H + 22)), (255, 255, 255))
g = ImageDraw.Draw(sheet)
for i, (name, a, b) in enumerate(rows):
    y = i * (H + 22)
    g.text((4, y + 4), f'{name}: classic (left), shipped (right)', fill=(0, 0, 0))
    for j, p in enumerate([a, b]):
        sheet.paste(Image.open(p).convert('RGB').crop(CROP).resize((W, H)), (j * (W + 10), y + 20))
sheet.save(f'{d}/night-sheet.png')
print('sheet', f'{d}/night-sheet.png')
