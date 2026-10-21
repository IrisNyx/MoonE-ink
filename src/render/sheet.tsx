/**
 * Postcard paper (pure sheet), TSX.
 *
 * Derived from the AGPL-3.0 upstream `PostcardSheet` in kimi-room 0.33.0
 * (src/components/ephemera/EphemeraClient.tsx © 2026 marikagura); see
 * THIRD_PARTY_NOTICES.md. This is a standalone paper: no EphemeraClient
 * navigation, drawer, push, notifications, print animation or root layout,
 * and no demo papers. The two restricted upstream raster images are replaced
 * by simple inline geometric SVG ornaments (a generic bud mark and a generic
 * `EPHEMERA POST` postmark) — nothing is traced from the brand art.
 *
 * The paper is fixed at 540x960 (epaper-540x960-gray4-v1). `body` is rendered
 * as the single text node of .eph-pc-text with `white-space: pre-wrap`, so the
 * DOM textContent is byte-exact the manuscript body: no trimming, no
 * normalization, blank lines and combining marks preserved. Head, rules,
 * postmark and the default signature are Template-sourced fixed text.
 */

import type { Tone } from './manuscript.js';

export interface PostcardPaperProps {
  tone: Tone;
  body: string;
}

/** Geometric bud ornament (replaces the CC BY-NC rose-bud image). */
function BudOrnament(): React.JSX.Element {
  const petals = Array.from({ length: 6 }, (_, i) => i * 60);
  return (
    <svg
      className="eph-flo eph-pc-budsvg"
      viewBox="0 0 64 78"
      width="64"
      height="78"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      {petals.map((angle) => (
        <ellipse key={angle} cx="32" cy="17" rx="6.5" ry="13" transform={`rotate(${angle} 32 30)`} />
      ))}
      <circle cx="32" cy="30" r="4" fill="currentColor" stroke="none" />
      <path d="M32 36 L32 66" strokeWidth="1.4" />
      <path d="M32 50 C26 50 24 44 19 44 M32 56 C38 56 40 50 45 50" strokeWidth="1.4" />
    </svg>
  );
}

/** Generic `EPHEMERA POST` cancellation mark (replaces the brand insignia). */
function PostmarkMark(): React.JSX.Element {
  const ticks = Array.from({ length: 24 }, (_, i) => i * 15);
  return (
    <svg
      className="eph-flo eph-pc-marksvg"
      viewBox="0 0 92 92"
      width="92"
      height="92"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <circle cx="46" cy="46" r="43" strokeWidth="2" />
      <circle cx="46" cy="46" r="35" strokeWidth="1.2" />
      {ticks.map((angle) => (
        <line
          key={angle}
          x1="46"
          y1="6.5"
          x2="46"
          y2="10"
          transform={`rotate(${angle} 46 46)`}
          strokeWidth="1.2"
        />
      ))}
      <text
        x="46"
        y="43"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="'Cormorant Garamond'"
        fontSize="9.5"
        fontWeight="500"
        letterSpacing="2.2"
      >
        EPHEMERA
      </text>
      <text
        x="46"
        y="55"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="'Cormorant Garamond'"
        fontSize="9.5"
        fontWeight="500"
        letterSpacing="3.5"
      >
        POST
      </text>
      <path d="M46 62 L49 65 L46 68 L43 65 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PostcardPaper({ tone, body }: PostcardPaperProps): React.JSX.Element {
  const toneClass = tone === 'gold' ? 'eph-tone-gold' : 'eph-tone-cream';
  return (
    <div className={`pp-sheet ${toneClass}`} id="eph-sheet">
      <div className="tear" aria-hidden="true" />
      <div className="eph-body eph-pc-body">
        <div className="eph-pc-head" id="eph-head">
          <div>
            <div className="mh-kicker">EPHEMERA · POST</div>
            <div className="mh-title eph-pc-title">明　信　片</div>
          </div>
          <div className="rseg-en eph-pc-en">a postcard, from elsewhere</div>
        </div>
        <div className="eph-pc-hr" />
        <div className="eph-pc-grid">
          <div className="eph-pc-msg">
            {/* The single body node: textContent must equal the manuscript body byte-exact. */}
            <div className="eph-pc-text" id="eph-body-text">
              {body}
            </div>
            <div className="eph-pc-from">— · 寄</div>
          </div>
          <div className="eph-pc-div" id="eph-divider" aria-hidden="true" />
          <div className="eph-pc-stampcol">
            <div className="eph-pc-stamp" id="eph-stamp">
              <BudOrnament />
            </div>
            <div className="eph-pc-mark" id="eph-postmark">
              <PostmarkMark />
            </div>
            <div className="rseg-en eph-pc-post">POST CARD</div>
          </div>
        </div>
      </div>
      <div className="tear bottom" aria-hidden="true" />
    </div>
  );
}

/**
 * Fixed template strings by bound font role; validated against the real font
 * cmaps before any browser starts (see render.ts). Keeping them in one place
 * makes the Template-source inventory auditable.
 */
export const TEMPLATE_TEXT = {
  noto700: ['明　信　片'],
  noto500: ['— · 寄'],
  cormorant500: ['EPHEMERA · POST', 'EPHEMERA', 'POST'],
  cormorantItalic500: ['a postcard, from elsewhere', 'POST CARD'],
} as const;
