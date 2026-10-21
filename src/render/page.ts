/**
 * Page assembly for the postcard paper.
 *
 * The paper markup is produced by real React rendering of the TSX sheet
 * (react-dom/server renderToStaticMarkup) — never a hand-written HTML string
 * and never jsdom. The stylesheet is the postcard subset of the upstream
 * PAPER_CSS, re-sized for the fixed 540x960 epaper page: pure-white
 * paper tones, masthead, rule, left message column, right stamp/postmark
 * column and dashed divider. Device output omits torn paper edges. Animations, transitions and
 * every nondeterministic input (dates, randomness, network) are absent.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PostcardPaper } from './sheet.js';
import type { Tone } from './manuscript.js';
import { deviceSurfaceCss } from './device-surface.js';
import { deviceLayoutCss } from './device-layout.js';

export const PAGE_CSS = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent;
}
html, body {
  margin: 0;
  padding: 0;
  width: 540px;
  height: 960px;
  background: #ffffff;
}
.pp-sheet {
  width: 540px;
  height: 960px;
  background: var(--paper-white);
  color: var(--paper-ink);
  display: flex;
  flex-direction: column;
  font-kerning: normal;
}
.pp-sheet.eph-tone-cream { --paper-white: #f2ead9; --paper-ink: #40372a; }
.pp-sheet.eph-tone-gold { --paper-white: #e7d3a4; --paper-ink: #4a3c1f; }
.tear {
  height: 10px;
  flex: none;
  --t: var(--paper-white);
  background:
    linear-gradient(135deg, transparent 66%, var(--t) 0) 0 0/9px 10px repeat-x,
    linear-gradient(-135deg, transparent 66%, var(--t) 0) 0 0/9px 10px repeat-x;
}
.tear.bottom { transform: scaleY(-1); }
.eph-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 2px 28px 26px;
  font-family: 'Noto Serif SC';
  color: var(--paper-ink);
  font-feature-settings: "onum" 1, "kern" 1;
  font-size: 15px;
  line-height: 1.78;
}
.eph-pc-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding-top: 22px;
  flex: none;
}
.mh-kicker {
  font-family: 'Cormorant Garamond';
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3em;
  font-size: 11px;
  margin-top: 16px;
}
.mh-title {
  font-family: 'Noto Serif SC';
  font-weight: 700;
  line-height: 1;
  font-size: 28px;
  letter-spacing: 0.1em;
  margin-top: 10px;
}
.rseg-en {
  font-family: 'Cormorant Garamond';
  font-style: italic;
  font-weight: 500;
  font-size: 12px;
  opacity: 0.7;
  margin-top: 5px;
}
.eph-pc-en { margin-top: 0; }
.eph-pc-hr {
  height: 2px;
  background: var(--paper-ink);
  margin-top: 12px;
  flex: none;
}
.eph-pc-grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 2px 116px;
  gap: 0 18px;
  margin-top: 22px;
}
.eph-pc-msg {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.eph-pc-text {
  flex: 1 1 0;
  min-height: 0;
  font-size: 15px;
  line-height: 1.95;
  font-weight: 500;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.eph-pc-from {
  flex: none;
  margin-top: 20px;
  font-size: 15px;
  letter-spacing: 0.12em;
}
.eph-pc-div {
  background: repeating-linear-gradient(var(--paper-ink) 0 6px, transparent 6px 12px);
}
.eph-pc-stampcol {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 14px;
}
.eph-pc-stamp {
  width: 84px;
  height: 104px;
  border: 2px dashed var(--paper-ink);
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.eph-pc-mark {
  position: relative;
  width: 92px;
  height: 92px;
  flex: none;
}
.eph-pc-budsvg, .eph-pc-marksvg { display: block; color: var(--paper-ink); }
.eph-flo path, .eph-flo line, .eph-flo circle, .eph-flo ellipse { vector-effect: non-scaling-stroke; }
.eph-pc-post { margin-top: 0; }
`;

export function renderPaperMarkup(tone: Tone, body: string): string {
  return renderToStaticMarkup(createElement(PostcardPaper, { tone, body }));
}

export function buildPageHtml(tone: Tone, body: string): string {
  const markup = renderPaperMarkup(tone, body);
  return [
    '<!doctype html>',
    '<html lang="zh-Hans">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=540, initial-scale=1">',
    '<title>ephemera postcard</title>',
    '<link rel="stylesheet" href="/fonts/fonts.css">',
    `<style>${PAGE_CSS}\n${deviceSurfaceCss()}\n${deviceLayoutCss()}</style>`,
    '</head>',
    '<body>',
    markup,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
