"""Deterministic atlas edits: heal painted joint cut faces, taper limbs, erase and feather."""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

class Atlas:
    def __init__(self, path_or_image):
        im = Image.open(path_or_image).convert('RGBA') if isinstance(path_or_image, str) else path_or_image.convert('RGBA')
        a = np.asarray(im, np.float32) / 255.0
        a[..., :3] *= a[..., 3:4]
        self.px = a                       # premultiplied RGBA, float
        self.H, self.W = a.shape[:2]

    def image(self):
        a = self.px.copy()
        al = a[..., 3:4]
        with np.errstate(invalid='ignore', divide='ignore'):
            a[..., :3] = np.where(al > 1e-6, a[..., :3] / np.maximum(al, 1e-6), 0)
        out = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
        out[..., :3][out[..., 3] == 0] = 0
        return Image.fromarray(out, 'RGBA')

    def save(self, path):
        self.image().save(path, optimize=True)

    # --- sampling -----------------------------------------------------
    def sample(self, xs, ys, src=None):
        """Bilinear sample premultiplied pixels at pixel-centre coordinates."""
        s = self.px if src is None else src
        H, W = s.shape[:2]
        x0 = np.floor(xs - 0.5).astype(np.int64); y0 = np.floor(ys - 0.5).astype(np.int64)
        fx = (xs - 0.5) - x0; fy = (ys - 0.5) - y0
        out = np.zeros(xs.shape + (4,), np.float32)
        for dy, wy in ((0, 1 - fy), (1, fy)):
            for dx, wx in ((0, 1 - fx), (1, fx)):
                xx = x0 + dx; yy = y0 + dy
                ok = (xx >= 0) & (xx < W) & (yy >= 0) & (yy < H)
                v = s[np.clip(yy, 0, H - 1), np.clip(xx, 0, W - 1)] * ok[..., None]
                out += v * (wx * wy)[..., None]
        return out

    # --- masks -------------------------------------------------------------
    def poly_mask(self, poly, feather=0.0, box=None):
        m = Image.new('L', (self.W, self.H), 0)
        ImageDraw.Draw(m).polygon([tuple(p) for p in poly], fill=255)
        if feather > 0:
            m = m.filter(ImageFilter.GaussianBlur(feather))
        return np.asarray(m, np.float32) / 255.0

    def erase(self, poly, feather=0.0, limit=None):
        """Make a polygon transparent (soft edged), optionally only where
        `limit` (a component mask) is set so neighbouring cutouts are safe."""
        m = self.poly_mask(poly, feather)
        if limit is not None:
            m = m * limit
        self.px *= (1 - m)[..., None]

    def keep_only(self, rect, poly, feather=0.0):
        """Inside rect, keep only the polygon (soft edged)."""
        x0, y0, x1, y1 = rect
        m = self.poly_mask(poly, feather)
        sub = self.px[y0:y1, x0:x1]
        sub *= m[y0:y1, x0:x1][..., None]

    def clear_rect(self, rect):
        x0, y0, x1, y1 = rect
        self.px[y0:y1, x0:x1] = 0

    def copy(self, src_rect, dst_xy):
        x0, y0, x1, y1 = src_rect
        block = self.px[y0:y1, x0:x1].copy()
        dx, dy = dst_xy
        self.px[dy:dy + (y1 - y0), dx:dx + (x1 - x0)] = block

    # --- limb-space helpers ---------------------------------------------
    @staticmethod
    def frame(P, phi):
        """Axis frame: d along the limb (down), n perpendicular (+x side at phi=0)."""
        r = math.radians(phi)
        d = np.array([math.sin(r), math.cos(r)]); n = np.array([math.cos(r), -math.sin(r)])
        return np.array(P, float), d, n

    def region_grid(self, rect):
        x0, y0, x1, y1 = rect
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        return xx + 0.5, yy + 0.5

    def heal_end(self, rect, P, phi, t0, end='bottom', length=None, edge_keep=2.5, edge_soft=2.0, mode='mirror', clone=None, seam=4.0, mask=None):
        """Replace the painted cut face beyond axial position t0 with limb
        material mirrored (or cloned) from just inside it, keeping the original
        silhouette alpha and a thin band of its contour."""
        x0, y0, x1, y1 = rect
        xs, ys = self.region_grid(rect)
        o, d, n = self.frame(P, phi)
        rel = np.stack([xs - o[0], ys - o[1]], -1)
        t = rel @ d; u = rel @ n
        sub = self.px[y0:y1, x0:x1]
        alpha = sub[..., 3]
        if end == 'bottom':
            sel = t > t0
            ts = 2 * t0 - t if mode == 'mirror' else t - clone
        else:
            sel = t < t0
            ts = 2 * t0 - t if mode == 'mirror' else t + clone
        if length is not None:
            sel &= np.abs(t - t0) <= length
        sx = o[0] + d[0] * ts + n[0] * u; sy = o[1] + d[1] * ts + n[1] * u
        src = self.sample(sx, sy, None if mask is None else self.px * mask[..., None])
        # distance to the silhouette edge (approx) via alpha erosion
        inside = alpha > 0.5
        if mask is not None:
            inside &= mask[y0:y1, x0:x1] > 0.5
        dist = self._edge_distance(inside)
        w = np.clip((dist - edge_keep) / max(edge_soft, 1e-3), 0, 1) * sel
        if seam > 0:
            w *= np.clip(np.abs(t - t0) / seam, 0, 1)
        if mask is not None:
            w *= mask[y0:y1, x0:x1]
        # keep original alpha (silhouette); take colour from the source,
        # rescaled to the original coverage
        src_a = np.maximum(src[..., 3:4], 1e-4)
        colour = src[..., :3] / src_a * alpha[..., None]
        sub[..., :3] = sub[..., :3] * (1 - w[..., None]) + colour * w[..., None]

    def _edge_distance(self, inside, maxd=12):
        """Chamfer distance (pixels) from the outside, capped."""
        dist = np.where(inside, maxd, 0).astype(np.float32)
        H, W = inside.shape
        for _ in range(2):
            for y in range(H):
                row = dist[y]
                if y > 0: np.minimum(row, dist[y - 1] + 1, out=row)
                for x in range(1, W): row[x] = min(row[x], row[x - 1] + 1)
                for x in range(W - 2, -1, -1): row[x] = min(row[x], row[x + 1] + 1)
            for y in range(H - 2, -1, -1):
                np.minimum(dist[y], dist[y + 1] + 1, out=dist[y])
        return dist

    def taper(self, rect, P, phi, t_start, t_end, factor, centre_u=0.0, mask=None):
        """Narrow the limb perpendicular to its axis: scale 1 at t_start
        smoothly to `factor` at and beyond t_end (smoothstep)."""
        x0, y0, x1, y1 = rect
        xs, ys = self.region_grid(rect)
        o, d, n = self.frame(P, phi)
        rel = np.stack([xs - o[0], ys - o[1]], -1)
        t = rel @ d; u = rel @ n - centre_u
        k = np.clip((t - t_start) / (t_end - t_start), 0, 1)
        k = k * k * (3 - 2 * k)
        f = 1 + (factor - 1) * k
        us = u / f + centre_u
        sx = o[0] + d[0] * t + n[0] * us; sy = o[1] + d[1] * t + n[1] * us
        src = self.px.copy() if mask is None else self.px * mask[..., None]
        out = self.sample(sx, sy, src)
        if mask is None:
            self.px[y0:y1, x0:x1] = out
        else:
            # replace only this cutout: other components keep their pixels
            m = mask[y0:y1, x0:x1][..., None]
            region = self.px[y0:y1, x0:x1]
            self.px[y0:y1, x0:x1] = region * (1 - m) + out * m

    def feather_axis(self, rect, P, phi, t_solid, t_clear, half_width=None, side_soft=6.0):
        """Fade alpha along the axis from opaque at t_solid to clear at t_clear
        (either direction), optionally only within |u| <= half_width."""
        x0, y0, x1, y1 = rect
        xs, ys = self.region_grid(rect)
        o, d, n = self.frame(P, phi)
        rel = np.stack([xs - o[0], ys - o[1]], -1)
        t = rel @ d; u = rel @ n
        k = np.clip((t - t_solid) / (t_clear - t_solid), 0, 1)
        k = k * k * (3 - 2 * k)
        if half_width is not None:
            lateral = np.clip((half_width - np.abs(u)) / side_soft, 0, 1)
            k = k * lateral
        self.px[y0:y1, x0:x1] *= (1 - k)[..., None]


def fit_mask(mask, H):
    if mask.shape[0] >= H: return mask[:H]
    return np.concatenate([mask, np.zeros((H - mask.shape[0],) + mask.shape[1:], mask.dtype)], 0)


def rebuild_limb(at, sr, P, phi, segs, pad=6, ss=3, width=None, mirror_src=False, mask=None, out_phi=0.0):
    """Resample a limb sprite into an upright sprite with a piecewise axial layout.

    segs: list of dicts with keys t0, t1 (source axial range, from P along phi),
    and either 'a' (axial scale) or 'len' (output length), 'l' lateral scale
    (scalar, or (l_top, l_bottom) for a linear ramp), optional 'hold' (sample a
    constant cross-section at that source t: extrusion) and 'u0' (lateral
    centre in source pixels).
    Returns (premultiplied float image, P_out in output pixels, layout)."""
    sub = np.zeros_like(at.px)
    x0, y0 = sr[0], sr[1]
    sub[y0:y0 + sr[3], x0:x0 + sr[2]] = at.px[y0:y0 + sr[3], x0:x0 + sr[2]]
    if mask is not None:
        sub *= fit_mask(mask, sub.shape[0])[..., None]
    o = np.array([sr[0] + P[0], sr[1] + P[1]], float)
    r = math.radians(phi); d = np.array([math.sin(r), math.cos(r)]); n = np.array([math.cos(r), -math.sin(r)])
    # output layout
    T = []
    tp = segs[0]['t0']   # output starts at the same axial origin as the source
    for s in segs:
        L = s.get('len', (s['t1'] - s['t0']) * s.get('a', 1.0))
        T.append((tp, tp + L)); tp += L
    t_out0, t_out1 = T[0][0], T[-1][1]
    # lateral half width
    if width is None:
        ys, xs = np.nonzero(sub[..., 3] > 0.02)
        rel = np.stack([xs + .5 - o[0], ys + .5 - o[1]], 1)
        width = float(np.abs(rel @ n).max()) + 2
    ro = math.radians(out_phi)
    do = np.array([math.sin(ro), math.cos(ro)]); no = np.array([math.cos(ro), -math.sin(ro)])
    corners = [do * t + no * u for t in (t_out0, t_out1) for u in (-width, width)]
    cx = [c[0] for c in corners]; cy = [c[1] for c in corners]
    W = int(math.ceil(max(cx) - min(cx))) + 2 * pad
    H = int(math.ceil(max(cy) - min(cy))) + 2 * pad
    Pout = np.array([-min(cx) + pad, -min(cy) + pad])
    acc = np.zeros((H, W, 4), np.float32)
    offs = [((i + .5) / ss) for i in range(ss)]
    for oy in offs:
        for ox in offs:
            yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
            qx = xx + ox - Pout[0]; qy = yy + oy - Pout[1]
            tq = qx * do[0] + qy * do[1]; up = qx * no[0] + qy * no[1]
            src_t = np.full_like(tq, np.nan); src_u = np.full_like(up, np.nan)
            keep = np.ones_like(tq)
            for s, (a0, a1) in zip(segs, T):
                m = (tq >= a0) & (tq < a1) if s is not segs[-1] else (tq >= a0) & (tq <= a1 + 1e-6)
                if s is segs[0]: m |= tq < a0
                if s is segs[-1]: m |= tq > a1
                f = np.clip((tq - a0) / max(a1 - a0, 1e-6), 0, 1)
                l = s.get('l', 1.0)
                lv = (l[0] + (l[1] - l[0]) * f) if isinstance(l, (tuple, list)) else l
                if 'hold' in s:
                    st = np.full_like(tq, s['hold'])
                else:
                    st = s['t0'] + (tq - a0) * (s['t1'] - s['t0']) / max(a1 - a0, 1e-6)
                su = s.get('u0', 0.0) + up / lv
                src_t = np.where(m, st, src_t); src_u = np.where(m, su, src_u)
                if 'uw' in s:
                    # lateral clamp (source pixels) with a 1.5 px soft edge
                    lim = s['uw']
                    c = np.clip((lim - np.abs(su - s.get('u0', 0.0))) / 1.5 + 0.5, 0, 1)
                    keep = np.where(m, c, keep)
            sx = o[0] + d[0] * src_t + n[0] * src_u
            sy = o[1] + d[1] * src_t + n[1] * src_u
            acc += at.sample(np.nan_to_num(sx, nan=-1e4), np.nan_to_num(sy, nan=-1e4), sub) * keep[..., None]
    acc /= ss * ss
    if mirror_src:
        acc = acc[:, ::-1].copy(); Pout = np.array([W - Pout[0], Pout[1]])
    return acc, Pout, T


class Packer:
    """Append new sprites into a band below the original atlas."""
    def __init__(self, at, band_h=256, gutter=14):
        self.at = at
        self.y0 = at.H
        self.band_h = band_h
        self.g = gutter
        self.x = gutter
        self.rowy = at.H + gutter
        self.rowh = 0
        pad = np.zeros((band_h, at.W, 4), np.float32)
        at.px = np.concatenate([at.px, pad], 0)
        at.H = at.px.shape[0]

    def add(self, img):
        h, w = img.shape[:2]
        if self.x + w + self.g > self.at.W:
            self.x = self.g; self.rowy += self.rowh + self.g; self.rowh = 0
        if self.rowy + h + self.g > self.at.H:
            extra = self.rowy + h + self.g - self.at.H
            extra = int(math.ceil(extra / 64.0) * 64)
            self.at.px = np.concatenate([self.at.px, np.zeros((extra, self.at.W, 4), np.float32)], 0)
            self.at.H = self.at.px.shape[0]
        x, y = self.x, self.rowy
        self.at.px[y:y + h, x:x + w] = img
        self.x += w + self.g; self.rowh = max(self.rowh, h)
        # tight source rect around painted pixels
        a = img[..., 3]
        ys, xs = np.nonzero(a > 0.002)
        bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        return [int(x + bx0), int(y + by0), int(bx1 - bx0), int(by1 - by0)], (int(bx0), int(by0))


def erase_colour(at, rect, P, phi, t_from, t_to, pred, feather=1.5, limit=None):
    """Erase pixels matching pred(rgb, alpha) -> bool within an axial band."""
    from PIL import Image as _I, ImageFilter as _F
    x0, y0, x1, y1 = rect
    xs, ys = at.region_grid(rect)
    o, d, n = at.frame(P, phi)
    rel = np.stack([xs - o[0], ys - o[1]], -1)
    t = rel @ d
    sub = at.px[y0:y1, x0:x1]
    al = sub[..., 3]
    rgb = sub[..., :3] / np.maximum(al[..., None], 1e-4)
    m = pred(rgb, al) & (t >= t_from) & (t <= t_to)
    mi = _I.fromarray((m * 255).astype(np.uint8)).filter(_F.MaxFilter(3)).filter(_F.GaussianBlur(feather))
    k = np.asarray(mi, np.float32) / 255.0
    if limit is not None:
        k = k * limit[y0:y1, x0:x1]
    sub *= (1 - k)[..., None]

def skin_pred(rgb, al):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (al > 0.05) & (r > 0.55) & (r > b + 0.12) & (g > 0.35)


def component_mask(at, seed_rect, thr=0.03):
    """Mask (float) of the 8-connected opaque component(s) intersecting the centre of seed_rect."""
    from collections import deque
    x0, y0, x1, y1 = seed_rect
    a = at.px[..., 3] > thr
    H, W = a.shape
    lab = np.zeros((H, W), bool)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    # nearest opaque pixel to the centre within the rect
    ys, xs = np.nonzero(a[y0:y1, x0:x1])
    k = np.argmin((xs + x0 - cx) ** 2 + (ys + y0 - cy) ** 2)
    sy, sx = ys[k] + y0, xs[k] + x0
    q = deque([(sy, sx)]); lab[sy, sx] = True
    while q:
        y, x = q.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and a[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = True; q.append((ny, nx))
    return lab.astype(np.float32)

def remove_fragments(at, rect, keep_largest=1, thr=0.03):
    """Within rect, keep only the largest connected opaque component(s)."""
    import sys
    sys.path.insert(0, '.')
    from cc import components
    x0, y0, x1, y1 = rect
    sub = at.px[y0:y1, x0:x1]
    lab, comps = components(sub[..., 3] > thr, min_area=1)
    comps.sort(key=lambda c: -c[2])
    keep = np.zeros(lab.shape, bool)
    for c in comps[:keep_largest]:
        keep |= lab == c[0]
    # soften: keep partial-alpha pixels adjacent to kept ones
    from PIL import Image as _I, ImageFilter as _F
    k = np.asarray(_I.fromarray((keep * 255).astype(np.uint8)).filter(_F.MaxFilter(3)), np.float32) / 255
    sub *= k[..., None]


def compose_limb(at, sr, P, phi, layers, out_range, width, pad=6, ss=3, mask=None):
    """Build an upright limb sprite from layers composited bottom-to-top.
    Each layer is a list of segments with explicit output axial ranges:
      {'o0','o1', 't0','t1' (linear map) or 'hold' (constant source t),
       'l' lateral scale (scalar or (top,bottom)), 'u0' source lateral centre,
       'uw' optional lateral half-width clamp (source px), 'fade' optional
       (top_px, bottom_px) alpha ramps at the segment ends}.
    Output axial 0 corresponds to the elbow/pivot; returns (img, Pout)."""
    sub = np.zeros_like(at.px)
    x0, y0 = sr[0], sr[1]
    sub[y0:y0 + sr[3], x0:x0 + sr[2]] = at.px[y0:y0 + sr[3], x0:x0 + sr[2]]
    if mask is not None:
        sub *= fit_mask(mask, sub.shape[0])[..., None]
    o = np.array([sr[0] + P[0], sr[1] + P[1]], float)
    r = math.radians(phi); d = np.array([math.sin(r), math.cos(r)]); n = np.array([math.cos(r), -math.sin(r)])
    t_out0, t_out1 = out_range
    W = int(math.ceil(2 * width)) + 2 * pad
    H = int(math.ceil(t_out1 - t_out0)) + 2 * pad
    Pout = np.array([W / 2.0, -t_out0 + pad])
    out = np.zeros((H, W, 4), np.float32)
    offs = [((i + .5) / ss) for i in range(ss)]
    for layer in layers:
        acc = np.zeros((H, W, 4), np.float32)
        for oy in offs:
            for ox in offs:
                yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
                up = xx + ox - Pout[0]; tq = yy + oy - Pout[1]
                val = np.zeros((H, W, 4), np.float32)
                for s in layer:
                    a0, a1 = s['o0'], s['o1']
                    m = (tq >= a0) & (tq < a1)
                    if not m.any(): continue
                    f = np.clip((tq - a0) / max(a1 - a0, 1e-6), 0, 1)
                    l = s.get('l', 1.0)
                    lv = (l[0] + (l[1] - l[0]) * f) if isinstance(l, (tuple, list)) else l
                    u0 = s.get('u0', 0.0)
                    su = u0 + up / lv
                    if 'hold' in s:
                        hs = s['hold'] if isinstance(s['hold'], (tuple, list)) else (s['hold'], s['hold'])
                        hts = np.linspace(hs[0], hs[1], max(1, int(abs(hs[1] - hs[0])) + 1))
                        v = np.zeros(tq.shape + (4,), np.float32)
                        for ht in hts:
                            sx = o[0] + d[0] * ht + n[0] * su; sy = o[1] + d[1] * ht + n[1] * su
                            v += at.sample(sx, sy, sub)
                        v /= len(hts)
                    else:
                        st = s['t0'] + f * (s['t1'] - s['t0'])
                        sx = o[0] + d[0] * st + n[0] * su; sy = o[1] + d[1] * st + n[1] * su
                        v = at.sample(sx, sy, sub)
                    k = np.ones_like(tq)
                    if 'uw' in s:
                        k *= np.clip((s['uw'] - np.abs(su - u0)) / 1.5 + 0.5, 0, 1)
                    if 'fade' in s:
                        ft, fb = s['fade']
                        if ft: k *= np.clip((tq - a0) / ft, 0, 1)
                        if fb: k *= np.clip((a1 - tq) / fb, 0, 1)
                    val = np.where(m[..., None], v * k[..., None], val)
                acc += val
        acc /= ss * ss
        out = acc + out * (1 - acc[..., 3:4])
    return out, Pout


def relocate(at, pk, rect, seed=None):
    """Copy one cutout (its connected component inside rect) to the packer band.
    Returns (new_sourceRect, origin) where origin is the original atlas pixel
    that maps to the new sourceRect's top-left corner."""
    x0, y0, x1, y1 = rect
    m = component_mask(at, seed or rect)
    block = (at.px * m[..., None])[y0:y1, x0:x1].copy()
    sr, off = pk.add(block)
    return sr, (x0 + off[0], y0 + off[1])


def soften_end(at, rect, P, phi, t_tip, t_cut, end, mask, soft=7.0, inset=3.0):
    """Make an overlapping limb end blend into the piece beneath it: repaint
    the cap (including its painted contour) with mirrored interior material
    and feather its alpha toward the tip."""
    x0, y0, x1, y1 = rect
    t0 = t_cut + inset if end == 'top' else t_cut - inset
    at.heal_end(rect, P, phi, t0, end=end, edge_keep=0.0, edge_soft=1.0, mask=mask, seam=3.0)
    xs, ys = at.region_grid(rect)
    o, d, n = at.frame(P, phi)
    rel = np.stack([xs - o[0], ys - o[1]], -1)
    t = rel @ d
    k = np.clip((t - t_tip) / soft, 0, 1) if end == 'top' else np.clip((t_tip - t) / soft, 0, 1)
    k = k * k * (3 - 2 * k)
    m = fit_mask(mask, at.H)[y0:y1, x0:x1]
    f = 1 - m * (1 - k)
    at.px[y0:y1, x0:x1] *= f[..., None]


def extend_bottom(at, rect, mask, k=5, inset=4, reach=30, extra=2):
    """Square off a cutout's rounded bottom edge so it can tuck under the
    piece below: every column that ends near the bottom is extended with its
    own interior colour down to the lowest edge (plus `extra` px)."""
    x0, y0, x1, y1 = rect
    m = fit_mask(mask, at.H)
    a = at.px[..., 3] * m
    bottoms = {}
    for x in range(x0, x1):
        col = np.nonzero(a[y0:y1, x] > 0.5)[0]
        if len(col): bottoms[x] = y0 + col.max()
    yflat = max(bottoms.values()) + extra
    cols = [x for x, yb in bottoms.items() if yb >= yflat - extra - reach]
    left, right = min(cols), max(cols)
    src = at.px.copy()
    for x in cols:
        yb = bottoms[x]
        xs = min(max(x, left + inset), right - inset)
        ys = max(y0, bottoms.get(xs, yb) - k)
        colour = src[ys, xs].copy()
        if colour[3] < 0.5:
            continue
        colour = colour / colour[3]          # opaque, same hue
        for y in range(max(y0, yb - k + 1), min(at.H, yflat + 1)):
            t = 1.0 if y < yflat else 0.5
            at.px[y, x] = colour * t + at.px[y, x] * (1 - t) * (y >= yflat)
    return yflat


def local_mask(at, rect, thr=0.03):
    """Largest connected piece inside rect only (pieces touching outside the
    rect, such as hair tips brushing a torso, stay separate)."""
    import sys; sys.path.insert(0, '.')
    from cc import components
    x0, y0, x1, y1 = rect
    lab, comps = components(at.px[y0:y1, x0:x1, 3] > thr, min_area=1)
    main = max(comps, key=lambda c: c[2])
    m = np.zeros(at.px.shape[:2], np.float32)
    m[y0:y1, x0:x1] = lab == main[0]
    from PIL import Image as _I, ImageFilter as _F
    grown = np.asarray(_I.fromarray((m * 255).astype(np.uint8)).filter(_F.MaxFilter(3)), np.float32) / 255
    return np.minimum(grown, (at.px[..., 3] > 0).astype(np.float32))


def relocate_local(at, pk, rect, bottom_room=10):
    """Copy the largest piece inside rect (crop-local connectivity) into the
    packer band, with free rows below it. Returns (new sourceRect, origin):
    origin is the original atlas pixel that maps to the new rect's corner."""
    x0, y0, x1, y1 = rect
    m = local_mask(at, rect)
    block = (at.px * m[..., None])[y0:y1, x0:x1].copy()
    block = np.concatenate([block, np.zeros((bottom_room,) + block.shape[1:], block.dtype)], 0)
    sr, off = pk.add(block)
    sr = [sr[0], sr[1], sr[2], sr[3] + 0]
    return sr, (x0 + off[0], y0 + off[1])
