import sys, json; sys.path.insert(0,'.')
from edits import extend_bottom, local_mask, relocate_local, Atlas, rebuild_limb, Packer, component_mask, soften_end
from endprof import detect_cut
ORIG = 'originals/jade-puppet.png'
L = json.load(open('lmk-jade.json'))
SR = {'leftThigh':[905,304,147,244],'rightThigh':[1256,303,148,244],'leftSleeve':[872,557,130,193],'rightSleeve':[1296,552,132,183],
      'leftBoot':[115,547,148,218],'rightBoot':[556,548,143,217],'leftHand':[136,796,111,225],'rightHand':[573,795,107,226],'leftPalm':[881,796,136,221],
      'hips':[438,292,300,182]}
def rect(sr, pad=0):
    return (sr[0] - pad, sr[1] - pad, sr[0] + sr[2] + pad, sr[1] + sr[3] + pad)
def absP(n, key='P'):
    sr = SR[n]; p = L[n][key]; return (sr[0] + p[0], sr[1] + p[1])
def heal(at, M, n, end, margin=3, contour=True):
    i = L[n]; r = i['rP'] if end == 'top' else i['rD']
    tt, bt, dip = detect_cut(at, SR[n], i['P'], i['phi'], end, r)
    t0 = bt - margin if end == 'bottom' else bt + margin
    at.heal_end(rect(SR[n]), absP(n), i['phi'], t0, end=end, mask=M[n], **({} if contour else {'edge_keep': 0.0, 'edge_soft': 1.0}))
def soft(at, M, n, end):
    # an overlapping skin end: repaint its contour and feather it into the piece below
    i = L[n]; r = i['rP'] if end == 'top' else i['rD']
    tt, bt, dip = detect_cut(at, SR[n], i['P'], i['phi'], end, r)
    soften_end(at, rect(SR[n]), absP(n), i['phi'], tt, bt, end, M[n])
def forearm_segments(cuff0, cuff1, top=-32, end=222, forearm_len=96, hand=0.78):
    return [dict(t0=top, t1=5),
            dict(t0=5, t1=cuff0, len=forearm_len, l=(1.0, 0.95)),
            dict(t0=cuff0, t1=cuff1),
            dict(t0=cuff1, t1=cuff1 + 10, len=10 * (1 + hand) / 2, l=(1.0, hand)),
            dict(t0=cuff1 + 10, t1=end, a=hand, l=hand)]
def build(out='out/jade-puppet.png', taper=0.9, mid=0.86):
    at = Atlas(ORIG)
    M = {n: component_mask(at, rect(sr)) for n, sr in SR.items()}
    for n in ('leftThigh', 'rightThigh'):
        soft(at, M, n, 'bottom'); heal(at, M, n, 'top')
        # Slim the thigh toward the knee: full at the hip, narrowing smoothly
        # through mid-thigh to the calf width at the knee.
        at.taper(rect(SR[n]), absP(n), L[n]['phi'], 20, 95, mid, mask=M[n])
        at.taper(rect(SR[n]), absP(n), L[n]['phi'], 95, 175, taper, mask=M[n])
    for n in ('leftSleeve', 'rightSleeve'):
        soft(at, M, n, 'top'); heal(at, M, n, 'bottom', contour=False)
    for n in ('leftBoot', 'rightBoot'):
        heal(at, M, n, 'top', contour=False)
    for n in ('leftHand', 'rightHand', 'leftPalm'):
        soft(at, M, n, 'top')
    # Hips: the belt overlays the midriff, so drop the bare waist cylinder above it,
    # and end the outfit at the skirt and shorts; the thighs supply the legs.
    at.erase([(538, 290), (660, 290), (660, 327), (640, 324), (600, 323), (560, 324), (538, 327)], feather=1.0, limit=M['hips'])
    hem = [(430, 440), (470, 446), (495, 432), (521, 432), (526, 446), (546, 456), (575, 462), (600, 468),
           (625, 462), (654, 456), (674, 446), (679, 432), (705, 432), (730, 446), (750, 440)]
    at.erase(hem + [(750, 540), (430, 540)], feather=1.0, limit=M['hips'])
    # Forearms: lengthen the bare forearm and bring the gloved hands to
    # natural size, stored upright in a new atlas band.
    pk = Packer(at)
    # Torso: the rounded midriff end curved in just above the belt. A copy in
    # the free band is squared off so the waist meets the belt without a
    # notch (the belt covers the new edge); the original sits flush with the
    # boots below it, so it is not extended in place.
    tsr = [118, 297, 195, 246]
    tr, origin = relocate_local(at, pk, (tsr[0], tsr[1], tsr[0] + tsr[2], tsr[1] + tsr[3]))
    band = (tr[0] - 2, tr[1] - 2, tr[0] + tr[2] + 2, tr[1] + tr[3] + 12)
    extend_bottom(at, band, local_mask(at, band))
    new = {}
    for n, cuff in (('leftHand', (46, 88)), ('rightHand', (46, 88)), ('leftPalm', (49, 82))):
        i = L[n]
        img, Pout, T = rebuild_limb(at, SR[n], i['P'], i['phi'], forearm_segments(*cuff), mask=M[n])
        sr, off = pk.add(img)
        new[n] = {'sr': sr, 'P': (float(Pout[0] - off[0]), float(Pout[1] - off[1])), 'phi': 0.0, 'rP': i['rP']}
    new['torso'] = {'sr': [band[0], band[1], band[2] - band[0], band[3] - band[1]], 'origin': (origin[0] - 2, origin[1] - 2), 'orig_sr': tsr}
    at.save(out)
    json.dump(new, open('out/jade-new.json', 'w'), indent=1)
    return at, new
if __name__ == '__main__':
    at, new = build()
    for k, v in new.items(): print(k, v['sr'], [round(x, 1) for x in v.get('P', v.get('origin'))])
