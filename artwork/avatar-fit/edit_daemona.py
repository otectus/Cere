import sys, json; sys.path.insert(0,'.')
import numpy as np
from edits import Atlas, Packer, erase_colour, component_mask, soften_end
from endprof import detect_cut
ORIG = 'originals/daemona-puppet.png'
L = json.load(open('lmk-daemona.json'))
SR = {'leftThigh':[883,307,184,236],'rightThigh':[1247,307,184,237],'leftSleeve':[849,555,185,215],'rightSleeve':[1269,555,180,170],
      'leftBoot':[110,539,193,240],'rightBoot':[577,536,181,243],'leftHand':[179,782,117,235],'rightHand':[553,783,120,233],'leftPalm':[910,782,162,238],
      'hips':[475,300,294,253]}
def rect(sr, pad=0):
    return (sr[0] - pad, sr[1] - pad, sr[0] + sr[2] + pad, sr[1] + sr[3] + pad)
def absP(n, key='P'):
    sr = SR[n]; p = L[n][key]; return (sr[0] + p[0], sr[1] + p[1])
def red_skin(rgb, al):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (al > 0.05) & (r > 0.45) & (r > g + 0.22) & (r > b + 0.18)
def build(out='out/daemona-puppet.png', mid=0.88):
    at = Atlas(ORIG)
    M = {n: component_mask(at, rect(sr)) for n, sr in SR.items()}
    # Hips: the corset overlaps the waist, so the bare waist cap goes; the
    # thighs supply the legs below the shorts.
    at.erase([(560, 306), (690, 306), (690, 336), (660, 339), (620, 340), (580, 339), (560, 336)], feather=1.0, limit=M['hips'])
    erase_colour(at, (530, 488, 712, 540), (621, 488), 0.0, 0, 60, red_skin, feather=1.2, limit=M['hips'])
    # Boots: the knee covers the boot rim; drop the bare calf stub above it.
    for n in ('leftBoot', 'rightBoot'):
        i = L[n]
        erase_colour(at, rect(SR[n]), absP(n), i['phi'], -90, -28, red_skin, feather=1.2, limit=M[n])
    # Thighs: narrow from mid-thigh to the knee so the leg tapers into the boot.
    for n in ('leftThigh', 'rightThigh'):
        at.taper(rect(SR[n]), absP(n), L[n]['phi'], 30, 120, mid, mask=M[n])
    # Shoulder and elbow caps: smooth painted cut faces.
    for n in ('leftSleeve', 'rightSleeve'):
        i = L[n]
        tt, bt, dip = detect_cut(at, SR[n], i['P'], i['phi'], 'top', i['rP'])
        soften_end(at, rect(SR[n]), absP(n), i['phi'], tt, bt, 'top', M[n])
    for n in ('leftHand', 'rightHand', 'leftPalm'):
        i = L[n]
        tt, bt, dip = detect_cut(at, SR[n], i['P'], i['phi'], 'top', i['rP'])
        at.heal_end(rect(SR[n]), absP(n), i['phi'], bt + 3, end='top', mask=M[n])
    Packer(at)
    at.save(out)
    return at, {}
if __name__ == '__main__':
    build()
