/** Shared device canvas contract; editorial typography belongs to each template. */
export const DEVICE_SURFACE_VERSION = 'device-white-v1';
export const DEVICE_CONTENT_INSET = 18;

export function deviceSurfaceCss(landscape = false): string {
  const width = landscape ? 960 : 540, height = landscape ? 540 : 960;
  return `
  html,body { margin:0; padding:0; width:${width}px; height:${height}px; background:#fff; }
  .pp-root { box-sizing:border-box; width:${width}px; min-height:${height}px; margin:0; padding:0; background:#fff; overflow:visible; }
  .pp-feed { width:100%; max-width:none; margin:0; padding:0; overflow:visible; }
  .pp-sheet,.pp-sheet.eph-tone-cream,.pp-sheet.eph-tone-gold {
    box-sizing:border-box; width:100%; min-height:${height}px; margin:0;
    --paper-white:#fff; --paper-ink:#000; background:#fff; color:#000; border:0; border-radius:0;
    box-shadow:none; clip-path:none!important; animation:none!important;
  }
  .tear { display:none; }
  .eph-note-body { box-sizing:border-box; min-height:${height}px; padding:24px 30px; }
  `;
}
