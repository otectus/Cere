import json, math
SK = dict(pelvisY=137.81, neckY=-39.48, shoulderX=22, shoulderY=-36.12,
          upperArm=22.0, upperArmOut=18.0, forearmOut=15.0,
          hipX=11.55, hipY=6.72, thigh=27.6, thighOut=8.0, shinOut=-4.0)
ATLAS = 'out/daemona-puppet.png'
def along(P, phi, t):
    r = math.radians(phi); return (P[0] + math.sin(r) * t, P[1] + math.cos(r) * t)
def spec(st=0.214, sh=0.185, belt_y=-7.0, hipjx=47, fs=1/6.1, elbow_t=125, knee_t=148):
    torso_sr = [136, 300, 196, 240]
    hips_sr = [475, 313, 294, 240]
    vis = lambda side, lo: {'visibleWhen': {'channel': side + 'HandOpen', ('max' if lo else 'min'): 0.5}}
    return {
        'texture': 'daemona-puppet.png', 'current': 'daemona-rig.json',
        'keep': ['backHair', 'head', 'curiousEyes', 'wink', 'blink'],
        'fixAspect': {'backHair': 'area', 'head': 'height'},
        'torso': {'sr': torso_sr, 's': st, 'anchor_px': (97.5, 52), 'anchor_at': (0, SK['shoulderY']), 'z': 4},
        'hips': {'sr': hips_sr, 's': sh, 'anchor_px': (145, 23), 'anchor_at': (0, belt_y), 'z': 3.5},
        'shoulders': {'left': (21, 52), 'right': (174, 52)},
        'hipJoints': {'left': (145 - hipjx, None), 'right': (145 + hipjx, None)},
        'upperArm': {'z': 5,
            'left': {'sr': [849, 555, 185, 215], 'P': (134.7, 42.6), 'D': along((134.7, 42.6), -20.6, elbow_t), 'rP': 40.5, 'rD': 33},
            'right': {'sr': [1269, 555, 180, 170], 'P': (49.0, 42.9), 'D': along((49.0, 42.9), 23.6, elbow_t), 'rP': 39.9, 'rD': 33}},
        'forearm': {'z': 10,
            'left': {'leftHand': {'sr': [179, 782, 117, 235], 'P': (38.7, 34.9), 'rP': 31.5, 'phi': 14.2, 's': fs, 'extra': vis('left', True)},
                     'leftPalm': {'sr': [910, 782, 162, 238], 'P': (60.5, 35.8), 'rP': 33.6, 'phi': 14.7, 's': fs, 'extra': vis('left', False)}},
            'right': {'rightHand': {'sr': [553, 783, 120, 233], 'P': (81.2, 35.4), 'rP': 32.0, 'phi': -14.9, 's': fs, 'extra': vis('right', True)},
                      'rightPalm': {'sr': [910, 782, 162, 238], 'P': (60.5, 35.8), 'rP': 33.6, 'phi': 14.7, 's': fs, 'mirror': True, 'extra': vis('right', False)}}},
        'thigh': {'z': 2,
            'left': {'sr': [883, 307, 184, 236], 'P': (120.5, 59.2), 'D': along((120.5, 59.2), -18.6, knee_t), 'rP': 56.4, 'rD': 33},
            'right': {'sr': [1247, 307, 184, 237], 'P': (63.0, 58.5), 'D': along((63.0, 58.5), 17.4, knee_t), 'rP': 56.1, 'rD': 33}},
        'shin': {'z': 1, 'common': True,
            'left': {'sr': [110, 539, 193, 240], 'P': (142.5, 46.6), 'rP': 43.7, 'phi': -4.8, 'sole': (58.7, 237)},
            'right': {'sr': [577, 536, 181, 243], 'P': (48.3, 46.5), 'rP': 44.6, 'phi': 4.0, 'sole': (120.7, 240)}},
    }
