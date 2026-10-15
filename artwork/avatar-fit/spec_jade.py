import json
SK = dict(pelvisY=137.81, neckY=-39.48, shoulderX=22, shoulderY=-36.12,
          upperArm=22.0, upperArmOut=18.0, forearmOut=15.0,
          hipX=11.55, hipY=6.72, thigh=27.6, thighOut=8.0, shinOut=-4.0)
ATLAS = 'out/jade-puppet.png'
import json
def forearms(fs=1/7.94):
    N = json.load(open('out/jade-new.json'))
    def e(n, extra, mirror=False):
        v = N[n]; return {'sr': v['sr'], 'P': tuple(v['P']), 'rP': v['rP'], 'phi': 0.0, 's': fs, 'mirror': mirror, 'extra': extra}
    return {'z': 10,
            'left': {'leftHand': e('leftHand', {'visibleWhen': {'channel': 'leftHandOpen', 'max': 0.5}}),
                     'leftPalm': e('leftPalm', {'visibleWhen': {'channel': 'leftHandOpen', 'min': 0.5}})},
            'right': {'rightHand': e('rightHand', {'visibleWhen': {'channel': 'rightHandOpen', 'max': 0.5}}),
                      'rightPalm': e('leftPalm', {'visibleWhen': {'channel': 'rightHandOpen', 'min': 0.5}}, True)}}
def relocated_torso():
    N = json.load(open('out/jade-new.json'))
    t = N['torso']; o = t['orig_sr']
    def px(p):
        return (o[0] + p[0] - t['origin'][0], o[1] + p[1] - t['origin'][1])
    return t['sr'], px

def spec(st=0.205, sh=0.175, belt_y=-2.0, hipjx=65):
    torso_sr = [118, 297, 195, 246]
    torso_sr, tpx = relocated_torso()
    hips_sr = [438, 292, 300, 182]
    return {
        'texture': 'jade-puppet.png', 'current': 'jade-rig.json',
        'keep': ['backHair', 'head', 'curiousEyes', 'wink', 'blink'],
        'fixAspect': {'backHair': 'area'},
        'torso': {'sr': torso_sr, 's': st, 'anchor_px': tpx((97.5, 64.6 - 7)), 'anchor_at': (0, SK['shoulderY']), 'z': 4},
        'hips': {'sr': hips_sr, 's': sh, 'anchor_px': (152, 46), 'anchor_at': (0, belt_y), 'z': 4.5},
        'shoulders': {'left': tpx((27.6, 64.6 - 7)), 'right': tpx((167.4, 64.6 - 7))},
        'hipJoints': {'left': (152 - hipjx, None), 'right': (152 + hipjx, None)},
        'upperArm': {'z': 5,
            'left': {'sr': [872, 557, 130, 193], 'P': (98.7, 29.7), 'D': (29.1, 166.5), 'rP': 30.0, 'rD': 24.6},
            'right': {'sr': [1296, 552, 132, 183], 'P': (32.6, 31.4), 'D': (103.5, 161.1), 'rP': 30.9, 'rD': 24.4}},
        'forearm': forearms(),
        'thigh': {'z': 2,
            'left': {'sr': [905, 304, 147, 244], 'P': (86.2, 56.8), 'D': (49.4, 198.1), 'rP': 56.1, 'rD': 43.1},
            'right': {'sr': [1256, 303, 148, 244], 'P': (63.3, 58.5), 'D': (98.0, 198.6), 'rP': 57.1, 'rD': 42.9}},
        'shin': {'z': 1, 'common': True,
            'left': {'sr': [115, 547, 148, 218], 'P': (111.1, 35.7), 'rP': 33.9, 'phi': -8.0, 'sole': (42.5, 215)},
            'right': {'sr': [556, 548, 143, 217], 'P': (37.6, 34.6), 'rP': 33.7, 'phi': 7.5, 'sole': (99.9, 214)}},
    }
