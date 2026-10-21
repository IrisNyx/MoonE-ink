/**
 * epaper-540x960-gray4-v1 frame conversion (Device Channel v1 contract).
 *
 * The frame has no header and no compression: rows top→bottom, each row
 * left→right, 4 bits per pixel, 0 = black and 15 = white, the HIGH nibble of
 * every byte is the LEFT pixel, 270 bytes per row with no padding, and the
 * total length is exactly 259200 bytes.
 *
 * The fixed conversion is `rec709-round-gray4-v1` (no dithering):
 *   1. RGBA is alpha-composited over a white background;
 *   2. integer Rec.709 approximation  Y = (54*R + 183*G + 19*B + 128) >> 8;
 *   3. quantize                       q = round(Y * 15 / 255);
 *   4. pack adjacent pixels           byte = (left << 4) | right.
 *
 * The input is a *decoded* PNG (pngjs), never the PNG's compressed bytes.
 */

import { createRequire } from 'node:module';
import { GRAY4_ALGORITHM, GRAY4_ALGORITHM_VERSION, GRAY4_BYTE_LENGTH, GRAY4_STRIDE_BYTES,
  LANDSCAPE_PAGE_HEIGHT, LANDSCAPE_PAGE_WIDTH, PAGE_HEIGHT, PAGE_WIDTH } from '../version.js';
import { RenderError } from './errors.js';

const require_ = createRequire(import.meta.url);

/** Luma of an opaque sRGB pixel via the fixed integer Rec.709 approximation. */
export function rec709Luma(r: number, g: number, b: number): number {
  return (54 * r + 183 * g + 19 * b + 128) >> 8;
}

/** Fixed quantizer q = round(Y * 15 / 255) (round-half-up on the exact half). */
export function quantizeGray4(y: number): number {
  return Math.min(15, Math.max(0, Math.floor((y * 15 * 2 + 255) / (255 * 2))));
}

export interface Gray4Result {
  frame: Buffer;
  algorithm: string;
  algorithmVersion: number;
  width: number;
  height: number;
  strideBytes: number;
  byteLength: number;
  /** Count of non-white pixels (q < 15) — evidence the paper has visible ink. */
  inkPixels: number;
  distinctLevels: number[];
}

/**
 * Pack raw RGBA pixels (4 bytes/pixel, row-major, even width) into gray4
 * nibbles. Geometry-permissive core shared by the locked-path wrapper and the
 * unit tests' synthetic bitmaps.
 */
export function packNibbles(rgba: Buffer, width: number, height: number): Gray4Result {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width % 2 !== 0) {
    throw new RenderError('render_failed', 'bitmap geometry is not packable');
  }
  if (rgba.length !== width * height * 4) {
    throw new RenderError('render_failed', 'decoded bitmap buffer has an unexpected size');
  }
  const stride = width / 2;
  const frame = Buffer.alloc(stride * height);
  const levels = new Set<number>();
  let inkPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride;
    let byteIndex = 0;
    for (let x = 0; x < width; x += 2) {
      let left = 15;
      let right = 15;
      {
        const i = (y * width + x) * 4;
        const a = rgba[i + 3]!;
        // Alpha composite over white (fixed-point, /255 rounding half-up).
        const r = ((rgba[i]! * a + 255 * (255 - a) + 127) / 255) | 0;
        const g = ((rgba[i + 1]! * a + 255 * (255 - a) + 127) / 255) | 0;
        const b = ((rgba[i + 2]! * a + 255 * (255 - a) + 127) / 255) | 0;
        left = quantizeGray4(rec709Luma(r, g, b));
      }
      {
        const i = (y * width + x + 1) * 4;
        const a = rgba[i + 3]!;
        const r = ((rgba[i]! * a + 255 * (255 - a) + 127) / 255) | 0;
        const g = ((rgba[i + 1]! * a + 255 * (255 - a) + 127) / 255) | 0;
        const b = ((rgba[i + 2]! * a + 255 * (255 - a) + 127) / 255) | 0;
        right = quantizeGray4(rec709Luma(r, g, b));
      }
      frame[rowOffset + byteIndex] = (left << 4) | right;
      byteIndex += 1;
      for (const q of [left, right]) {
        levels.add(q);
        if (q < 15) inkPixels += 1;
      }
    }
    if (byteIndex !== stride) {
      throw new RenderError('render_failed', 'gray4 row packing produced the wrong stride');
    }
  }
  return {
    frame,
    algorithm: GRAY4_ALGORITHM,
    algorithmVersion: GRAY4_ALGORITHM_VERSION,
    width,
    height,
    strideBytes: stride,
    byteLength: frame.length,
    inkPixels,
    distinctLevels: [...levels].sort((a, b) => a - b),
  };
}

/**
 * Locked-path conversion: raw RGBA must already be the 540x960 page.
 */
export function rgbaToGray4(rgba: Buffer, width: number, height: number): Gray4Result {
  if (!((width === PAGE_WIDTH && height === PAGE_HEIGHT) ||
        (width === LANDSCAPE_PAGE_WIDTH && height === LANDSCAPE_PAGE_HEIGHT))) {
    throw new RenderError('render_failed', 'rendered bitmap does not match the locked page geometry');
  }
  return packNibbles(rgba, width, height);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse a PNG IHDR without decompressing: {width, height, bitDepth, colorType}. */
export function readPngHeader(png: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new RenderError('render_failed', 'screenshot is not a PNG');
  }
  if (png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new RenderError('render_failed', 'PNG does not start with an IHDR chunk');
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24]!,
    colorType: png[25]!,
  };
}

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

/** Decode a real PNG into RGBA pixels (pngjs). */
export function decodePngRgba(
  png: Buffer,
  expectedWidth = PAGE_WIDTH,
  expectedHeight = PAGE_HEIGHT,
): DecodedPng {
  const header = readPngHeader(png);
  if (header.width !== expectedWidth || header.height !== expectedHeight) {
    throw new RenderError('render_failed', 'rendered PNG does not match the locked page geometry');
  }
  let image: import('pngjs').PNG;
  try {
    image = require_('pngjs').PNG.sync.read(png);
  } catch {
    throw new RenderError('render_failed', 'rendered PNG could not be decoded');
  }
  return { width: image.width, height: image.height, rgba: image.data };
}

/** Decode a PNG and convert it to the gray4 frame (the shipped path). */
export function pngToGray4(png: Buffer): Gray4Result & { pngHeader: ReturnType<typeof readPngHeader> } {
  const header = readPngHeader(png);
  const decoded = decodePngRgba(png);
  return { ...rgbaToGray4(decoded.rgba, decoded.width, decoded.height), pngHeader: header };
}
