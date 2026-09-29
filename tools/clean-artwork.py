#!/usr/bin/env python3
"""Rebuild smooth transparent sprites from the approved, clean white artwork.

Requires Pillow and NumPy. This is deterministic matte extraction, not a redraw.
Original GIFs and the generated opaque master are never overwritten.
"""
from collections import deque
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]


def largest_component(mask):
    remaining = mask.copy()
    best = []
    height, width = mask.shape
    for y, x in np.argwhere(mask):
        if not remaining[y, x]:
            continue
        queue = deque([(int(y), int(x))])
        remaining[y, x] = False
        points = []
        while queue:
            row, col = queue.popleft()
            points.append((row, col))
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = row + dy, col + dx
                if 0 <= ny < height and 0 <= nx < width and remaining[ny, nx]:
                    remaining[ny, nx] = False
                    queue.append((ny, nx))
        if len(points) > len(best):
            best = points
    result = np.zeros_like(mask)
    if best:
        ys, xs = zip(*best)
        result[ys, xs] = True
    return result


def extract(cell):
    rgb = np.asarray(cell.convert("RGB"), dtype=np.float32)
    # Flood only exterior whites. Enclosed white eye highlights remain opaque.
    binary = Image.fromarray(np.where(rgb.min(axis=2) < 220, 255, 0).astype(np.uint8)).copy()
    ImageDraw.floodfill(binary, (0, 0), 128)
    silhouette = largest_component(np.asarray(binary) != 128)
    mask = Image.fromarray(silhouette.astype(np.uint8) * 255)
    core = np.asarray(mask.filter(ImageFilter.MinFilter(5))) > 0
    support = np.asarray(mask.filter(ImageFilter.MaxFilter(5))) > 0
    edge = support & ~core

    # Estimate local foreground color from the nearest fully covered pixel.
    # Removing the white contribution avoids light fringes on a dark desktop.
    nearest = rgb.copy()
    assigned = core.copy()
    offsets = sorted(((dy, dx) for dy in range(-4, 5) for dx in range(-4, 5)
                      if dy or dx), key=lambda p: p[0] ** 2 + p[1] ** 2)
    h, w = core.shape
    for dy, dx in offsets:
        valid = np.roll(core, (dy, dx), (0, 1))
        if dy > 0: valid[:dy] = False
        if dy < 0: valid[h + dy:] = False
        if dx > 0: valid[:, :dx] = False
        if dx < 0: valid[:, w + dx:] = False
        use = edge & valid & ~assigned
        nearest[use] = np.roll(rgb, (dy, dx), (0, 1))[use]
        assigned |= use
    channel = nearest.argmin(axis=2)[..., None]
    observed = np.take_along_axis(rgb, channel, axis=2)[..., 0]
    foreground = np.take_along_axis(nearest, channel, axis=2)[..., 0]
    alpha = np.clip((255 - observed) / np.maximum(255 - foreground, 1), 0, 1)
    alpha[core] = 1
    alpha[~support] = 0
    alpha[edge & ~assigned] = silhouette[edge & ~assigned]
    alpha[alpha < .045] = 0
    colors = (rgb - 255 * (1 - alpha[..., None])) / np.maximum(alpha[..., None], .001)
    colors[alpha == 0] = 0
    result = np.dstack((np.clip(colors, 0, 255), alpha * 255)).round().astype(np.uint8)
    return Image.fromarray(result)


def main():
    catalog = json.loads((ROOT / "assets/motions.json").read_text())
    master = Image.open(ROOT / "artwork/cere-clean-white.png")
    result = Image.new("RGBA", (catalog["textureWidth"], catalog["textureHeight"]))
    for i, frame in enumerate(catalog["sourceFrames"]):
        x, y, w, h = (frame[key] for key in ("x", "y", "width", "height"))
        clean = extract(master.crop((x, y, x + w, y + h)))
        # Pack onto equal canvases with transparent gutters. Preserve the common
        # foot anchor and original pixel scale instead of stretching short poses.
        packed = Image.new("RGBA", (catalog["frameWidth"], catalog["frameHeight"]))
        packed.paste(clean, ((packed.width-w)//2, packed.height-8-h))
        target = catalog["frames"][i]
        result.paste(packed, (target["x"], target["y"]))
        if i == 0:
            packed.save(ROOT / "assets/cere-polished-icon.png")
    result.save(ROOT / "assets/cere-polished.png")
    print("Saved clean transparent sheet and icon; original artwork preserved.")


if __name__ == "__main__":
    main()
