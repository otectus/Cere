export type HeldEye = [cx: number, cy: number, rx: number, ry: number, angleDegrees: number];
export interface HeldEyeSpec { eyes?: Array<HeldEye | null>; closed?: boolean }
export interface PixelPoint { x: number; y: number }
export function applyHeldEyes(options: {
  open: Uint8Array;
  neutralBlink: Uint8Array;
  width: number;
  height: number;
  neutralTargets: PixelPoint[];
  spec: HeldEyeSpec;
  sourceEyes?: Array<HeldEye | null>;
}): Buffer;
