"""Joint landmark extraction for limb cutouts (source-pixel space)."""
import sys, math, json
sys.path.insert(0, '.')
import numpy as np
from PIL import Image, ImageDraw
from axis import fit_axis

def alpha_of(atlas, sr):
    c = atlas.crop((sr[0], sr[1], sr[0] + sr[2], sr[1] + sr[3]))
    return c, np.asarray(c)[..., 3].astype(np.float32) / 255.0

def frame(alpha, slope, icpt, thr=0.5):
    d = np.array([slope, 1.0]); d /= np.linalg.norm(d)
    n = np.array([d[1], -d[0]])
    p0 = np.array([icpt, 0.0])
    ys, xs = np.nonzero(alpha >= thr)
    P = np.stack([xs + 0.5, ys + 0.5], 1) - p0
    return p0, d, n, P @ d, P @ n

def sections(alpha, slope, icpt, thr=0.5):
    p0, d, n, t, u = frame(alpha, slope, icpt, thr)
    tb = np.floor(t).astype(int)
    out = {}
    for ti in np.unique(tb):
        m = tb == ti
        out[int(ti)] = (float(u[m].min()), float(u[m].max()))
    return p0, d, n, out

def cap(alpha, slope, icpt, end, frac=(0.10, 0.28), thr=0.5):
    """Center/radius of the rounded end ('top' or 'bottom') along the axis."""
    p0, d, n, sec = sections(alpha, slope, icpt, thr)
    ts = np.array(sorted(sec)); tmin, tmax = ts.min(), ts.max(); L = tmax - tmin
    if end == 'top':
        sel = [t for t in ts if tmin + frac[0] * L <= t <= tmin + frac[1] * L]
    else:
        sel = [t for t in ts if tmax - frac[1] * L <= t <= tmax - frac[0] * L]
    W = float(np.median([sec[t][1] - sec[t][0] for t in sel]))
    C = float(np.median([(sec[t][1] + sec[t][0]) / 2 for t in sel]))
    tc = tmin + W / 2 if end == 'top' else tmax - W / 2
    P = p0 + d * tc + n * C
    return P, W / 2, (tmin, tmax)

def axis_angle(slope):
    return math.degrees(math.atan(slope))   # from +y toward +x

def limb(atlas, sr, lo=0.15, hi=0.85, top=True, bottom=True, frac=(0.10, 0.28)):
    c, a = alpha_of(atlas, sr)
    slope, icpt, _ = fit_axis(a, lo, hi)
    res = {'phi': axis_angle(slope), 'slope': slope, 'icpt': icpt}
    if top:
        P, r, _ = cap(a, slope, icpt, 'top', frac); res['P'] = P.tolist(); res['rP'] = r
    if bottom:
        D, r, _ = cap(a, slope, icpt, 'bottom', frac); res['D'] = D.tolist(); res['rD'] = r
    ys, xs = np.nonzero(a >= 0.5)
    res['bbox'] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    return res

def draw(atlas, sr, info, k=2, label=''):
    c = atlas.crop((sr[0], sr[1], sr[0] + sr[2], sr[1] + sr[3]))
    big = c.resize((c.size[0] * k, c.size[1] * k), Image.LANCZOS)
    bg = Image.new('RGBA', big.size, (95, 95, 105, 255)); bg.alpha_composite(big)
    dr = ImageDraw.Draw(bg)
    s, i = info['slope'], info['icpt']
    dr.line((i * k, 0, (s * sr[3] + i) * k, sr[3] * k), fill=(0, 255, 0, 160), width=1)
    for key, rk, col in (('P', 'rP', (0, 255, 0, 255)), ('D', 'rD', (255, 160, 0, 255))):
        if key in info:
            x, y = info[key][0] * k, info[key][1] * k; r = info[rk] * k
            dr.ellipse((x - r, y - r, x + r, y + r), outline=col, width=2)
            dr.line((x - 7, y, x + 7, y), fill=(255, 255, 0, 255), width=2); dr.line((x, y - 7, x, y + 7), fill=(255, 255, 0, 255), width=2)
    for key in ('extra',):
        for (x, y, col) in info.get(key, []):
            dr.ellipse((x * k - 5, y * k - 5, x * k + 5, y * k + 5), fill=col)
    dr.text((3, 3), f"{label} phi={info['phi']:.1f}", fill=(255, 255, 255, 255))
    return bg

def pack(tiles, maxw=1990, gap=6, bgc=(20, 20, 20, 255)):
    x = y = rowh = 0; pos = []
    for t in tiles:
        if x + t.size[0] > maxw and x > 0: x = 0; y += rowh + gap; rowh = 0
        pos.append((x, y)); x += t.size[0] + gap; rowh = max(rowh, t.size[1])
    s = Image.new('RGBA', (maxw, y + rowh), bgc)
    for t, p in zip(tiles, pos): s.paste(t, p)
    return s
