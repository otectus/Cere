import sys, json; sys.path.insert(0,'.')
import numpy as np
from edits import extend_bottom, local_mask, relocate_local, Atlas, rebuild_limb, Packer, erase_colour, skin_pred, component_mask, compose_limb, fit_mask, soften_end
from endprof import detect_cut
ORIG = 'originals/nova-puppet.png'
L = json.load(open('lmk-nova.json'))
SR = {'leftThigh':[879,285,166,256],'rightThigh':[1258,285,166,254],'leftSleeve':[854,534,174,226],'rightSleeve':[1261,536,179,215],
      'leftBoot':[98,533,166,236],'rightBoot':[549,514,163,255],'leftHand':[151,763,105,255],'rightHand':[554,764,111,254],'leftPalm':[890,761,139,258],
      'hips':[456,290,284,224]}
def rect(sr, pad=0):
    return (sr[0] - pad, sr[1] - pad, sr[0] + sr[2] + pad, sr[1] + sr[3] + pad)
def absP(n, key='P'):
    sr = SR[n]; p = L[n][key]; return (sr[0] + p[0], sr[1] + p[1])
def build(out='out/nova-puppet.png', mid=0.88, knee=0.88):
    at = Atlas(ORIG)
    M = {n: component_mask(at, rect(sr)) for n, sr in SR.items()}
    # Hips: drop the bare waist cap above the belt and the leg stubs below the shorts.
    at.erase([(530, 286), (670, 286), (670, 309), (640, 312), (600, 313), (560, 312), (530, 309)], feather=1.0, limit=M['hips'])
    hem = [(450, 446), (505, 448), (512, 432), (520, 427), (530, 420), (540, 418), (550, 419), (560, 421), (570, 424),
           (580, 428), (590, 433), (600, 442), (610, 447), (620, 442), (630, 434), (640, 429), (650, 425), (660, 422),
           (670, 419), (680, 417), (690, 416), (700, 417), (712, 415), (720, 414), (730, 418), (750, 421)]
    at.erase(hem + [(750, 530), (450, 530)], feather=1.0, limit=M['hips'])
    # Thighs: slim the knee end toward the calf.
    for n in ('leftThigh', 'rightThigh'):
        i = L[n]
        tt, bt, dip = detect_cut(at, SR[n], i['P'], i['phi'], 'bottom', i['rD'])
        soften_end(at, rect(SR[n]), absP(n), i['phi'], tt, min(bt, tt - 14), 'bottom', M[n])
        at.taper(rect(SR[n]), absP(n), L[n]['phi'], 25, 110, mid, mask=M[n])
        at.taper(rect(SR[n]), absP(n), L[n]['phi'], 110, 200, knee, mask=M[n])
    # Upper arms: smooth the shoulder cap and remove the forearm stub painted
    # inside the bunched sleeve (the forearm cutout supplies it).
    for n in ('leftSleeve', 'rightSleeve'):
        i = L[n]
        tt, bt, dip = detect_cut(at, SR[n], i['P'], i['phi'], 'top', i['rP'])
        soften_end(at, rect(SR[n]), absP(n), i['phi'], tt, bt, 'top', M[n])
        erase_colour(at, rect(SR[n]), absP(n), i['phi'], 120, 400, skin_pred, limit=M[n])
    for n in ('leftBoot', 'rightBoot'):
        i = L[n]
        at.heal_end(rect(SR[n]), absP(n), i['phi'], -6, end='top', mask=M[n], edge_keep=0.0, edge_soft=1.0)
    pk = Packer(at)
    # Torso: the rounded midriff end curved in just above the belt. A copy in
    # the free band is squared off so the waist meets the belt without a
    # notch (the belt covers the new edge); the original sits flush with the
    # boots below it, so it is not extended in place.
    tsr = [136, 288, 180, 248]
    tr, origin = relocate_local(at, pk, (tsr[0], tsr[1], tsr[0] + tsr[2], tsr[1] + tsr[3]))
    band = (tr[0] - 2, tr[1] - 2, tr[0] + tr[2] + 2, tr[1] + tr[3] + 12)
    extend_bottom(at, band, local_mask(at, band))
    new = {}
    # Forearms: remove the skin cap above the cuff, lengthen the bare forearm
    # under the bunched sleeve and bring the hands to natural size.
    for n, (b1, w0, w1, uc, sc, uw) in (('leftHand', (38, 44, 72, 13, 15, 20)), ('rightHand', (38, 44, 72, -15.5, -17.5, 20)),
                                        ('leftPalm', (35, 41, 70, 12, 12, 22))):
        i = L[n]
        erase_colour(at, rect(SR[n]), absP(n), i['phi'], -80, -24, skin_pred, limit=M[n])
        m = fit_mask(M[n], at.H) * (at.px[..., 3] > 0.03)
        fl = 66
        band0 = b1 + fl
        hand = 0.8
        skin = [dict(o0=10, o1=band0 + 6, hold=(86, 92), u0=sc, l=(1.22, 1.02), uw=uw)]
        top = [dict(o0=-31, o1=b1 + 3, t0=-31, t1=b1 + 3, fade=(2.0, 4)),
               dict(o0=band0 + 2, o1=band0 + (w1 - w0), t0=w0 + 2, t1=w1, u0=uc, uw=26),
               dict(o0=band0 + (w1 - w0), o1=band0 + (w1 - w0) + (225 - w1) * hand, t0=w1, t1=225, u0=uc, l=hand)]
        img, Pout = compose_limb(at, SR[n], i['P'], i['phi'], [skin, top], (-34, band0 + (w1 - w0) + (225 - w1) * hand + 2), 64, mask=m)
        sr, off = pk.add(img)
        new[n] = {'sr': sr, 'P': (float(Pout[0] - off[0]), float(Pout[1] - off[1])), 'phi': 0.0, 'rP': i['rP']}
    # Boots: widen the calf so the knee meets the boot shaft; keep the painted
    # orientation so the sole stays flat on the ground.
    for n in ('leftBoot', 'rightBoot'):
        i = L[n]
        segs = [dict(t0=-40, t1=36, l=(1.38, 1.18)), dict(t0=36, t1=46, l=(1.18, 1.0)), dict(t0=46, t1=260)]
        img, Pout, T = rebuild_limb(at, SR[n], i['P'], i['phi'], segs, mask=M[n], out_phi=i['phi'])
        sr, off = pk.add(img)
        a = img[..., 3]; ys, xs = np.nonzero(a > 0.5); yb = ys.max(); xb = xs[ys >= yb - 2].mean()
        new[n] = {'sr': sr, 'P': (float(Pout[0] - off[0]), float(Pout[1] - off[1])), 'phi': i['phi'], 'rP': i['rP'] * 1.38,
                  'sole': (float(xb - off[0]), float(yb - off[1]))}
    new['torso'] = {'sr': [band[0], band[1], band[2] - band[0], band[3] - band[1]], 'origin': (origin[0] - 2, origin[1] - 2), 'orig_sr': tsr}
    at.save(out)
    json.dump(new, open('out/nova-new.json', 'w'), indent=1)
    return at, new
if __name__ == '__main__':
    at, new = build()
    for k, v in new.items(): print(k, v['sr'], [round(x, 1) for x in v.get('P', v.get('origin'))])
