import numpy as np
from collections import deque
def components(mask, min_area=200):
    """4-connected components via BFS over a boolean mask. Returns list of (bbox, area, label_mask_slice)."""
    H, W = mask.shape
    lab = np.zeros((H, W), np.int32)
    comps = []
    cur = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]: continue
        cur += 1
        q = deque([(y0, x0)]); lab[y0, x0] = cur
        minx = maxx = x0; miny = maxy = y0; area = 0
        while q:
            y, x = q.popleft(); area += 1
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur; q.append((ny, nx))
        comps.append((cur, (int(minx), int(miny), int(maxx) + 1, int(maxy) + 1), area))
    comps = [c for c in comps if c[2] >= min_area]
    return lab, comps
