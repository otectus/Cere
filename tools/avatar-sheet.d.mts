import type {Buffer} from 'node:buffer';

export interface SheetImage {
  data: Buffer;
  info: {width: number; height: number; channels: number};
}

export interface SheetComponent extends SheetImage {
  source: [number, number, number, number];
}

export function sheetComponents(sheet: SheetImage, columns?: number, rowCount?: number,
  threshold?: number, coreErode?: number): SheetComponent[];
