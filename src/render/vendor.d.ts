/**
 * Minimal ambient declarations for the untyped locked dependencies used by
 * the renderer (fontkit 2.0.4 and pngjs 7.0.0 ship no TypeScript types).
 * Only the surface the renderer actually calls is declared.
 */

declare module 'fontkit' {
  export interface Font {
    numGlyphs: number;
    /** Code points mapped to real glyphs in this font's cmap. */
    characterSet: number[];
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  export function create(buffer: Buffer): Font;
}

declare module 'pngjs' {
  export class PNG {
    width: number;
    height: number;
    /** RGBA, 4 bytes per pixel. */
    data: Buffer;
    static sync: {
      read(buffer: Buffer, options?: { keepGamma?: boolean }): PNG;
      write(png: PNG, options?: { colorType?: number; inputColorType?: number; deflateLevel?: number }): Buffer;
    };
    constructor(options: { width: number; height: number });
  }
}

declare module 'lunar-javascript' {
  export const Solar: any;
}
