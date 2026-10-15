"""Fit cutout sprites onto the shared skeleton at native aspect ratio."""
import sys, math, json, copy
sys.path.insert(0, '.')
import numpy as np
from PIL import Image, ImageDraw
import compose as C

def rot(deg):
    r = math.radians(deg); return (math.cos(r), -math.sin(r), math.sin(r), math.cos(r))

def apply(Rm, v):
    return (Rm[0] * v[0] + Rm[1] * v[1], Rm[2] * v[0] + Rm[3] * v[1])

def place(name, bone, sr, P, phi, s, beta, z, mirror=False, **extra):
    """P: bone-origin pixel (relative to sr origin). phi: painted axis angle in
    sprite pixels (deg from +y toward +x). beta: wanted axis angle in the bone
    frame. s: reference units per source pixel."""
    w, h = sr[2], sr[3]
    phi_e = -phi if mirror else phi
    px = (w - P[0]) if mirror else P[0]
    part = {'name': name, 'bone': bone, 'sourceRect': list(sr),
            'rect': [round(-px * s, 4), round(-P[1] * s, 4), round(w * s, 4), round(h * s, 4)],
            'z': z}
    r = round(phi_e - beta, 3)
    if abs(r) > 1e-6: part['rotation'] = r
    if mirror: part['mirrorX'] = True
    part.update(extra)
    return part

def to_bone(part, pix):
    """Map a sprite pixel (relative to sr origin) into the part's bone frame."""
    sr, r = part['sourceRect'], part['rect']
    s = r[2] / sr[2]
    x = pix[0]
    if part.get('mirrorX'): x = sr[2] - x
    v = (r[0] + x * s, r[1] + pix[1] * s)
    return apply(rot(part.get('rotation', 0)), v)

def base_rig():
    return json.load(open('originals/cere-rig.json'))

def resolve(base, art):
    return C.resolve(base, art)

def review(d, atlas, out, poses=('rest', 'wave', 'folded', 'thinking', 'jump', 'crouch', 'explaining', 'hairTuck', 'glassesAdjust', 'surprise', 'offer', 'triumph'), scale=2, bg=(128, 128, 136), crop=(40, 10, 344, 416)):
    tiles = []
    for n in poses:
        img, wt, fit = C.render(d, atlas, C.pose_joints(d, n), scale=scale)
        img = C.on_bg(img, bg)
        if crop: img = img.crop(tuple(int(c * scale / 2) for c in crop))
        ImageDraw.Draw(img).text((4, 4), n, fill=(255, 255, 0, 255))
        tiles.append(img)
    W, H = tiles[0].size
    cols = 6
    sheet = Image.new('RGBA', (W * cols, H * ((len(tiles) + cols - 1) // cols)), (0, 0, 0, 255))
    for i, t in enumerate(tiles): sheet.paste(t, ((i % cols) * W, (i // cols) * H))
    sheet.save(out)
    return sheet.size
