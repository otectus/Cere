import json
SK = dict(pelvisY=137.81, neckY=-39.48, shoulderX=22, shoulderY=-36.12,
          upperArm=22.0, upperArmOut=18.0, forearmOut=15.0,
          hipX=11.55, hipY=6.72, thigh=27.6, thighOut=8.0, shinOut=-4.0)
ATLAS = 'out/nova-puppet.png'
def forearms(fs):
    N = json.load(open('out/nova-new.json'))
    def e(n, extra, mirror=False):
        v = N[n]; return {'sr': v['sr'], 'P': tuple(v['P']), 'rP': v['rP'], 'phi': 0.0, 's': fs, 'mirror': mirror, 'extra': extra}
    return {'z': 10,
            'left': {'leftHand': e('leftHand', {'visibleWhen': {'channel': 'leftHandOpen', 'max': 0.5}}),
                     'leftPalm': e('leftPalm', {'visibleWhen': {'channel': 'leftHandOpen', 'min': 0.5}})},
            'right': {'rightHand': e('rightHand', {'visibleWhen': {'channel': 'rightHandOpen', 'max': 0.5}}),
                      'rightPalm': e('leftPalm', {'visibleWhen': {'channel': 'rightHandOpen', 'min': 0.5}}, True)}}
def boots():
    N = json.load(open('out/nova-new.json'))
    def e(n):
        v = N[n]; return {'sr': v['sr'], 'P': tuple(v['P']), 'rP': v['rP'], 'phi': 0.0, 'sole': tuple(v['sole'])}
    return {'z': 1, 'common': True, 'left': e('leftBoot'), 'right': e('rightBoot')}
def relocated_torso():
    N = json.load(open('out/nova-new.json'))
    t = N['torso']; o = t['orig_sr']
    def px(p):
        return (o[0] + p[0] - t['origin'][0], o[1] + p[1] - t['origin'][1])
    return t['sr'], px

def spec(st=0.225, sh=0.132, belt_y=-4.8, hipjx=50, fs=1/7.6, thighPt=-35):
    torso_sr = [136, 288, 180, 248]
    torso_sr, tpx = relocated_torso()
    hips_sr = [456, 308, 278, 142]
    return {
        'texture': 'nova-puppet.png', 'current': 'nova-rig.json',
        'keep': ['backHair', 'head', 'curiousEyes', 'wink', 'blink'],
        'fixAspect': {'backHair': 'area'},
        'torso': {'sr': torso_sr, 's': st, 'anchor_px': tpx((89, 34)), 'anchor_at': (0, SK['shoulderY']), 'z': 4},
        'hips': {'sr': hips_sr, 's': sh, 'anchor_px': (150, 4), 'anchor_at': (0, belt_y), 'z': 4.5},
        'shoulders': {'left': tpx((19, 34)), 'right': tpx((159, 34))},
        'hipJoints': {'left': (150 - hipjx, None), 'right': (150 + hipjx, None)},
        'upperArm': {'z': 5,
            'left': {'sr': [854, 534, 174, 226], 'P': (135.8, 38.5), 'D': (63.3, 162.6), 'rP': 34.5, 'rD': 58.6},
            'right': {'sr': [1261, 536, 179, 215], 'P': (39.3, 39.5), 'D': (113.0, 159.8), 'rP': 35.1, 'rD': 60.9}},
        'forearm': forearms(fs),
        'thigh': {'z': 2,
            'left': {'sr': [879, 285, 166, 256], 'P': (107.7, 57.7), 'D': (51.4, 204.5), 'rP': 55.5, 'rD': 39.6, 'Pt': thighPt},
            'right': {'sr': [1258, 285, 166, 254], 'P': (60.1, 58.3), 'D': (115.6, 202.7), 'rP': 55.2, 'rD': 39.5, 'Pt': thighPt}},
        'shin': boots(),
    }
