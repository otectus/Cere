import sys, math, json
sys.path.insert(0, '.')
import numpy as np
from PIL import Image
from edits import Atlas
def profile(at, sr, P, phi, t_from, t_to, half=None, step=1.0):
    # sample only this sprite's crop so neighbouring cutouts never interfere
    sub = np.zeros_like(at.px); x0, y0 = sr[0], sr[1]
    sub[y0:y0 + sr[3], x0:x0 + sr[2]] = at.px[y0:y0 + sr[3], x0:x0 + sr[2]]
    o = np.array([sr[0] + P[0], sr[1] + P[1]], float)
    r = math.radians(phi); d = np.array([math.sin(r), math.cos(r)]); n = np.array([math.cos(r), -math.sin(r)])
    ts = np.arange(t_from, t_to, step)
    us = np.linspace(-half, half, 9) if half else np.array([0.0])
    T, U = np.meshgrid(ts, us, indexing='ij')
    xs = o[0] + d[0] * T + n[0] * U; ys = o[1] + d[1] * T + n[1] * U
    v = at.sample(xs, ys, sub)
    a = v[..., 3]; lum = (v[..., 0] * .3 + v[..., 1] * .59 + v[..., 2] * .11) / np.maximum(a, 1e-4)
    return ts, lum.mean(1), a.mean(1)
if __name__ == '__main__':
    A = __import__('compose').A + '/'
    aid = sys.argv[1]; tex = {'jade': 'jade-puppet.png', 'nova': 'nova-puppet.png', 'daemona': 'daemona-puppet.png', 'cere': 'cere-puppet-reference.png'}[aid]
    at = Atlas(A + tex)
    L = json.load(open(f'lmk-{aid}.json'))
    name = sys.argv[2]; sr = json.loads(sys.argv[3]); i = L[name]
    key = sys.argv[4] if len(sys.argv) > 4 else 'P'
    t_from, t_to = float(sys.argv[5]), float(sys.argv[6])
    ts, lum, a = profile(at, sr, i[key], i['phi'], t_from, t_to, half=float(sys.argv[7]) if len(sys.argv) > 7 else 6)
    for t, l, al in zip(ts, lum, a):
        print(f'{t:6.1f} lum {l:5.3f} a {al:4.2f} ' + '#' * int(l * 60))

def tip(at, sr, P, phi, end, rng=400):
    ts, lum, a = profile(at, sr, P, phi, -rng if end == 'top' else 0, 0 if end == 'top' else rng, half=2)
    inside = ts[a > 0.5]
    return float(inside.min() if end == 'top' else inside.max())

def detect_cut(at, sr, P, phi, end, r, half=None):
    """Axial position of the painted cut-face boundary near a limb end: the
    strongest dark dip within ~1.3 radii of the tip."""
    t_tip = tip(at, sr, P, phi, end)
    span = 1.3 * r
    if end == 'bottom':
        ts, lum, a = profile(at, sr, P, phi, t_tip - span, t_tip - 2, half=half or r * 0.35)
    else:
        ts, lum, a = profile(at, sr, P, phi, t_tip + 2, t_tip + span, half=half or r * 0.35)
    k = 3
    best, bt = 0, None
    for i in range(k, len(ts) - k):
        nb = (lum[i - k:i].mean() + lum[i + 1:i + 1 + k].mean()) / 2
        dip = nb - lum[i]
        if dip > best: best, bt = dip, ts[i]
    return t_tip, bt, best
