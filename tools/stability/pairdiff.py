# The two pictures pair.mjs saved for each building, side by side with their difference (4 x 4 blocks whose mean
# luma moved by more than 22, the survey's test, in red), and the count.
# usage: uv run --python 3.12 --with numpy --with pillow python tools/stability/pairdiff.py <out>/pair
import sys, glob, os
import numpy as np
from PIL import Image

d = sys.argv[1]
for a in sorted(glob.glob(os.path.join(d, '*-A.png'))):
    b = a[:-6] + '-B.png'
    A = np.asarray(Image.open(a).convert('RGB')).astype(np.float32)
    B = np.asarray(Image.open(b).convert('RGB')).astype(np.float32)
    h, w = (A.shape[0] // 4) * 4, (A.shape[1] // 4) * 4
    la = (A[:h, :w] @ [0.2126, 0.7152, 0.0722]).reshape(h // 4, 4, w // 4, 4).mean((1, 3))
    lb = (B[:h, :w] @ [0.2126, 0.7152, 0.0722]).reshape(h // 4, 4, w // 4, 4).mean((1, 3))
    flip = np.abs(la - lb) > 22
    mark = A[:h, :w].copy()
    m = np.kron(flip, np.ones((4, 4), bool))
    mark[m] = [255, 0, 0]
    Image.fromarray(np.concatenate([A[:h, :w], mark], 1).astype(np.uint8)).save(a[:-6] + '-diff.png')
    print(os.path.basename(a)[:-6], int(flip.sum()))
