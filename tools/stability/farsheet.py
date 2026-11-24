# A contact sheet of chosen poses from poses.mjs (settled frames), to look at far-out views.
# usage: uv run --python 3.12 --with pillow python tools/stability/farsheet.py <poses dir: out/label/city-light> <out.png> <pose...>
import sys, json
from PIL import Image, ImageDraw
d, out, ids = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3:]]
info = {p['i']: p for p in json.load(open(f'{d}/info.json'))['poses']}
W, H = 640, 400
sheet = Image.new('RGB', (W * 4, ((len(ids) + 3) // 4) * (H + 16)), (255, 255, 255))
g = ImageDraw.Draw(sheet)
for k, i in enumerate(ids):
    x, y = (k % 4) * W, (k // 4) * (H + 16)
    sheet.paste(Image.open(f'{d}/{i:03d}-s.png').convert('RGB').resize((W, H)), (x, y + 16))
    p = info[i]
    g.text((x + 4, y + 2), f"pose {i} {p['leg']} dist={p['dist']} polar={p['polarDeg']} cam={p['cam']}", fill=(0, 0, 0))
sheet.save(out)
