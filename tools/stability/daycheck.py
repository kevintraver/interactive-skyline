# Mean luma of the day scenes in two night.mjs runs (before, after) on the goldens' crop: a change to the night must
# leave each within 3 %.
# usage: uv run --python 3.12 --with numpy --with pillow python tools/stability/daycheck.py <before> <after> [label]
import sys
import numpy as np
from PIL import Image
CROP = (0, 60, 1180, 660)
a, b = sys.argv[1], sys.argv[2]
label = sys.argv[3] if len(sys.argv) > 3 else 'shipped'
worst = 0
for v in ['lv-aerial', 'lv-east', 'lv-strat', 'slc-aerial', 'slc-ensign']:
    m = [float((np.asarray(Image.open(f'{d}/{label}-{v}-day.png').convert('RGB').crop(CROP)).astype(np.float32) / 255 @ [0.2126, 0.7152, 0.0722]).mean()) for d in (a, b)]
    worst = max(worst, abs(m[1] / m[0] - 1))
    print(f'{v:12} day mean {m[0]:.4f} -> {m[1]:.4f} ({100 * (m[1] / m[0] - 1):+.1f} %)')
print(f'worst {100 * worst:.1f} %', 'ok' if worst <= 0.03 else 'FAIL')
