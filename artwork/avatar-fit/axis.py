import sys, math
sys.path.insert(0,'.')
import numpy as np
from PIL import Image, ImageDraw
from compose import load

def rows(alpha, thr=0.5):
    """For each row: (y, left, right) of the longest opaque run."""
    out = []
    for y in range(alpha.shape[0]):
        m = alpha[y] >= thr
        if not m.any(): continue
        idx = np.nonzero(m)[0]
        # split into runs
        br = np.nonzero(np.diff(idx) > 1)[0]
        starts = np.r_[idx[0], idx[br+1]]; ends = np.r_[idx[br], idx[-1]]
        k = np.argmax(ends - starts)
        out.append((y + 0.5, starts[k], ends[k] + 1))
    return out

def fit_axis(alpha, lo=0.2, hi=0.8, thr=0.5):
    r = rows(alpha, thr)
    ys = np.array([a for a, _, _ in r]); mids = np.array([(b + c) / 2 for _, b, c in r])
    y0, y1 = ys.min(), ys.max()
    k = (ys >= y0 + lo * (y1 - y0)) & (ys <= y0 + hi * (y1 - y0))
    A = np.stack([ys[k], np.ones(k.sum())], 1)
    coef, *_ = np.linalg.lstsq(A, mids[k], rcond=None)
    # robust refit
    res = mids[k] - A @ coef
    keep = np.abs(res) < 2.5 * (np.std(res) + 1e-6)
    coef, *_ = np.linalg.lstsq(A[keep], mids[k][keep], rcond=None)
    slope, icpt = coef
    return slope, icpt, r

def describe(alpha, lo=0.2, hi=0.8):
    slope, icpt, r = fit_axis(alpha, lo, hi)
    ang = math.degrees(math.atan(slope))  # positive: axis leans to +x going down
    return ang, slope, icpt, r

if __name__ == '__main__':
    specs = {
        'thigh': (0.15, 0.85), 'boot': (0.05, 0.5), 'sleeve': (0.15, 0.85), 'hand': (0.05, 0.45), 'palm': (0.05, 0.45), 'glove': (0.05, 0.4),
    }
    for aid in sys.argv[1:]:
        d, atlas = load(aid)
        print('==', aid)
        tiles = []
        for p in d['parts']:
            nm = p['name']
            if p['bone'] in ('head', 'hair', 'torso') or p.get('mirrorX'): continue
            kind = next((k for k in specs if k in nm.lower()), None)
            if not kind: continue
            lo, hi = specs[kind]
            sr = p['sourceRect']
            crop = atlas.crop((sr[0], sr[1], sr[0] + sr[2], sr[1] + sr[3]))
            alpha = np.asarray(crop)[..., 3] / 255.0
            ang, slope, icpt, r = describe(alpha, lo, hi)
            # true width perpendicular estimate near both ends of fit window
            ys = np.array([a for a, _, _ in r]); w = np.array([c - b for _, b, c in r])
            print(f'  {nm:15s} axis angle {ang:6.1f} deg (x = {slope:.3f}*y + {icpt:.1f}); rows {ys.min():.0f}-{ys.max():.0f}; width min/med/max {w.min()}/{np.median(w):.0f}/{w.max()}')
            k = 2
            big = crop.resize((crop.size[0] * k, crop.size[1] * k), Image.LANCZOS)
            bg = Image.new('RGBA', big.size, (90, 90, 100, 255)); bg.alpha_composite(big)
            dr = ImageDraw.Draw(bg)
            y0, y1 = 0, crop.size[1]
            dr.line(((slope * y0 + icpt) * k, y0 * k, (slope * y1 + icpt) * k, y1 * k), fill=(0, 255, 0, 255), width=2)
            for (y, b, c) in r[::6]:
                dr.point(((b + c) / 2 * k, y * k), fill=(255, 255, 0, 255))
            dr.text((3, 3), f'{nm} {ang:.1f}', fill=(255, 255, 255, 255))
            tiles.append(bg)
        W = sum(t.size[0] for t in tiles) + 4 * len(tiles); H = max(t.size[1] for t in tiles)
        sheet = Image.new('RGBA', (W, H), (20, 20, 20, 255)); x = 0
        for t in tiles: sheet.paste(t, (x, 0)); x += t.size[0] + 4
        sheet.save(f'axis-{aid}.png')
