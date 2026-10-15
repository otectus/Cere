"""Write the fitted avatars into the project assets (base rig, overrides, atlases)."""
import sys, json, shutil, copy, os
sys.path.insert(0, '.')
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets') + '/'
OUT = 'out/final/'
TEX = {'cere': 'cere-puppet-reference.png', 'daemona': 'daemona-puppet.png', 'jade': 'jade-puppet.png', 'nova': 'nova-puppet.png'}

def rounded(v, nd=4):
    if isinstance(v, float):
        r = round(v, nd)
        return int(r) if r == int(r) else r
    if isinstance(v, list): return [rounded(x, nd) for x in v]
    if isinstance(v, dict): return {k: rounded(x, nd) for k, x in v.items()}
    return v

def dump(obj, path):
    with open(path, 'w') as f:
        json.dump(rounded(obj), f, indent=2)
        f.write('\n')

def main(dry=False):
    base_src = json.load(open('originals/cere-rig.json'))    # channels, poses, articulation
    skel = json.load(open(OUT + 'base-rig.json'))              # shared skeleton bones
    cere = json.load(open(OUT + 'cere-rig.json'))
    base = {}
    for k in ('version', 'texture', 'referenceSize', 'bones', 'parts', 'channels', 'poses', 'articulation'):
        base[k] = copy.deepcopy(base_src[k])
    bones = copy.deepcopy(skel['bones'])
    # Cere is the base avatar: her joint registration becomes the skeleton default.
    for b in bones:
        for k, v in cere['boneOverrides'].get(b['name'], {}).items():
            b[k] = v
    base['texture'] = cere['texture']
    base['bones'] = bones
    base['parts'] = cere['parts']
    assert base['channels'] == base_src['channels'] and base['poses'] == base_src['poses']
    out = {'cere-rig.json': base}
    for aid in ('daemona', 'jade', 'nova'):
        r = json.load(open(OUT + aid + '-rig.json'))
        out[aid + '-rig.json'] = {'texture': r['texture'], 'parts': r['parts'], 'boneOverrides': r['boneOverrides']}
    if dry: return out
    for name, obj in out.items():
        dump(obj, A + name)
    for aid, tex in TEX.items():
        shutil.copyfile(OUT + tex, A + tex)
    cat = json.load(open(A + 'avatars.json'))
    for e in cat:
        if e['id'] == 'cere': e.pop('rig', None)
    with open(A + 'avatars.json', 'w') as f:
        json.dump(cat, f, indent=2); f.write('\n')
    return out

if __name__ == '__main__':
    out = main(dry='--dry' in sys.argv)
    for k, v in out.items(): print(k, 'parts', len(v['parts']), 'keys', list(v.keys()))
