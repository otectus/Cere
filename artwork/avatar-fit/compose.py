"""Offline compositor mirroring native/avatardefinition.h + avatarpuppet.cpp.

Usage (library): load(avatar_id) -> definition, atlas; render(defn, atlas, pose, scale) -> RGBA image
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.environ.get('CERE_ROOT', os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')))
A = os.path.join(ROOT, 'assets')

def resolve(base, artwork):
    result = dict(base)
    for k, v in artwork.items():
        result[k] = v
    bones = [dict(b) for b in result['bones']]
    overrides = result.pop('boneOverrides', {}) or {}
    names = {b['name'] for b in bones}
    for b in bones:
        for k, v in overrides.get(b['name'], {}).items():
            assert k in ('x', 'y')
            b[k] = v
    for k in overrides:
        assert k in names, k
    prop = result.pop('proportions', None)
    parts = [dict(p) for p in result['parts']]
    if prop:
        sx, sy, cx, ground = prop['bodyWidth'], prop['bodyHeight'], prop['centerX'], prop['groundY']
        head = prop['headBone']
        preserved = {head}
        for _ in range(len(bones)):
            n = len(preserved)
            for b in bones:
                if b.get('parent', '') in preserved:
                    preserved.add(b['name'])
            if len(preserved) == n:
                break
        for b in bones:
            parent = b.get('parent', '')
            if parent not in preserved:
                x, y = b.get('x', 0), b.get('y', 0)
                b['x'] = x * sx + (cx * (1 - sx) if parent == '' else 0)
                b['y'] = y * sy + (ground * (1 - sy) if parent == '' else 0)
        for p in parts:
            if p['bone'] not in preserved:
                r = p['rect']
                p['rect'] = [r[0] * sx, r[1] * sy, r[2] * sx, r[3] * sy]
    result['bones'] = bones
    result['parts'] = parts
    return result

def catalog():
    return json.load(open(os.path.join(A, 'avatars.json')))

def load(avatar_id, rig_override=None, texture_override=None):
    base = json.load(open(os.path.join(A, 'cere-rig.json')))
    entry = next(e for e in catalog() if e['id'] == avatar_id)
    rigfile = rig_override or entry.get('rig')
    art = json.load(open(rigfile if os.path.isabs(rigfile) else os.path.join(A, rigfile))) if rigfile else {}
    d = resolve(base, art)
    tex = texture_override or os.path.join(A, d['texture'])
    atlas = Image.open(tex).convert('RGBA')
    return d, atlas

def topo(bones):
    by = {b['name']: b for b in bones}
    order, state = [], {}
    def visit(n):
        if state.get(n) == 2: return
        assert state.get(n) != 1
        state[n] = 1
        p = by[n].get('parent', '')
        if p: visit(p)
        state[n] = 2
        order.append(n)
    for b in bones: visit(b['name'])
    return [by[n] for n in order]

def chan(pose, c, angle=False):
    if not c: return 0.0
    v = pose.get(c, 0.0)
    try: v = float(v)
    except Exception: return 0.0
    if not math.isfinite(v): return 0.0
    if angle: return math.remainder(v, 360.0)
    return max(-1e6, min(1e6, v))

def compose(P, L):
    a, b, c, d, e, f = P
    A_, B_, C_, D_, E_, F_ = L
    return (a*A_ + b*C_, a*B_ + b*D_, c*A_ + d*C_, c*B_ + d*D_, a*E_ + b*F_ + e, c*E_ + d*F_ + f)

def world(defn, pose):
    out = {}
    for b in topo(defn['bones']):
        r = math.radians(chan(pose, b.get('angle', ''), True))
        cs, sn = math.cos(r), math.sin(r)
        L = (cs, -sn, sn, cs, b.get('x', 0) + chan(pose, b.get('offsetX', '')), b.get('y', 0) + chan(pose, b.get('offsetY', '')))
        p = b.get('parent', '')
        out[b['name']] = compose(out[p], L) if p else L
    return out

def inv(T):
    a, b, c, d, e, f = T
    det = a*d - b*c
    ia, ib, ic, id_ = d/det, -b/det, -c/det, a/det
    return (ia, ib, ic, id_, -(ia*e + ib*f), -(ic*e + id_*f))

def premul(im):
    arr = np.asarray(im, dtype=np.float32) / 255.0
    arr[..., :3] *= arr[..., 3:4]
    return arr

def sample_bilinear(src, xs, ys):
    """src: HxWx4 premultiplied float; xs, ys: arrays of source pixel coords (centre-based)."""
    h, w = src.shape[:2]
    x0 = np.floor(xs - 0.5).astype(np.int64); y0 = np.floor(ys - 0.5).astype(np.int64)
    fx = (xs - 0.5) - x0; fy = (ys - 0.5) - y0
    out = np.zeros(xs.shape + (4,), np.float32)
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            xx = x0 + dx; yy = y0 + dy
            valid = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
            xc = np.clip(xx, 0, w - 1); yc = np.clip(yy, 0, h - 1)
            v = src[yc, xc] * valid[..., None]
            out += v * (wx * wy)[..., None]
    return out

def visible_parts(defn, pose):
    parts = sorted(enumerate(defn['parts']), key=lambda t: (t[1].get('z', 0), t[0]))
    res = []
    for _, p in parts:
        op = 1.0 if not p.get('opacityChannel') else max(0.0, min(1.0, chan(pose, p['opacityChannel'])))
        vw = p.get('visibleWhen')
        if vw:
            v = chan(pose, vw['channel'])
            lo = vw.get('min', -math.inf); hi = vw.get('max', math.inf)
            if v < lo or v >= hi: op = 0.0
        if op > 0: res.append((p, op))
    return res

def render(defn, atlas, pose, W=None, H=None, scale=4, only=None, skip=(), bg=None, tint=None, frame=None):
    ref = defn.get('referenceSize', [192, 208])
    if W is None: W, H = int(ref[0] * scale), int(ref[1] * scale)
    s = min(W / ref[0], H / ref[1])
    fit = (s, 0, 0, s, (W - ref[0] * s) * 0.5, H - ref[1] * s)
    if frame is not None:
        fit = compose(fit, frame)
    wt = world(defn, pose)
    canvas = np.zeros((H, W, 4), np.float32)
    if bg is not None:
        canvas[...] = np.array([bg[0]/255, bg[1]/255, bg[2]/255, 1.0], np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    px = xx + 0.5; py = yy + 0.5
    for p, op in visible_parts(defn, pose):
        if only and p['name'] not in only: continue
        if p['name'] in skip: continue
        sr = p['sourceRect']; r = p['rect']
        crop = premul(atlas.crop((sr[0], sr[1], sr[0] + sr[2], sr[1] + sr[3])))
        if tint and p['name'] in tint:
            t = tint[p['name']]
            crop[..., :3] = crop[..., :3] * 0.4 + np.array(t, np.float32)[None, None, :] / 255 * crop[..., 3:4] * 0.6
        T = compose(fit, wt[p['bone']])
        ang = float(p.get('rotation', 0) or 0)
        if ang:
            ra = math.radians(ang); ca, sa = math.cos(ra), math.sin(ra)
            T = compose(T, (ca, -sa, sa, ca, 0.0, 0.0))
        I = inv(T)
        # local bone coords
        lx = I[0] * px + I[1] * py + I[4]
        ly = I[2] * px + I[3] * py + I[5]
        u = (lx - r[0]) / r[2]; v = (ly - r[1]) / r[3]
        inside = (u >= -0.02) & (u <= 1.02) & (v >= -0.02) & (v <= 1.02)
        if not inside.any(): continue
        if p.get('mirrorX'): u = 1 - u
        sxs = u * sr[2]; sys_ = v * sr[3]
        idx = np.nonzero(inside)
        samp = sample_bilinear(crop, sxs[idx], sys_[idx]) * op
        # Qt clamps to the texture edge: points slightly outside [0,1] would clamp; we just mask to inside rect
        uu = u[idx]; vv = v[idx]
        m = ((uu >= 0) & (uu <= 1) & (vv >= 0) & (vv <= 1)).astype(np.float32)
        samp *= m[:, None]
        dst = canvas[idx]
        a = samp[:, 3:4]
        canvas[idx] = samp + dst * (1 - a)
    out = canvas.copy()
    a = out[..., 3:4]
    with np.errstate(invalid='ignore', divide='ignore'):
        out[..., :3] = np.where(a > 0, out[..., :3] / np.maximum(a, 1e-6), 0)
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8), 'RGBA'), wt, fit

def pose_joints(defn, name_or_index):
    poses = defn['poses']
    if isinstance(name_or_index, int) or str(name_or_index).isdigit():
        return dict(poses[str(name_or_index)]['joints'])
    for k, v in poses.items():
        if v['name'] == name_or_index:
            return dict(v['joints'])
    raise KeyError(name_or_index)

def on_bg(img, color=(32, 35, 46)):
    bg = Image.new('RGBA', img.size, color + (255,))
    bg.alpha_composite(img)
    return bg

def mark_joints(img, defn, wt, fit, names=None, color=(0, 255, 0, 255), r=3):
    d = ImageDraw.Draw(img)
    for b in defn['bones']:
        if names and b['name'] not in names: continue
        T = compose(fit, wt[b['name']])
        x, y = T[4], T[5]
        d.ellipse((x - r, y - r, x + r, y + r), outline=color, width=1)
    return img
