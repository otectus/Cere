import sys, json, math; sys.path.insert(0,'.')
import numpy as np
from edits import extend_bottom, local_mask, relocate_local, Atlas, rebuild_limb, Packer, component_mask, soften_end
from endprof import detect_cut
ORIG = 'originals/cere-puppet-reference.png'
L = json.load(open('lmk-cere.json'))
SR = {'leftThigh':[845,317,148,256],'rightThigh':[1269,317,148,256],'leftSleeve':[907,572,65,166],
      'leftBoot':[135,551,124,217],'rightBoot':[516,550,120,218],
      'leftForearmL':[140,770,80,245],'rightForearmR':[548,770,76,245],'openForearm':[872,744,110,272],
      'hips':[466,340,218,132]}
def rect(sr, pad=0):
    return (sr[0] - pad, sr[1] - pad, sr[0] + sr[2] + pad, sr[1] + sr[3] + pad)
def absP(n, key='P'):
    sr = SR[n]; p = L[n][key]; return (sr[0] + p[0], sr[1] + p[1])
def build(out='out/cere-puppet-reference.png', arm_stretch=1.35, skin_len=125, glove=0.8, thigh_a=1.1, thigh_l=0.72):
    at = Atlas(ORIG)
    M = {n: component_mask(at, rect(sr)) for n, sr in SR.items()}
    # Hips: the bare waist cap above the belt is always under the torso.
    at.erase([(460, 335), (690, 335), (690, 355), (460, 355)], feather=1.0, limit=M['hips'])
    # Skin-on-skin joints: the shoulder cap lies over the torso's shoulder and
    # the forearm's elbow cap over the upper arm, so their painted contours
    # are repainted with interior skin and feathered toward the tip.
    i = L['leftSleeve']
    tt, bt, dip = detect_cut(at, SR['leftSleeve'], i['P'], i['phi'], 'top', i['rP'])
    soften_end(at, rect(SR['leftSleeve']), absP('leftSleeve'), i['phi'], tt, bt, 'top', M['leftSleeve'])
    tt, bt, dip = detect_cut(at, SR['leftSleeve'], i['P'], i['phi'], 'bottom', i['rD'])
    at.heal_end(rect(SR['leftSleeve']), absP('leftSleeve'), i['phi'], bt - 3, end='bottom', edge_keep=0.0, edge_soft=1.0, mask=M['leftSleeve'])
    for n in ('leftForearmL', 'rightForearmR', 'openForearm'):
        i = L[n]
        tt, bt, dip = detect_cut(at, SR[n], i['P'], i['phi'], 'top', i['rP'])
        soften_end(at, rect(SR[n]), absP(n), i['phi'], tt, bt, 'top', M[n])
    pk = Packer(at)
    # Torso: the rounded midriff end curved in just above the belt. A copy in
    # the free band is squared off so the waist meets the belt without a
    # notch (the belt covers the new edge); the original sits flush with the
    # boots below it, so it is not extended in place.
    tsr = [100, 324, 206, 228]
    tr, origin = relocate_local(at, pk, (tsr[0], tsr[1], tsr[0] + tsr[2], tsr[1] + tsr[3]))
    band = (tr[0] - 2, tr[1] - 2, tr[0] + tr[2] + 2, tr[1] + tr[3] + 12)
    extend_bottom(at, band, local_mask(at, band))
    new = {}
    # Upper arm: a slimmer, longer shaft between the same rounded ends.
    i = L['leftSleeve']
    segs = [dict(t0=-40, t1=20), dict(t0=20, t1=95, a=arm_stretch), dict(t0=95, t1=150)]
    img, Pout, T = rebuild_limb(at, SR['leftSleeve'], i['P'], i['phi'], segs, mask=M['leftSleeve'])
    sr, off = pk.add(img)
    Dt = 20 + 75 * arm_stretch + (111.9 - 95)
    new['upperArm'] = {'sr': sr, 'P': (float(Pout[0] - off[0]), float(Pout[1] - off[1])),
                       'D': (float(Pout[0] - off[0]), float(Pout[1] - off[1] + Dt)), 'rP': i['rP'], 'rD': i['rD']}
    # Forearms: longer bare forearms and smaller gloved hands.
    for n, (s1, c0, c1) in (('leftForearmL', (75, 75, 102)), ('rightForearmR', (75, 75, 102)), ('openForearm', (86, 86, 118))):
        i = L[n]
        segs = [dict(t0=-35, t1=5, l=1.12),
                dict(t0=5, t1=s1, len=skin_len, l=(1.12, 1.0)),
                dict(t0=c0, t1=c1),
                dict(t0=c1, t1=c1 + 8, len=8 * (1 + glove) / 2, l=(1.0, glove)),
                dict(t0=c1 + 8, t1=260, a=glove, l=glove)]
        img, Pout, T = rebuild_limb(at, SR[n], i['P'], i['phi'], segs, mask=M[n])
        sr, off = pk.add(img)
        new[n] = {'sr': sr, 'P': (float(Pout[0] - off[0]), float(Pout[1] - off[1])), 'rP': i['rP'] * 1.12}
    # Thighs: the baggy cargo legs are narrowed and lengthened so the trouser
    # leg reads continuous from the yoke to the boot cuff.
    for n in ('leftThigh', 'rightThigh'):
        i = L[n]
        segs = [dict(t0=-80, t1=200, a=thigh_a, l=thigh_l)]
        img, Pout, T = rebuild_limb(at, SR[n], i['P'], i['phi'], segs, mask=M[n])
        sr, off = pk.add(img)
        Dt = math.dist(i['P'], i['D']) * thigh_a
        P2 = (float(Pout[0] - off[0]), float(Pout[1] - off[1]))
        new[n] = {'sr': sr, 'P': P2, 'D': (P2[0], P2[1] + Dt), 'rP': i['rP'] * thigh_l, 'rD': i['rD'] * thigh_l}
    new['torso'] = {'sr': [band[0], band[1], band[2] - band[0], band[3] - band[1]], 'origin': (origin[0] - 2, origin[1] - 2), 'orig_sr': tsr}
    at.save(out)
    json.dump(new, open('out/cere-new.json', 'w'), indent=1)
    return at, new
if __name__ == '__main__':
    at, new = build()
    for k, v in new.items(): print(k, v['sr'], [round(x, 1) for x in v.get('P', v.get('origin'))])
