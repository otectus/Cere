"""Repack an avatar's final cutouts into a compact atlas with clean, fragment-free crops.

Connectivity is evaluated inside each part's own crop, so a hair tip that only
touches the torso outside that crop never drags the torso (or vice versa)."""
import sys, json, math; sys.path.insert(0, '.')
import numpy as np
from PIL import Image, ImageFilter
from cc import components

def is_free(p):
    return p['bone'] in ('head', 'hair') or bool(p.get('opacityChannel'))

def crop_components(px, sr, thr=0.03):
    x, y, w, h = sr
    lab, comps = components(px[y:y + h, x:x + w, 3] > thr, min_area=1)
    return lab, {c[0]: c for c in comps}

def dilate(m, n=1):
    im = Image.fromarray((m > 0).astype(np.uint8) * 255)
    for _ in range(n): im = im.filter(ImageFilter.MaxFilter(3))
    return np.asarray(im, np.float32) / 255

def repack(px, rig, width=1536, gutter=4, pad=2, min_keep=24):
    parts = rig['parts']
    H, W = px.shape[:2]
    owner = np.full((H, W), -1, np.int32)
    labs = {}
    # parts sharing one crop (mirrored pairs) form a single owner
    group = {}
    gid = [group.setdefault(tuple(p['sourceRect']), i) for i, p in enumerate(parts)]
    BODY = 1 << 16
    for i, p in enumerate(parts):
        lab, comps = crop_components(px, p['sourceRect'])
        labs[p['name']] = (lab, comps)
        if is_free(p) or not comps: continue
        main = max(comps.values(), key=lambda c: c[2])[0]
        x, y, w, h = p['sourceRect']
        sel = lab == main
        reg = owner[y:y + h, x:x + w]
        reg[sel & (reg < 0)] = gid[i] + BODY
    # hair, heads and overlays claim whatever their crops hold that no body owns
    for i, p in enumerate(parts):
        if not is_free(p): continue
        lab, comps = labs[p['name']]
        x, y, w, h = p['sourceRect']
        reg = owner[y:y + h, x:x + w]
        reg[(lab > 0) & (reg < 0)] = gid[i]
    images, keyed = {}, {}
    for i, p in enumerate(parts):
        me = gid[i]
        x, y, w, h = p['sourceRect']
        lab, comps = labs[p['name']]
        reg = owner[y:y + h, x:x + w]
        keep = []
        if is_free(p):
            # drop small pieces that reach into a body cutout (a neck top under
            # the hair, a waist cap under the chin); keep everything else
            big = max(c[2] for c in comps.values())
            keep = [l for l, c in comps.items()
                    if c[2] >= 0.1 * big or not np.any(reg[lab == l] >= BODY)]
            foreign = (reg >= BODY)          # bodies inside a hair/head crop
        else:
            main = max(comps.values(), key=lambda c: c[2])[0]
            keep.append(main)
            for l, c in comps.items():
                if l == main or c[2] < min_keep: continue
                others = reg[lab == l]
                if np.all((others < 0) | (others == me + BODY)):
                    keep.append(l)
            foreign = (reg >= 0) & (reg != me + BODY)
        m = dilate(np.isin(lab, keep), 1)
        # never keep pixels that belong to another cutout
        m *= 1 - dilate(foreign, 1)
        img = px[y:y + h, x:x + w] * m[..., None]
        a = img[..., 3]
        ys, xs = np.nonzero(a > 0.002)
        bx0, by0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
        # a boot's crop ends at its sole, so the rect bottom is the ground contact
        bpad = 0 if p['name'].endswith('Boot') else pad
        bx1, by1 = min(w, xs.max() + 1 + pad), min(h, ys.max() + 1 + bpad)
        sig = (tuple(p['sourceRect']), tuple(sorted(keep)))
        if sig not in keyed:
            keyed[sig] = (img[by0:by1, bx0:bx1].copy(), (bx0, by0))
        images[p['name']] = sig
    order = sorted(keyed, key=lambda k: -keyed[k][0].shape[0])
    placed = {}
    cx = cy = gutter; rowh = 0
    for k in order:
        im = keyed[k][0]; h, w = im.shape[:2]
        if cx + w + gutter > width: cx = gutter; cy += rowh + gutter; rowh = 0
        placed[k] = (cx, cy); cx += w + gutter; rowh = max(rowh, h)
    Ht = int(math.ceil((cy + rowh + gutter) / 8.0) * 8)
    out = np.zeros((Ht, width, 4), np.float32)
    for k, (x, y) in placed.items():
        im = keyed[k][0]; h, w = im.shape[:2]
        out[y:y + h, x:x + w] = im
    newrig = json.loads(json.dumps(rig))
    for p in newrig['parts']:
        sig = images[p['name']]
        im, (ox, oy) = keyed[sig]; h, w = im.shape[:2]
        x, y = placed[sig]
        osr = p['sourceRect']; r = p['rect']
        kx = r[2] / osr[2]; ky = r[3] / osr[3]
        rx = r[0] + ((osr[2] - ox - w) if p.get('mirrorX') else ox) * kx
        p['sourceRect'] = [int(x), int(y), int(w), int(h)]
        p['rect'] = [round(rx, 4), round(r[1] + oy * ky, 4), round(w * kx, 4), round(h * ky, 4)]
    return out, newrig

def save(px, path):
    a = px.copy(); al = a[..., 3:4]
    a[..., :3] = np.where(al > 1e-6, a[..., :3] / np.maximum(al, 1e-6), 0)
    o = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
    o[..., :3][o[..., 3] == 0] = 0
    Image.fromarray(o, 'RGBA').save(path, optimize=True)
