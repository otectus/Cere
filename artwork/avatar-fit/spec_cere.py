import json
import json, math
SK = dict(pelvisY=137.81, neckY=-39.48, shoulderX=22, shoulderY=-36.12,
          upperArm=22.0, upperArmOut=18.0, forearmOut=15.0,
          hipX=11.55, hipY=6.72, thigh=27.6, thighOut=8.0, shinOut=-4.0)
ATLAS = 'out/cere-puppet-reference.png'
def relocated_torso():
    N = json.load(open('out/cere-new.json'))
    t = N['torso']; o = t['orig_sr']
    def px(p):
        return (o[0] + p[0] - t['origin'][0], o[1] + p[1] - t['origin'][1])
    return t['sr'], px

def spec(st=0.2, sh=0.2, belt_y=-4.5, hipjx=53, fs=1/8.72, thighPt=0):
    N = json.load(open('out/cere-new.json'))
    torso_sr = [100, 324, 206, 228]
    torso_sr, tpx = relocated_torso()
    hips_sr = [466, 350, 218, 122]
    vis = lambda side, lo: {'visibleWhen': {'channel': side + 'HandOpen', ('max' if lo else 'min'): 0.5}}
    ua = N['upperArm']
    def fa(n, side, lo, mirror=False):
        v = N[n]; return {'sr': v['sr'], 'P': tuple(v['P']), 'rP': v['rP'], 'phi': 0.0, 's': fs, 'mirror': mirror, 'extra': vis(side, lo)}
    return {
        'texture': 'cere-puppet-reference.png', 'current': 'cere-reference-rig.json',
        'keep': ['backHair', 'head', 'curiousEyes', 'wink', 'blink'],
        'fixAspect': {'backHair': 'area'},
        'torso': {'sr': torso_sr, 's': st, 'anchor_px': tpx((103, 61)), 'anchor_at': (0, SK['shoulderY']), 'z': 4},
        'hips': {'sr': hips_sr, 's': sh, 'anchor_px': (108.5, 6), 'anchor_at': (0, belt_y), 'z': 4.5},
        'shoulders': {'left': tpx((30, 61)), 'right': tpx((176, 61))},
        'hipJoints': {'left': (108.5 - hipjx, None), 'right': (108.5 + hipjx, None)},
        'upperArm': {'z': 5,
            'left': {'sr': ua['sr'], 'P': tuple(ua['P']), 'D': tuple(ua['D']), 'rP': ua['rP'], 'rD': ua['rD']},
            'right': {'sr': ua['sr'], 'P': tuple(ua['P']), 'D': tuple(ua['D']), 'rP': ua['rP'], 'rD': ua['rD'], 'mirror': True, 'name': 'rightSleeve'}},
        'forearm': {'z': 10,
            'left': {'leftHand': fa('leftForearmL', 'left', True), 'leftPalm': fa('openForearm', 'left', False)},
            'right': {'rightHand': fa('rightForearmR', 'right', True), 'rightPalm': fa('openForearm', 'right', False, True)}},
        'thigh': {'z': 2,
            'left': {'sr': N['leftThigh']['sr'], 'P': tuple(N['leftThigh']['P']), 'D': tuple(N['leftThigh']['D']), 'rP': N['leftThigh']['rP'], 'rD': N['leftThigh']['rD'], 'Pt': thighPt},
            'right': {'sr': N['rightThigh']['sr'], 'P': tuple(N['rightThigh']['P']), 'D': tuple(N['rightThigh']['D']), 'rP': N['rightThigh']['rP'], 'rD': N['rightThigh']['rD'], 'Pt': thighPt}},
        'shin': {'z': 1, 'common': True,
            'left': {'sr': [135, 551, 124, 217], 'P': (66.5, 49.5), 'rP': 49.6, 'phi': -3.6, 'sole': (57.2, 214)},
            'right': {'sr': [516, 550, 120, 218], 'P': (57.3, 48.5), 'rP': 49.6, 'phi': 2.9, 'sole': (57.8, 215)}},
    }
