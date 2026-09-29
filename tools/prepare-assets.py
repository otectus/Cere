#!/usr/bin/env python3
"""Losslessly extract supplied animation frames; the source GIFs remain untouched."""
from pathlib import Path
from PIL import Image, ImageChops
import json
root = Path(__file__).resolve().parents[1]
out = root / 'assets'
out.mkdir(exist_ok=True)
source = Image.open(root / 'all-states.gif')
frames, durations = [], []
for n in range(source.n_frames):
    source.seek(n)
    frames.append(source.convert('RGBA'))
    durations.append(source.info.get('duration', 140))
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
