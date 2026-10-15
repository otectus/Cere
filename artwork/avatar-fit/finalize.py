"""Regenerate the fitted avatar atlases and rigs from originals/.

Run from this directory: python3 finalize.py cere daemona jade nova, then
python3 integrate.py to write assets/. originals/ holds the imagegen atlases
and rigs as they were before fitting (SHA256SUMS); out/ is scratch."""
import sys, json, importlib; sys.path.insert(0, '.')
import numpy as np
import compose as C
from edits import Atlas
from ofix import apply_eyes
from builder import skeleton, build
from repack import repack, save
RED = {'daemona': True}
def finalize(aid):
    E = importlib.import_module('edit_' + aid)
    at, new = E.build()
    S = importlib.import_module('spec_' + aid)
    base = skeleton(json.load(open('originals/cere-rig.json')), S.SK)
    rig, scales = build(base, S.spec(), S.SK)
    d = C.resolve(base, rig)
    at = Atlas(S.ATLAS)
    eyes = apply_eyes(at, d, RED.get(aid, False))
    for p in rig['parts']:
        if p['name'] in ('curiousEyes', 'wink', 'blink'):
            p['sourceRect'] = eyes[p['name']]['sourceRect']; p['rect'] = eyes[p['name']]['rect']
    px, final = repack(at.px, rig)
    # Both soles meet the common ground line exactly at rest.
    rest = C.world(C.resolve(base, final), {})
    for p in final['parts']:
        if p['name'].endswith('Boot'):
            assert abs(p.get('rotation', 0)) < 1e-9
            shin = rest[p['bone']]
            p['rect'][1] = round(S.SK.get('groundY', 199.8) - shin[5] - p['rect'][3], 4)
            # keep the sum exact after rounding
            p['rect'][3] = round(S.SK.get('groundY', 199.8) - shin[5] - p['rect'][1], 4)
    tex = rig['texture']
    save(px, 'out/final/' + tex)
    json.dump(final, open(f'out/final/{aid}-rig.json', 'w'), indent=1)
    json.dump(base, open('out/final/base-rig.json', 'w'), indent=1)
    return final, base, eyes, px.shape
if __name__ == '__main__':
    import os; os.makedirs('out/final', exist_ok=True)
    for aid in sys.argv[1:]:
        final, base, eyes, shape = finalize(aid)
        print(aid, 'atlas', shape[1], 'x', shape[0], 'parts', len(final['parts']))
