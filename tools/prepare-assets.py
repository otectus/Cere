#!/usr/bin/env python3
"""Losslessly extract the legacy atlas from separately supplied animation artwork.

The original combined GIF (all-states.gif) is not distributed with this
repository. Supply it with --input; the shipped PNGs are only replaced when
--output points at the assets directory. The source GIF is never modified.
"""
from pathlib import Path
import argparse
import json
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', type=Path, default=root / 'all-states.gif',
                    help='original combined animation GIF (not included in this checkout)')
parser.add_argument('--output', type=Path, default=root / 'assets',
                    help='directory for cere-atlas.png, cere-mask.png, cere.png and animations.json')
parser.add_argument('--check', action='store_true',
                    help='verify the source against assets/animations.json without writing anything')
args = parser.parse_args()

# Preflight before any import or write, so a clean checkout fails with guidance.
if not args.input.is_file():
    sys.exit(f'Original artwork not found: {args.input}\n'
             'The combined all-states.gif is not distributed with this repository. '
             'Supply your authorized copy with --input PATH. The shipped assets are unchanged.')
try:
    from PIL import Image, ImageChops
except ImportError:
    sys.exit('Pillow is required: install python-pillow (or pip install Pillow).')

source = Image.open(args.input)
if source.size != (192, 208):
    sys.exit(f'{args.input} is {source.size[0]}x{source.size[1]}; the atlas contract requires 192x208 frames.')
frames, durations = [], []
for n in range(source.n_frames):
    source.seek(n)
    frames.append(source.convert('RGBA'))
    durations.append(source.info.get('duration', 140))
expected = json.loads((root / 'assets' / 'animations.json').read_text())
if len(frames) != len(expected['durations']):
    sys.exit(f'{args.input} has {len(frames)} frames; assets/animations.json expects {len(expected["durations"])}.')
if args.check:
    print(f'{args.input}: {len(frames)} frames of 192x208 match assets/animations.json; nothing written.')
    sys.exit(0)

out = args.output
out.mkdir(parents=True, exist_ok=True)
atlas = Image.new('RGBA', (192 * len(frames), 208))
mask = Image.new('L', (192, 208))
for n, frame in enumerate(frames):
    atlas.paste(frame, (192*n, 0))
    mask = ImageChops.lighter(mask, frame.getchannel('A'))
atlas.save(out / 'cere-atlas.png')
mask.save(out / 'cere-mask.png')
frames[0].save(out / 'cere.png')
# Ranges reviewed against every frame of the supplied combined sheet.
animations = {
    'idle': [0,1,2,3,4,5], 'runRight': list(range(6,14)), 'runLeft': list(range(14,22)),
    'wave': [22,23,24,25,24,23,22], 'jump': [26,27,28,29,30,31],
    'look': list(range(32,46)), 'attentive': [47], 'waiting': [52,53,54,55,56],
    'quiet': [0], 'working': [52,53,54,55,56], 'dragging': [28],
}
(out/'animations.json').write_text(json.dumps({'width':192,'height':208,'durations':durations,'animations':animations},indent=2)+'\n')
print(f'Wrote {len(frames)} frames to {out}')
