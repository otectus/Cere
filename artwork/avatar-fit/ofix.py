import sys, json; sys.path.insert(0,'.')
import numpy as np
from PIL import Image, ImageFilter
from edits import Atlas
from oreg import crop, warp, error
def fit(base, ov, A0, b0, sel):
    Acur = list(A0); bcur = list(b0); H, W = ov.shape[:2]
    best = error(base, ov, Acur, bcur, sel)
    for st in (4, 2, 1, .5, .25):
        imp = True
        while imp:
            imp = False
            for k, dv in ((0, st), (0, -st), (1, st), (1, -st)):
                b2 = list(bcur); b2[k] += dv; ee = error(base, ov, Acur, b2, sel)
                if ee < best - 1e-5: best, bcur, imp = ee, b2, True
    for ss in (0.02, 0.01, 0.005):
        imp = True
        while imp:
            imp = False
            for k, dv in ((0, ss), (0, -ss), (1, ss), (1, -ss)):
                A2 = list(Acur); A2[k] += dv; c = (W / 2, H / 2)
                b2 = list(bcur); b2[k] = bcur[k] + (Acur[k] - A2[k]) * c[k]
                ee = error(base, ov, A2, b2, sel)
                if ee < best - 1e-5: best, Acur, bcur, imp = ee, A2, b2, True
            for k, dv in ((0, .25), (0, -.25), (1, .25), (1, -.25)):
                b2 = list(bcur); b2[k] += dv; ee = error(base, ov, Acur, b2, sel)
                if ee < best - 1e-5: best, bcur, imp = ee, b2, True
    return Acur, bcur, best
def diffmap(base, ov, A, b):
    w = warp(base, A, b, ov.shape[:2])
    wa = w[..., :3] / np.maximum(w[..., 3:4], 1e-4); oa = ov[..., :3] / np.maximum(ov[..., 3:4], 1e-4)
    dmap = np.abs(wa - oa).mean(-1) * np.minimum(w[..., 3], ov[..., 3]) + np.abs(w[..., 3] - ov[..., 3])
    return dmap, w
def analyse(aid, at, d):
    parts = {p['name']: p for p in d['parts']}
    hp = parts['head']; hsr = hp['sourceRect']; hr = hp['rect']
    hpu = (hsr[2] / hr[2], hsr[3] / hr[3])
    base = crop(at, hsr)
    res = {}
    for name in ('curiousEyes', 'wink', 'blink'):
        p = parts[name]; sr = p['sourceRect']; r = p['rect']
        ov = crop(at, sr)
        opu = (sr[2] / r[2], sr[3] / r[3])
        A0 = (hpu[0] / opu[0], hpu[1] / opu[1]); b0 = ((r[0] - hr[0]) * hpu[0], (r[1] - hr[1]) * hpu[1])
        H, W = ov.shape[:2]
        sel = np.ones((H, W), bool); sel[int(H * .18):int(H * .78), int(W * .12):int(W * .88)] = False
        A, b, e = fit(base, ov, A0, b0, sel)
        dmap, w = diffmap(base, ov, A, b)
        res[name] = dict(A=A, b=b, err=e, dmap=dmap, ov=ov, w=w, sr=sr, hpu=hpu, hr=hr)
    return res


def skin_mask(rgb_premul, red=False):
    a = rgb_premul[..., 3]
    rgb = rgb_premul[..., :3] / np.maximum(a[..., None], 1e-4)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    if red:
        return (a > 0.5) & (r > 0.45) & (r > g + 0.2) & (r > b + 0.15)
    return (a > 0.5) & (r > 0.55) & (r > b + 0.1) & (g > 0.35)

def blur(m, radius):
    im = Image.fromarray(np.clip(m * 255, 0, 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255

def grow(m, px):
    im = Image.fromarray((m > 0.5).astype(np.uint8) * 255)
    for _ in range(max(1, px // 2)):
        im = im.filter(ImageFilter.MaxFilter(5))
    return np.asarray(im, np.float32) / 255

def make_mask(v, red=False, thr=0.12, face_grow=14, dil=6, feather=5, min_area=40):
    import sys; sys.path.insert(0, '.')
    from cc import components
    D = blur(v['dmap'], 1.5)
    face = grow(skin_mask(v['w'], red).astype(np.float32), face_grow) > 0.5
    M0 = (D > thr) & face
    lab, comps = components(M0, min_area=1)
    keep = np.zeros_like(M0)
    for c in comps:
        if c[2] >= min_area: keep |= lab == c[0]
    M = blur(grow(keep.astype(np.float32), dil), feather)
    return np.clip(M * 1.6, 0, 1)   # firm interior, soft rim

def apply(at, d, red=False, report=None):
    res = analyse(None, at, d)
    parts = {p['name']: p for p in d['parts']}
    out = {}
    for name, v in res.items():
        M = make_mask(v, red)
        x, y, w, h = v['sr']
        at.px[y:y + h, x:x + w] *= M[..., None]
        ys, xs = np.nonzero(M > 0.004)
        bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        A, b, hpu, hr = v['A'], v['b'], v['hpu'], v['hr']
        # overlay px q -> base px A*q+b -> unit hr.xy + (A*q+b)/hpu
        rx = hr[0] + (A[0] * bx0 + b[0]) / hpu[0]; ry = hr[1] + (A[1] * by0 + b[1]) / hpu[1]
        rw = A[0] * (bx1 - bx0) / hpu[0]; rh = A[1] * (by1 - by0) / hpu[1]
        out[name] = {'sourceRect': [int(x + bx0), int(y + by0), int(bx1 - bx0), int(by1 - by0)],
                     'rect': [round(rx, 4), round(ry, 4), round(rw, 4), round(rh, 4)], 'err': v['err']}
        if report is not None:
            report[name] = (M, v)
    return out


def eye_boxes(v, red=False):
    """Two largest strongly changed blobs of the registered blink overlay."""
    import sys; sys.path.insert(0, '.')
    from cc import components
    D = blur(v['dmap'], 2.0)
    H, W = D.shape
    M = D > 0.18
    M[: int(H * 0.15)] = False; M[int(H * 0.85):] = False
    lab, comps = components(M, min_area=30)
    comps.sort(key=lambda c: -c[2])
    boxes = [c[1] for c in comps[:2]]
    boxes.sort(key=lambda b: b[0])
    return boxes

def eye_mask(shape, boxes_base, A, b, grow_x=0.85, grow_up=1.9, grow_down=0.75, feather=5):
    """Ellipses around both eyes and brows, in overlay pixel space."""
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # overlay px -> base px
    bx = A[0] * (xx + .5) + b[0]; by = A[1] * (yy + .5) + b[1]
    M = np.zeros((H, W), np.float32)
    for (x0, y0, x1, y1) in boxes_base:
        cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
        rx = (x1 - x0) / 2 * (1 + grow_x); ry_up = (y1 - y0) / 2 * (1 + grow_up); ry_dn = (y1 - y0) / 2 * (1 + grow_down)
        ry = np.where(by < cy, ry_up, ry_dn)
        e = ((bx - cx) / rx) ** 2 + ((by - cy) / ry) ** 2
        M = np.maximum(M, np.clip((1.0 - e) * 3.0, 0, 1))
    return blur(M, feather)

def apply_eyes(at, d, red=False, report=None, **kw):
    res = analyse(None, at, d)
    v = res['blink']
    # eye boxes in base-head pixel space from the blink overlay's change blobs
    boxes = []
    for (x0, y0, x1, y1) in eye_boxes(v, red):
        A, b = v['A'], v['b']
        boxes.append((A[0] * x0 + b[0], A[1] * y0 + b[1], A[0] * x1 + b[0], A[1] * y1 + b[1]))
    out = {'eyes': boxes}
    for name, v in res.items():
        M = eye_mask(v['ov'].shape[:2], boxes, v['A'], v['b'], **kw)
        x, y, w, h = v['sr']
        at.px[y:y + h, x:x + w] *= M[..., None]
        ys, xs = np.nonzero(M > 0.004)
        bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        A, b, hpu, hr = v['A'], v['b'], v['hpu'], v['hr']
        rx = hr[0] + (A[0] * bx0 + b[0]) / hpu[0]; ry = hr[1] + (A[1] * by0 + b[1]) / hpu[1]
        rw = A[0] * (bx1 - bx0) / hpu[0]; rh = A[1] * (by1 - by0) / hpu[1]
        out[name] = {'sourceRect': [int(x + bx0), int(y + by0), int(bx1 - bx0), int(by1 - by0)],
                     'rect': [round(float(rx), 4), round(float(ry), 4), round(float(rw), 4), round(float(rh), 4)], 'err': v['err']}
        if report is not None: report[name] = (M, v)
    return out
