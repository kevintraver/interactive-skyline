import sys, os, glob, json, numpy as np
from PIL import Image, ImageFilter
root = sys.argv[1]
def load(p):
    im = Image.open(p).convert('RGB')
    return np.asarray(im).astype(np.int16), np.asarray(im.convert('L').filter(ImageFilter.BoxBlur(2))).astype(np.float32)
for d in sorted(glob.glob(f'{root}/*/*/')):
    if not os.path.exists(d + 'info.json'): continue
    info = json.load(open(d + 'info.json')); name = '/'.join(d.rstrip('/').split('/')[-2:])
    rows = []
    for p in info['poses']:
        i = f"{p['i']:03d}"
        try: m, s, e = load(d + i + '-m.png'), load(d + i + '-s.png'), load(d + i + '-e.png')
        except FileNotFoundError: continue
        lag = np.abs(m[1] - s[1]); mic = np.abs(s[1] - e[1])
        rows.append(dict(i=p['i'], leg=p['leg'], dist=p['dist'], polar=p['polarDeg'],
            lag_pct=round(float((lag > 10).mean() * 100), 2), lag_gain=round(float(m[1].mean() / max(s[1].mean(), 1)), 3),
            micro_pct=round(float((mic > 20).mean() * 100), 3), micro_mean=round(float(mic.mean()), 2), lum=round(float(s[1].mean()), 1),
            black_pct=round(float((s[0].max(-1) < 4).mean() * 100), 1)))
    json.dump(rows, open(d + 'metrics.json', 'w'), indent=1)
    L = np.array([r['lag_pct'] for r in rows]); M = np.array([r['micro_pct'] for r in rows]); G = np.array([r['lag_gain'] for r in rows])
    print(f"== {name} ({info['start']['backend']}) poses={len(rows)} errors={len(info['errors'])}")
    print(f"   moving vs settled: px off >10 levels  median {np.median(L):.2f}%  max {L.max():.2f}% (pose {rows[int(L.argmax())]['i']} {rows[int(L.argmax())]['leg']})   brightness ratio min/max {G.min():.3f}/{G.max():.3f}")
    print(f"   sub-pixel nudge:   px off >20 levels  median {np.median(M):.3f}%  max {M.max():.3f}% (pose {rows[int(M.argmax())]['i']} {rows[int(M.argmax())]['leg']})")
    top = sorted(rows, key=lambda r: -r['micro_pct'])[:4]
    print('   worst nudge poses:', [(r['i'], r['leg'], r['micro_pct'], r['dist'], r['polar']) for r in top])
    topl = sorted(rows, key=lambda r: -r['lag_pct'])[:4]
    print('   worst moving poses:', [(r['i'], r['leg'], r['lag_pct'], r['lag_gain']) for r in topl])
    blk = [(r['i'], r['leg'], r['black_pct']) for r in rows if r['black_pct'] > 20]
    if blk: print('   mostly black frames:', blk[:8])
    if info['errors']: print('   console:', info['errors'][:3])
