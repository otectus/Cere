"""Register expression overlays (alternate heads) to the base head in atlas space."""
import sys, json, math; sys.path.insert(0,'.')
import numpy as np
from PIL import Image
from edits import Atlas

def crop(at, sr):
    x, y, w, h = sr
    return at.px[y:y + h, x:x + w].copy()

def warp(src, A, b, shape):
    """Sample src at (A*q + b) for every output pixel q (diag A), bilinear, premult."""
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    sx = A[0] * (xx + .5) + b[0]; sy = A[1] * (yy + .5) + b[1]
    h, w = src.shape[:2]
    x0 = np.floor(sx - .5).astype(int); y0 = np.floor(sy - .5).astype(int)
    fx = sx - .5 - x0; fy = sy - .5 - y0
    out = np.zeros((H, W, 4), np.float32)
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            X = x0 + dx; Y = y0 + dy
            ok = (X >= 0) & (X < w) & (Y >= 0) & (Y < h)
            out += src[np.clip(Y, 0, h - 1), np.clip(X, 0, w - 1)] * (ok * wx * wy)[..., None]
    return out

def error(base, ov, A, b, sel):
    w = warp(base, A, b, ov.shape[:2])     # base sampled at overlay pixel positions
    ok = sel & (w[..., 3] > 0.95) & (ov[..., 3] > 0.95)
    if ok.sum() < 100: return 9.0
    wa = w[..., :3] / np.maximum(w[..., 3:4], 1e-4); oa = ov[..., :3] / np.maximum(ov[..., 3:4], 1e-4)
    return float(np.abs(wa - oa)[ok].mean())

def register(base, ov, init_b, sel, steps=(4, 2, 1, .5, .25), sstep=(0.02, 0.01, 0.005, 0.0025)):
    A = [1.0, 1.0]; b = list(init_b)
    best = error(base, ov, A, b, sel)
    for st in steps:
        improved = True
        while improved:
            improved = False
            for k, dv in ((0, st), (0, -st), (1, st), (1, -st)):
                b2 = list(b); b2[k] += dv
                e = error(base, ov, A, b2, sel)
                if e < best - 1e-5: best, b, improved = e, b2, True
    for ss in sstep:
        improved = True
        while improved:
            improved = False
            for k, dv in ((0, ss), (0, -ss), (1, ss), (1, -ss)):
                A2 = list(A); A2[k] += dv
                # keep the overlay centre fixed while scaling
                c = (ov.shape[1] / 2, ov.shape[0] / 2)
                b2 = list(b); b2[k] = b[k] + (A[k] - A2[k]) * c[k]
                e = error(base, ov, A2, b2, sel)
                if e < best - 1e-5: best, A, b, improved = e, A2, b2, True
            for k, dv in ((0, .25), (0, -.25), (1, .25), (1, -.25)):
                b2 = list(b); b2[k] += dv
                e = error(base, ov, A, b2, sel)
                if e < best - 1e-5: best, b, improved = e, b2, True
    return A, b, best
