"""Build an avatar rig from a declarative fit spec (shared skeleton, native aspect)."""
import sys, math, json, copy
sys.path.insert(0, '.')
import numpy as np
from PIL import Image
import compose as C
from fitter import place, to_bone, rot, apply

def dirvec(deg, L):
    r = math.radians(deg); return (math.sin(r) * L, math.cos(r) * L)

def skeleton(base, sk):
    """Write the shared skeleton into a copy of the base rig (no proportion profile)."""
    b = copy.deepcopy(base)
    b.pop('proportions', None)
    bones = {x['name']: x for x in b['bones']}
    bones['hips']['x'], bones['hips']['y'] = 96, sk['pelvisY']
    bones['head']['x'], bones['head']['y'] = 0, sk['neckY']
    for side, sg in (('left', -1), ('right', 1)):
        bones[side + 'UpperArm']['x'], bones[side + 'UpperArm']['y'] = sg * sk['shoulderX'], sk['shoulderY']
        fx, fy = dirvec(sg * sk['upperArmOut'], sk['upperArm'])
        bones[side + 'Forearm']['x'], bones[side + 'Forearm']['y'] = round(fx, 4), round(fy, 4)
        bones[side + 'Thigh']['x'], bones[side + 'Thigh']['y'] = sg * sk['hipX'], sk['hipY']
        tx, ty = dirvec(sg * sk['thighOut'], sk['thigh'])
        bones[side + 'Shin']['x'], bones[side + 'Shin']['y'] = round(tx, 4), round(ty, 4)
    return b

def seg_phi(P, D):
    return math.degrees(math.atan2(D[0] - P[0], D[1] - P[1]))

def build(base, spec, sk):
    rig = {'texture': spec['texture'], 'parts': [], 'boneOverrides': {}}
    cur = json.load(open('originals/' + spec['current']))
    keep = {p['name']: p for p in cur['parts']}
    parts = rig['parts']
    for name in spec.get('keep', []):
        parts.append(copy.deepcopy(keep[name]))
    # Restore the painted aspect ratio of kept head/hair cutouts.
    byname = {p['name']: p for p in parts}
    for name, mode in spec.get('fixAspect', {}).items():
        p = byname[name]; sr = p['sourceRect']; r = p['rect']
        f = (r[2] / sr[2]) / (r[3] / sr[3])
        if mode == 'area':            # same visual mass, top edge fixed
            w = r[2] / math.sqrt(f); h = r[3] * math.sqrt(f)
            p['rect'] = [r[0] + r[2] / 2 - w / 2, r[1], w, h]
        elif mode == 'height':        # same height and placement, true width
            w = r[2] / f; cx = r[0] + r[2] / 2; k = w / r[2]
            p['rect'] = [cx - w / 2, r[1], w, r[3]]
            # expression overlays were drawn against this head: keep them aligned
            for o in parts:
                if o.get('opacityChannel') and o['bone'] == p['bone']:
                    q = o['rect']; x0 = cx + (q[0] - cx) * k; x1 = cx + (q[0] + q[2] - cx) * k
                    o['rect'] = [x0, q[1], x1 - x0, q[3]]
    ov = rig['boneOverrides']
    # torso and hips: rotation-free, uniform scale, anchored by a sprite pixel
    placed = {}
    for key in ('torso', 'hips'):
        t = spec[key]
        sr = t['sr']; s = t['s']; ax, ay = t['anchor_px']; X, Y = t['anchor_at']
        p = {'name': key, 'bone': 'torso', 'sourceRect': sr,
             'rect': [round(X - ax * s, 4), round(Y - ay * s, 4), round(sr[2] * s, 4), round(sr[3] * s, 4)], 'z': t['z']}
        p.update(t.get('extra', {}))
        parts.append(p); placed[key] = p
    def px_to_torso(key, pix):
        p = placed[key]; s = p['rect'][2] / p['sourceRect'][2]
        return (p['rect'][0] + pix[0] * s, p['rect'][1] + pix[1] * s)
    for side in ('left', 'right'):
        sx, sy = px_to_torso('torso', spec['shoulders'][side])
        ov[side + 'UpperArm'] = {'x': round(sx, 4), 'y': round(sy, 4)}
        hpx = spec['hipJoints'][side]
        hx, hy = px_to_torso('hips', (hpx[0], hpx[1] or 0))
        # Thighs hang from the pelvis at the shared hip height; only the
        # outfit's leg-opening spacing is artwork-specific.
        ov[side + 'Thigh'] = {'x': round(hx, 4), 'y': round(hy if hpx[1] is not None else sk['hipY'], 4)}
    sg = {'left': -1, 'right': 1}
    def limb(entry, bone, beta_out, s, z, side, name):
        P = entry['P']; phi = entry.get('phi', seg_phi(P, entry['D']) if 'D' in entry else 0.0)
        return place(name, bone, entry['sr'], P, phi, s, sg[side] * beta_out, z, entry.get('mirror', False), **entry.get('extra', {}))
    scales = {}
    for side in ('left', 'right'):
        ua = spec['upperArm'][side]
        L = math.dist(ua['P'], ua['D']); s_ua = sk['upperArm'] / L
        p = limb(ua, side + 'UpperArm', sk['upperArmOut'], s_ua, spec['upperArm']['z'], side, ua.get('name', side + 'Sleeve'))
        parts.append(p); scales[side + 'UpperArm'] = s_ua
        # forearm pieces: scale by width continuity with the elbow
        rElbow = ua['rD'] * s_ua
        for fname, fa in spec['forearm'][side].items():
            s_fa = fa.get('s', rElbow / fa['rP'] * spec['forearm'].get('widthRatio', 1.0))
            parts.append(limb(fa, side + 'Forearm', sk['forearmOut'], s_fa, fa.get('z', spec['forearm']['z']), side, fname))
            scales[fname] = s_fa
        th = dict(spec['thigh'][side])
        if 'Pt' in th:
            # move the hip pivot along the painted axis (positive = down the limb)
            ph = math.radians(th.get('phi', seg_phi(th['P'], th['D'])))
            th['phi'] = math.degrees(ph)
            th['P'] = (th['P'][0] + math.sin(ph) * th['Pt'], th['P'][1] + math.cos(ph) * th['Pt'])
        L = math.dist(th['P'], th['D']); s_th = sk['thigh'] / L
        parts.append(limb(th, side + 'Thigh', sk['thighOut'], s_th, spec['thigh']['z'], side, side + 'Thigh'))
        scales[side + 'Thigh'] = s_th
        rKnee = th['rD'] * s_th
        bo = spec['shin'][side]
        if 'sole' in bo:
            # Scale so the painted sole meets the common ground line at rest.
            knee = C.world(C.resolve(base, {'boneOverrides': ov}), {})[side + 'Shin']
            phi = bo.get('phi', 0.0); phi_e = -phi if bo.get('mirror') else phi
            R = rot(0.0)
            v = (bo['sole'][0] - bo['P'][0], bo['sole'][1] - bo['P'][1])
            if bo.get('mirror'): v = (-v[0], v[1])
            vy = R[2] * v[0] + R[3] * v[1]
            s_b = (sk.get('groundY', 199.8) - knee[5]) / vy
        else:
            s_b = bo.get('s', rKnee / bo['rP'] * spec['shin'].get('widthRatio', 1.0))
        phi_b = bo.get('phi', 0.0); phi_be = -phi_b if bo.get('mirror') else phi_b
        parts.append(place(side + 'Boot', side + 'Shin', bo['sr'], bo['P'], phi_b, s_b, phi_be, spec['shin']['z'], bo.get('mirror', False), **bo.get('extra', {})))
        scales[side + 'Boot'] = s_b
    if spec['shin'].get('common'):
        # One scale for both boots; each knee pivot slides along its painted
        # axis so both soles still meet the ground line.
        boots = [p for p in parts if p['name'] in ('leftBoot', 'rightBoot')]
        sc = sum(scales[p['name']] for p in boots) / len(boots)
        for p in boots:
            side = 'left' if p['name'].startswith('left') else 'right'
            bo = spec['shin'][side]
            knee = C.world(C.resolve(base, {'boneOverrides': ov}), {})[side + 'Shin']
            phi = bo.get('phi', 0.0); mir = bo.get('mirror', False)
            phi_e = -phi if mir else phi
            R = rot(p.get('rotation', 0.0))
            need = (sk.get('groundY', 199.8) - knee[5]) / sc     # sprite px along bone-y
            v = [bo['sole'][0] - bo['P'][0], bo['sole'][1] - bo['P'][1]]
            da = [math.sin(math.radians(phi)), math.cos(math.radians(phi))]
            if mir: v[0] = -v[0]; da[0] = -da[0]
            vy0 = R[2] * v[0] + R[3] * v[1]; dvy = R[2] * da[0] + R[3] * da[1]
            k = (vy0 - need) / dvy
            P2 = (bo['P'][0] + math.sin(math.radians(phi)) * k, bo['P'][1] + math.cos(math.radians(phi)) * k)
            newp = place(p['name'], p['bone'], bo['sr'], P2, phi, sc, phi_e, p['z'], mir, **bo.get('extra', {}))
            p.clear(); p.update(newp); scales[p['name']] = sc
    for extra in spec.get('extraParts', []):
        parts.append(extra)
    return rig, scales

def resolve(base, rig):
    return C.resolve(base, rig)
