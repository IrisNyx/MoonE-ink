/** Device editorial rules. Independent of the unchanged gray4 wire profile. */
export const DEVICE_LAYOUT_VERSION='device-readable-v4';
export const POEM_LANDSCAPE_FOOTER={height:64,gap:16,bottom:32} as const;
export const DEVICE_LAYOUT={
  bodyMinPx:26,poemFirstPx:34,poemOtherPx:26,
  portrait:{width:540,height:960,top:56,right:36,bottom:36,left:36},
  landscape:{width:960,height:540,top:40,right:40,bottom:32,left:40},
} as const;

export function deviceLayoutCss(landscape=false):string {
  const p=landscape?DEVICE_LAYOUT.landscape:DEVICE_LAYOUT.portrait;
  return `
  .pp-sheet .eph-body { box-sizing:border-box; padding:${p.top}px ${p.right}px ${p.bottom}px ${p.left}px; min-height:${p.height}px; font-size:26px; overflow-wrap:anywhere; }
  .pp-sheet :is(.eph-head,.eph-pc-head,.eph-stub-wrap,.eph-log-head,.eph-wx-head,.eph-sky-head,.eph-pass-head,.eph-alm-head,.eph-bp-head,.eph-poem-head) {padding-top:0}
  .pp-sheet :is(.p-body,.p-oneline,.eph-pc-text,.eph-clause-v,.eph-tg,.eph-omk-verse,.eph-omk-note,.eph-extra-lede,.eph-rx-meta,.eph-rx-drug,.eph-rx-dose,.eph-log-e,.eph-log-p,.eph-wx-today-p,.eph-wx-day-zh,.eph-wx-day-sub,.eph-sky-p,.eph-alm-text,.eph-hlt-total,.eph-note-paragraph,.eph-pass-next-v,.eph-cust-p,.eph-cust-lead) {font-size:26px;line-height:1.65;color:#000;opacity:1}
  .pp-sheet :is(.eph-stub-row .v,.eph-hlt-row .k,.eph-hlt-row .note,.eph-cust-row .it,.eph-cust-row .note,.eph-cust-row .q,.eph-itin-leg .c .zh,.eph-itin-leg .c .en,.eph-prog-row .c .zh,.eph-prog-row .c .en,.eph-pass-core .zh,.eph-pin>span:not(.t)) {font-size:26px;line-height:1.45;opacity:1;color:#000}
  .pp-sheet :is(.eph-pc-from,.sign-line,.sign-grid .name,.eph-note-signature) {font-size:22px;line-height:1.55;color:#000;opacity:1}
  .pp-sheet :is(h1,.mh-title,.eph-title-xl,.eph-note-title,.eph-wx-today-h,.rseg-zh) {color:#000;opacity:1}
  .pp-sheet :is(.mh-title,.eph-title-xl,.eph-pc-title,.eph-stub-title,.eph-hlt-title,.eph-bp-title,.eph-rx-title,.eph-wx-title,.eph-sky-title,.eph-itin-title,.eph-prog-title,.eph-log-title,.eph-note-title,.eph-wx-today-h,.rseg-zh) {font-size:34px;line-height:1.25}
  .pp-sheet :is(.mh-date,.eph-clause-k,.eph-stub-row .k,.eph-week-legend,.sign-grid .role,.eph-bp-k,.eph-log-t,.eph-itin-leg .t,.eph-prog-row .t,.eph-wx-day-t,.eph-rx-n) {font-size:22px;line-height:1.45}
  .pp-sheet .eph-bp-cell .k {font-size:13px;line-height:1.2;letter-spacing:.18em;white-space:nowrap;word-break:keep-all;overflow-wrap:normal}
  .pp-sheet .eph-bp-cell .v {font-size:20px;line-height:1.3;word-break:normal;overflow-wrap:normal}
  .pp-sheet .eph-hlt-hrow {font-size:12.5px;line-height:1.25;letter-spacing:.04em;white-space:nowrap;word-break:keep-all;overflow-wrap:normal}
  .pp-sheet .eph-note-body {min-height:${p.height}px;padding:${p.top}px ${p.right}px ${p.bottom}px ${p.left}px}
  .pp-sheet .eph-note-paragraph {line-height:1.75}
  .pp-sheet .eph-note-running {font-size:18px}
  .pp-sheet .eph-wake .rseg {margin:22px 0 10px}
  .pp-sheet .eph-wake .eph-pin {padding:7px 0}
  .pp-sheet .eph-wake .eph-sign {margin-top:12px;gap:10px}
  .pp-sheet .eph-wake {height:${p.height}px;display:flex;flex-direction:column}
  .pp-sheet .eph-wake-flow {flex:0 0 auto;min-height:0}
  .pp-sheet .eph-wake-footer {margin-top:auto;flex:0 0 auto;padding-top:16px}
  .pp-sheet .eph-title-xl {line-height:1.2}
  .pp-sheet .eph-alm-datewrap {margin-top:20px}
  .pp-sheet .p-oneline {margin-top:22px}
  .pp-sheet .eph-pc-body {height:${p.height}px;display:flex;flex-direction:column}
  .pp-sheet .eph-pc-head,.pp-sheet .eph-pc-hr {flex-shrink:0}
  .pp-sheet .eph-pc-grid {flex:1 1 auto;min-height:0;grid-template-columns:minmax(0,1fr) 2px ${landscape?216:116}px;gap:0 18px}
  .pp-sheet .eph-pc-msg {min-width:0;min-height:0}
  .pp-sheet .eph-pc-text {flex:0 0 auto;white-space:pre-wrap;line-height:1.8}
  .pp-sheet .eph-pc-from {margin-top:auto;flex:0 0 auto;padding-top:20px}
  .pp-sheet .eph-pc-div {align-self:stretch}
  .pp-sheet .eph-pc-stampcol {align-items:${landscape?'center':'flex-end'}}
  .pp-sheet .eph-pc-stamp,.pp-sheet .eph-pc-mark {flex-shrink:0}
  .pp-sheet .eph-pc-post {margin-top:auto;font-size:16px;text-align:center}
  .pp-sheet .eph-stub-wrap {min-height:${p.height-p.top-p.bottom}px}
  .pp-sheet .eph-stub-main {display:flex;flex-direction:column;min-width:0}
  .pp-sheet .eph-stub-main>* {flex-shrink:0}
  .pp-sheet .eph-stub-main>.mh-kicker {margin-top:0}
  .pp-sheet .eph-stub-foot {margin-top:auto;padding-top:${landscape?6:14}px}
  .pp-sheet .eph-stub-side {flex-basis:${landscape?172:72}px}
  .pp-sheet .eph-stub-row {grid-template-columns:64px minmax(0,1fr);padding:${landscape?6:10}px 0}
  .pp-sheet .eph-stub-row .v {line-height:${landscape?1.35:1.45}}
  .pp-sheet .eph-stub-one {margin-top:${landscape?8:14}px;line-height:1.45}
  .pp-sheet .eph-stub-hr {margin:${landscape?'8px 0 2px':'12px 0 4px'}}
  .pp-sheet .eph-poem-body {height:${p.height}px;display:flex;flex-direction:column}
  .pp-sheet .eph-poem-body>* {flex-shrink:0}
  .pp-sheet .eph-poem-stage {flex:1 1 0;min-height:0;margin-top:20px}
  .pp-sheet .eph-poem-cols {margin-top:${landscape?0:58}px;gap:18px}
  .pp-sheet .eph-poem-col {font-size:26px;flex:0 0 auto;white-space:pre;line-height:1.75;letter-spacing:.12em}
  .pp-sheet .eph-poem-col:empty {width:1.75em}
  .pp-sheet .eph-poem-col0 {font-size:34px}
  .pp-sheet .eph-poem-sign {margin-top:16px}
  .pp-sheet .eph-rx-dose {display:block;margin:4px 0 0}
  .pp-sheet :is(.eph-rx-drug,.eph-rx-dose) {line-height:1.35}
  .pp-sheet .eph-rx-row {padding:4px 0}
  .pp-sheet .eph-rx-one {margin-top:12px;line-height:1.45}
  .pp-sheet .eph-rx-body .eph-sign {margin-top:12px;gap:10px}
  .pp-sheet .eph-wx-today-h {line-height:1.4}
  .pp-sheet .eph-wx-day-sub {margin-top:6px}
  .pp-sheet .eph-wx-day {padding:12px 6px}
  .pp-sheet .eph-wx-day-en {font-size:18px}
  .pp-sheet .eph-iou .eph-clause {margin-top:12px}
  .pp-sheet .eph-clause-row {padding:5px 0}
  .pp-sheet .eph-clause-v {line-height:1.55}
  .pp-sheet .eph-iou-one {margin-top:12px;line-height:1.45}
  .pp-sheet .eph-iou .eph-sign {margin-top:12px;gap:10px}
  .pp-sheet .eph-tg {font-family:var(--font-cormorant),'Noto Serif SC',serif;letter-spacing:.08em}
  .pp-sheet .eph-omk-verse>div {min-height:1.75em}
  .pp-sheet .eph-hlt-hrow,.pp-sheet .eph-hlt-row {grid-template-columns:minmax(0,1fr) 150px minmax(0,1.25fr)}
  .pp-sheet .eph-hlt-row .g span {font-size:22px}
  .pp-sheet .eph-hlt-row .k,.pp-sheet .eph-hlt-row .note {padding:8px 6px}
  .pp-sheet .eph-log-row {grid-template-columns:58px minmax(0,1fr) 36px;gap:0 10px}
  .pp-sheet .eph-log-tag {font-size:12px}
  .pp-sheet .eph-log-head>div:first-child {min-width:0}
  .pp-sheet .eph-log-title {letter-spacing:-.08em;white-space:nowrap}
  .pp-sheet .eph-log-meta {flex:0 0 190px;min-width:190px}
  .pp-sheet .eph-log-meta .eph-date-sm {font-size:18px;white-space:nowrap}
  .pp-sheet :is(.eph-extra-t,.eph-cust-t) {font-size:18px;white-space:nowrap}
  .pp-sheet .eph-extra-cols {grid-template-columns:minmax(0,1fr) 108px}
  .pp-sheet .eph-extra-ins::after {display:none}
  .pp-sheet .eph-sky-title {letter-spacing:.1em}
  .pp-sheet .eph-sky-head>div:first-child {min-width:0}
  .pp-sheet .eph-sky-head .mh-kicker {font-size:10px;letter-spacing:.18em;white-space:nowrap}
  .pp-sheet .eph-sky-meta {flex:0 0 190px;min-width:190px}
  .pp-sheet .eph-sky-meta .eph-date-sm {white-space:nowrap}
  .pp-sheet .eph-sky-meta .eph-date-sm {font-size:16px}
  .pp-sheet .eph-sky-date {font-size:20px}
  .pp-sheet .eph-sky-notes {font-size:18px;line-height:1.4}
  .pp-sheet .eph-sky-notes .k,.pp-sheet .eph-sky-notes .v {display:block}
  .pp-sheet .eph-sky-notes .v {margin-top:3px;color:#000;opacity:1}
  .pp-sheet .eph-pins {max-width:none;line-height:1.55}
  .pp-sheet .eph-pin .t {font-size:18px}
  .pp-sheet .eph-pass-grid {margin-left:14px;margin-right:14px;grid-template-columns:repeat(3,minmax(0,1fr))}
  .pp-sheet .eph-pass-cell {min-height:150px}
  .pp-sheet .eph-pass-core .zh {font-size:22px;line-height:1.2}
  .pp-sheet .eph-pass-head>div:first-child {min-width:0}
  .pp-sheet .eph-pass-head .mh-kicker {font-size:10px;letter-spacing:.18em;white-space:nowrap}
  .pp-sheet .eph-pass-meta {flex:0 0 250px;min-width:250px}
  .pp-sheet .eph-pass-meta .eph-date-sm {width:250px;max-width:none;text-align:right;white-space:nowrap}
  .pp-sheet .eph-cust-hrow,.pp-sheet .eph-cust-row {grid-template-columns:minmax(0,1fr) 64px 50px minmax(0,1.2fr)}
  .pp-sheet .eph-cust-hrow {font-size:12.5px;line-height:1.25;letter-spacing:.04em;white-space:nowrap;word-break:keep-all;overflow-wrap:normal}
  .pp-sheet .eph-cust-hrow>div {padding:8px 5px}
  .pp-sheet .eph-hlt-date {font-size:18px;white-space:nowrap}
  .pp-sheet .eph-bp-date {font-size:16px!important;white-space:nowrap}
  .pp-sheet .eph-prog-cols {grid-template-columns:minmax(0,1fr) 86px}
  .pp-sheet .eph-prog-row {grid-template-columns:48px minmax(0,1fr) 22px;gap:0 8px}
  .pp-sheet .eph-prog-planet svg {width:86px}
  .pp-sheet .eph-arch {padding-top:28px}${landscape?`
  .pp-sheet .eph-poem-body {position:relative;padding-bottom:${POEM_LANDSCAPE_FOOTER.bottom+POEM_LANDSCAPE_FOOTER.height+POEM_LANDSCAPE_FOOTER.gap}px}
  .pp-sheet .eph-poem-stage {flex:1 1 0;min-height:0}
  .pp-sheet .eph-poem-sign {position:absolute;left:${p.left}px;right:${p.right}px;bottom:${POEM_LANDSCAPE_FOOTER.bottom}px;height:${POEM_LANDSCAPE_FOOTER.height}px;margin:0;justify-content:flex-end}
  `:''}
  `;
}
