import React from 'react';
import type { NoteFragment } from './note-pagination.js';

export type NoteLayoutVariant = 'note-portrait-v4';

export interface NoteLayoutSpec {
  version: NoteLayoutVariant;
  layout: 'device-readable-v3';
  genre: 'note';
  pagination: 'paged';
  width: 540;
  height: 960;
  bodyPx: number;
  titlePx: number;
  signaturePx: number;
  lineHeight: number;
  paragraphGapPx: number;
  templateNamePx: number;
  datePx: number;
  englishPx: number;
  yearPx: number;
  folioPx: number;
  runningPx: number;
  orientation: 'portrait';
  breakPolicy: 'paragraph-first; measured-line-split-for-oversized-paragraph';
  minLinesAtSplit: 2;
  maxPages: 16;
  signature: 'optional; last-page-only';
}

export const NOTE_SPEC_V4: NoteLayoutSpec = {
  version: 'note-portrait-v4',
  layout: 'device-readable-v3',
  genre: 'note',
  pagination: 'paged',
  width: 540,
  height: 960,
  bodyPx: 26,
  titlePx: 34,
  signaturePx: 22,
  lineHeight: 1.75,
  paragraphGapPx: 0,
  templateNamePx: 34,
  datePx: 34,
  englishPx: 20,
  yearPx: 18,
  folioPx: 18,
  runningPx: 22,
  orientation: 'portrait',
  breakPolicy: 'paragraph-first; measured-line-split-for-oversized-paragraph',
  minLinesAtSplit: 2,
  maxPages: 16,
  signature: 'optional; last-page-only',
};

export const NOTE_SPEC: NoteLayoutSpec = NOTE_SPEC_V4;

export function noteSpecFor(_variant: NoteLayoutVariant = NOTE_SPEC.version): NoteLayoutSpec {
  return NOTE_SPEC_V4;
}

export interface NoteDocument {
  date: string;
  title?: string;
  paragraphs: readonly string[];
  signature?: string;
}

function Spark(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 1C12.7 8 16 11.3 23 12C16 12.7 12.7 16 12 23C11.3 16 8 12.7 1 12C8 11.3 11.3 8 12 1Z" /></svg>;
}

export function NoteSheet({ document: doc, fragments, pageIndex = 0, pageCount = 1, final = true, secondaryLogoDataUrl }: {
  document: NoteDocument;
  fragments: readonly NoteFragment[];
  pageIndex?: number;
  pageCount?: number;
  final?: boolean;
  secondaryLogoDataUrl?: string;
}): React.JSX.Element {
  const [year, month, day] = doc.date.split('-');
  return <article className="pp-sheet eph-note-sheet" id="eph-sheet" data-page-index={pageIndex}>
    <div className={`eph-body eph-note-body${pageIndex ? ' eph-note-continued' : ''}`}>
      {pageIndex === 0 ? <header className="eph-note-head" id="eph-head">
        <div><div className="eph-note-name">便　签</div><div className="eph-note-en">a little note</div></div>
        <div className="eph-note-date"><div>{month}<span>·</span>{day}</div><small>{year}</small></div>
      </header> : <header className="eph-note-running" id="eph-head">
        <span>便签{doc.title ? ` · ${doc.title}` : ''}</span><time dateTime={doc.date}>{month} · {day}</time>
      </header>}
      <div className="eph-note-rule" aria-hidden="true"><span/><span/></div>
      {pageIndex === 0 && doc.title ? <h1 className="eph-note-title" data-author-title>{doc.title}</h1> : null}
      <div className="eph-note-copy" id="eph-body-text">
        {fragments.map((item, index) => <p key={`${item.paragraphIndex}:${item.start}:${index}`}
          className={`eph-note-paragraph${item.continuedBefore ? ' eph-note-fragment-cont' : ''}`}
          data-paragraph={item.paragraphIndex} data-start={item.start} data-end={item.end}
          data-continued-before={item.continuedBefore} data-continued-after={item.continuedAfter}>{item.text}</p>)}
      </div>
      <footer className="eph-note-footer">
        {final ? <div className="eph-note-end"><span className="eph-note-end-rule"/>
          {secondaryLogoDataUrl === undefined ? <Spark/> : <img className="eph-note-brandmark" src={secondaryLogoDataUrl} alt="个性化小 Logo"/>}
          {doc.signature ? <span className="eph-note-signature" data-author-signature>{doc.signature}</span> : <span className="eph-note-end-rule"/>}
        </div> : null}
        <div className="eph-note-folio" aria-label="页码">{pageIndex + 1}<span>/</span>{pageCount}</div>
      </footer>
    </div>
  </article>;
}

export function noteCss(spec: NoteLayoutSpec): string {
return `
*,*::before,*::after{box-sizing:border-box;animation:none!important;transition:none!important;caret-color:transparent}
html,body{margin:0;padding:0;width:540px;height:960px;background:#fff}
.eph-note-sheet{width:540px;height:960px;background:#fff;color:#000;display:flex;flex-direction:column;font-kerning:normal}
.eph-note-body{box-sizing:border-box;height:960px;min-height:960px;padding:56px 36px 36px;display:flex;flex-direction:column;color:#000;font-family:'Noto Serif SC',serif;font-feature-settings:"kern" 1;overflow:visible}
.eph-note-head{display:flex;justify-content:space-between;align-items:center;gap:22px;flex:none}
.eph-note-name{font-size:${spec.templateNamePx}px;line-height:1.25;font-weight:500;letter-spacing:.12em}
.eph-note-en{font-family:'Cormorant Garamond',serif;font-size:${spec.englishPx}px;font-style:italic;font-weight:500;letter-spacing:.06em;margin-top:6px;color:#555}
.eph-note-date{font-family:'Cormorant Garamond',serif;text-align:right;font-size:${spec.datePx}px;line-height:1.05;font-weight:500;letter-spacing:.025em}
.eph-note-date span{margin:0 5px;color:#777}.eph-note-date small{display:block;margin-top:7px;font-size:${spec.yearPx}px;letter-spacing:.18em;color:#555}
.eph-note-rule{display:flex;flex-direction:column;gap:4px;margin-top:17px;flex:none}.eph-note-rule span:first-child{height:1.5px;background:#000}.eph-note-rule span:last-child{height:1px;background:#999}
.eph-note-title{font-size:${spec.titlePx}px;font-weight:500;line-height:1.4;margin:22px 0 0;overflow-wrap:anywhere;flex:none}
.eph-note-copy{margin-top:22px;padding-bottom:28px;flex:0 0 auto}
.eph-note-paragraph{margin:0;font-size:${spec.bodyPx}px;font-weight:500;line-height:${spec.lineHeight};letter-spacing:0;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;writing-mode:horizontal-tb}
.eph-note-copy .eph-note-paragraph+.eph-note-paragraph{margin-top:${spec.paragraphGapPx}px}
.eph-note-paragraph:empty::before{content:'\\00a0'}
.eph-note-footer{margin-top:auto;flex:none}.eph-note-end{display:flex;align-items:center;justify-content:center;gap:13px;min-height:36px;color:#000}
.eph-note-end-rule{width:35px;height:1px;background:#888}.eph-note-signature{font-size:${spec.signaturePx}px;line-height:1.55;overflow-wrap:anywhere;max-width:330px}
.eph-note-folio{font-family:'Cormorant Garamond',serif;font-size:${spec.folioPx}px;font-weight:500;text-align:right;letter-spacing:.08em;line-height:1.3;margin-top:13px;color:#444}.eph-note-folio span{margin:0 7px;color:#888}
.eph-note-running{display:flex;justify-content:space-between;align-items:baseline;gap:20px;font-size:${spec.runningPx}px;line-height:1.6;color:#444;flex:none}
.eph-note-running span{overflow-wrap:anywhere}.eph-note-running time{font-family:'Cormorant Garamond',serif;font-size:${spec.runningPx}px;font-weight:500;white-space:nowrap;flex:none}
.eph-note-continued .eph-note-rule{margin-top:10px}
`;
}

export const NOTE_CSS = noteCss(NOTE_SPEC);
