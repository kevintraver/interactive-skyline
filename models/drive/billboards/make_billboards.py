#!/usr/bin/env python3
"""Compose fictional roadside advertisements from repository-owned, text-free art."""
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'public/textures/billboards'
ART = Path(__file__).resolve().parent / 'art'
LAYOUTS = ('top-band', 'bottom-band', 'slanted-panel', 'outlined',
           'starburst', 'ribbon', 'split-card', 'top-stripe')
FACES = ('Impact.ttf', 'Arial Black.ttf', 'Arial Narrow Bold.ttf', 'Georgia Bold.ttf')
PALETTES = (('#f8df43', '#21204d', '#e34a34'), ('#fff8d3', '#9c183e', '#f4ad2e'),
            ('#ffffff', '#134555', '#ee6c39'), ('#fff3be', '#502263', '#e24978'),
            ('#ffffff', '#203062', '#ecb52b'), ('#fff7dd', '#71362c', '#43b8ad'),
            ('#fff264', '#17335b', '#d94c36'), ('#ffffff', '#442065', '#f06935'))
FONT_DIRS = (Path('/System/Library/Fonts/Supplemental'), Path('/Library/Fonts'),
             Path('/usr/share/fonts/truetype/dejavu'), Path('/usr/share/fonts/truetype/liberation2'))


def font_for(face, size):
    for name in (face, 'DejaVuSansCondensed-Bold.ttf', 'LiberationSans-Bold.ttf'):
        for directory in FONT_DIRS:
            try:
                return ImageFont.truetype(str(directory / name), size)
            except OSError:
                pass
    return ImageFont.load_default()


def line(draw, text, box, face, color, outline, align='left', stroke=2):
    x0, y0, x1, y1 = box
    for size in range(int((y1-y0)*1.5), 7, -1):
        font = font_for(face, size)
        bounds = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
        if bounds[2]-bounds[0] <= x1-x0-8 and bounds[3]-bounds[1] <= (y1-y0)*.78-6:
            break
    width = bounds[2]-bounds[0]
    x = x0+5 if align == 'left' else (x1-x0-width)/2+x0
    y = y0 + ((y1-y0)-(bounds[3]-bounds[1]))/2
    draw.text((x+3, y+4), text, font=font, fill=outline, stroke_width=stroke+2, stroke_fill=outline, anchor='lt')
    draw.text((x, y), text, font=font, fill=color, stroke_width=stroke, stroke_fill=outline, anchor='lt')


def star(cx, cy, rx, ry):
    return [(cx + math.cos(math.pi*i/12)*rx*(1 if i%2 == 0 else .77),
             cy + math.sin(math.pi*i/12)*ry*(1 if i%2 == 0 else .77)) for i in range(24)]


def compose(item, index):
    w, h = item['w'], item['h']
    image = ImageOps.fit(Image.open(ART / (item['id']+'.webp')).convert('RGB'), (w,h), method=Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(image)
    layout = LAYOUTS[index % len(LAYOUTS)]
    light, dark, accent = PALETTES[index % len(PALETTES)]
    face = FACES[(index // 2) % len(FACES)]
    a,b,c = item['text']
    if layout == 'top-band':
        draw.rectangle((0,0,w,h*.57), fill=dark)
        draw.rectangle((0,h*.56,w,h*.59), fill=accent)
        line(draw,a,(10,3,w-10,h*.28),face,light,dark,'center',2)
        line(draw,b,(10,h*.27,w-10,h*.56),face,light,dark,'center',2)
        draw.rectangle((w*.28,h*.84,w*.72,h), fill=accent)
        line(draw,c,(w*.28,h*.84,w*.72,h), 'Arial Narrow Bold.ttf', '#ffffff',dark,'center',1)
    elif layout == 'top-stripe':
        draw.rectangle((0, 0, w, h*.22), fill=accent)
        line(draw, c, (10, 0, w-10, h*.22), 'Arial Narrow Bold.ttf', '#ffffff', dark, 'center', 1)
        line(draw, a, (w*.02, h*.25, w*.98, h*.55), face, light, '#101027', 'center', 4)
        line(draw, b, (w*.02, h*.57, w*.98, h*.90), face, light, '#101027', 'center', 4)
    elif layout == 'bottom-band':
        draw.rectangle((0,h*.28,w,h),fill=dark)
        draw.rectangle((0,h*.26,w,h*.29),fill=accent)
        line(draw,a,(10,h*.29,w-10,h*.56),face,light,dark,'center',2)
        line(draw,b,(10,h*.55,w-10,h*.82),face,light,dark,'center',2)
        line(draw,c,(10,h*.83,w-10,h*.99),'Arial Narrow Bold.ttf','#ffffff',dark,'center',1)
    elif layout in ('slanted-panel', 'split-card'):
        if layout == 'slanted-panel':
            draw.polygon([(0,0),(w*.68,0),(w*.57,h),(0,h)],fill=dark)
            draw.polygon([(w*.68,0),(w*.70,0),(w*.59,h),(w*.57,h)],fill=accent)
        else:
            draw.rectangle((0,0,w*.62,h),fill=dark)
            draw.rectangle((0,h*.78,w*.62,h),fill=accent)
            draw.rectangle((w*.60,0,w*.62,h*.78),fill=accent)
        line(draw,a,(10,h*.08,w*.56,h*.37),face,light,dark,'left',2)
        line(draw,b,(10,h*.38,w*.56,h*.69),face,light,dark,'left',2)
        line(draw,c,(10,h*.79,w*.56,h*.96),'Arial Narrow Bold.ttf','#ffffff',dark,'left',1)
    elif layout == 'outlined':
        line(draw,a,(w*.02,h*.08,w*.98,h*.38),face,light,'#101027','center',5)
        line(draw,b,(w*.02,h*.39,w*.98,h*.70),face,light,'#101027','center',5)
        line(draw,c,(w*.12,h*.78,w*.88,h*.96),'Arial Narrow Bold.ttf','#ffffff','#101027','center',3)
    elif layout == 'starburst':
        draw.polygon(star(w*.79,h*.71,w*.20,h*.27),fill=accent,outline=light,width=4)
        line(draw,a,(w*.02,h*.08,w*.75,h*.36),face,light,'#101027','left',4)
        line(draw,b,(w*.02,h*.39,w*.72,h*.68),face,light,'#101027','left',4)
        line(draw,c,(w*.63,h*.63,w*.95,h*.80),'Arial Narrow Bold.ttf','#ffffff',dark,'center',2)
    else:
        draw.polygon([(0,h*.07),(w*.65,h*.07),(w*.70,h*.14),(w*.65,h*.21),(0,h*.21),(w*.025,h*.14)],fill=accent)
        line(draw,c,(w*.025,h*.07,w*.65,h*.21),'Arial Narrow Bold.ttf','#ffffff',dark,'center',1)
        line(draw,a,(w*.02,h*.25,w*.72,h*.54),face,light,'#101027','left',4)
        line(draw,b,(w*.02,h*.56,w*.72,h*.88),face,light,'#101027','left',4)
    image.save(OUT / item['file'],'WEBP',quality=88,method=6)
    item['layout'] = layout
    item['method'] = 'generated artwork, lettering composed in code'


def main():
    path = OUT / 'manifest.json'
    manifest = json.loads(path.read_text())
    for i,item in enumerate(manifest['images']):
        compose(item,i)
    manifest['note'] = 'Fictional advertisements; generated artwork with lettering composed separately.'
    path.write_text(json.dumps(manifest,indent=2)+'\n')


if __name__ == '__main__':
    main()
