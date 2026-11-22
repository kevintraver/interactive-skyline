#!/usr/bin/env python3
"""Compose generated, text-free source art with roadside-readable lettering.

Source images and sources.json live in the scratchpad; prompts.json is alongside
this script. Run from the repository root after placing sources there.
"""
import json, math, re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'public/textures/billboards'
SCRATCH = Path('/private/tmp/claude-502/-Users-tyler--t3-worktrees-interactive-skyline-feat-vegas-drive/14f757c3-4362-429e-81b2-2925f7006873/scratchpad/billboards')
FONTS = Path('/System/Library/Fonts/Supplemental')
faces = ['Arial Black.ttf', 'Arial Narrow Bold.ttf', 'Impact.ttf', 'Arial Bold.ttf', 'Georgia Bold.ttf', 'DIN Condensed Bold.ttf']
palettes = [('#fff0a1','#71244d'),('#ffffff','#163b50'),('#fff4dc','#483060'),('#ffe15d','#4d1e4d'),('#fdf5dc','#173856'),('#fce5fc','#422247')]

def fit(text, face, maxw, maxh):
    for size in range(maxh, 9, -1):
        font = ImageFont.truetype(str(FONTS / face), size)
        box = font.getbbox(text, stroke_width=0)
        if box[2]-box[0] <= maxw and box[3]-box[1] <= maxh: return font
    return font

def drawline(im, text, xy, face, maxw, maxh, fill, dark, sw):
    font = fit(text, face, maxw, maxh)
    draw = ImageDraw.Draw(im)
    x,y = xy
    draw.text((x+4,y+5), text, font=font, fill=dark, stroke_width=sw+2, stroke_fill=dark, anchor='lt')
    draw.text((x,y), text, font=font, fill=fill, stroke_width=sw, stroke_fill=dark, anchor='lt')

mapping = json.loads((SCRATCH / 'sources.json').read_text())
manifest = json.loads((OUT / 'manifest.json').read_text())
for i, item in enumerate(manifest['images']):
    w,h = item['w'],item['h']
    img = Image.open(SCRATCH / mapping[item['id']]).convert('RGB')
    img = ImageOps.fit(img, (w,h), method=Image.Resampling.LANCZOS, centering=(.5,.5)).convert('RGBA')
    # Alternate the reading direction to give the set different compositions.
    right = i % 3 == 1
    if right: img = ImageOps.mirror(img)
    # An unobtrusive dark veil holds the main line against complex artwork.
    overlay = Image.new('RGBA',(w,h))
    d = ImageDraw.Draw(overlay)
    panel = (int(w*.43), 8, w, h-8) if right else (0, 8, int(w*.57), h-8)
    d.rounded_rectangle(panel, radius=8 if i%2 else 35, fill=(10,12,30, 165 if i%3 else 135))
    overlay = overlay.filter(ImageFilter.GaussianBlur(12))
    img = Image.alpha_composite(img, overlay)
    lines=item['text']
    # The headline may wrap across two physical lines; the business is its one small line.
    if len(lines) != 3: raise ValueError(item['id'])
    col, dark=palettes[i%len(palettes)]
    maxw=int(w*.54)-24
    lineh=int(h*.285)
    x = int(w*.46) if right else 18
    drawline(img, lines[0], (x,int(h*.12)), faces[i%len(faces)], maxw,lineh,col,dark,3)
    drawline(img, lines[1], (x,int(h*.43)), faces[i%len(faces)], maxw,lineh,col,dark,3)
    drawline(img, lines[2], (x+2,int(h*.81)), 'Arial Narrow Bold.ttf',maxw,int(h*.105),'#ffffff','#171525',1)
    img.convert('RGB').save(OUT/item['file'],'WEBP',quality=85,method=6)
    item['method']='generated artwork, type set in code'
manifest['note']='Fictional advertisements; generated artwork with lettering composed separately.'
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
