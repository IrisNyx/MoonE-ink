import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENRE_CONTENT_SCHEMA,
  applyEditorAdditions,
  contentDisplayText,
  contentPrimaryText,
  contentTextSegments,
  editorMascotMood,
  missingEditorSlots,
  type GenreContent,
} from '../src/domain/genre-content.js';
import { validateManuscript } from '../src/domain/manuscript.js';
import { ENABLED_PRODUCTION_GENRE_IDS } from '../src/production-catalog.js';
import { CONTENT_EXAMPLES } from './helpers/genre-content-examples.js';

test('all 21 enabled genres have one strict, executable structured author contract', () => {
  assert.deepEqual(Object.keys(CONTENT_EXAMPLES).sort(), [...ENABLED_PRODUCTION_GENRE_IDS].sort());
  for (const genre of ENABLED_PRODUCTION_GENRE_IDS) {
    const content = CONTENT_EXAMPLES[genre];
    assert.equal(GENRE_CONTENT_SCHEMA.parse(content).kind, genre);
    const validated = validateManuscript({
      schemaVersion: 3,
      intent: 'note',
      content,
      ...(genre === 'extra' || genre === 'emblem' ? { title: `${genre} 标题` } : {}),
    });
    assert.equal(validated.manuscript.body, contentPrimaryText(content));
    assert.equal(validated.manuscript.genrePreference, genre);
    const display = contentDisplayText(content);
    for (const segment of contentTextSegments(content)) assert.ok(display.includes(segment), `${genre} readback includes ${segment}`);
  }
});

test('structured contracts reject unknown fields, missing primary content and weekly submissions', () => {
  assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ kind: 'note', text: '正文', surprise: true }).success, false);
  assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ kind: 'weather', closing: '只有次要栏' }).success, false);
  assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ kind: 'weekly-chart', caption: '本周' }).success, false);
});

test('iou keeps the original declaration row and telegram accepts only short uppercase English lines', () => {
  const iou = GENRE_CONTENT_SCHEMA.parse(CONTENT_EXAMPLES.iou);
  assert.equal(iou.kind, 'iou');
  if (iou.kind !== 'iou') throw new Error('test fixture is not an iou');
  assert.ok(contentDisplayText(iou).includes(`立据：${iou.declaration}`));
  assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ kind: 'telegram', lines: ['GOOD NEWS AT LAST'] }).success, true);
  for (const invalid of ['Good news', '好消息', 'GOOD NEWS!', 'GOOD NEWS STOP', 'GOOD  NEWS']) {
    assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ kind: 'telegram', lines: [invalid] }).success, false, invalid);
  }
});

test('editor can fill only omitted secondary slots; null is the author explicit no-fill decision', () => {
  const omitted: GenreContent = { kind: 'weather', commentary: '今天有雨。' };
  assert.deepEqual(missingEditorSlots(omitted).map((slot) => slot.path), ['closing']);
  assert.deepEqual(applyEditorAdditions(omitted, [{ path: 'closing', value: '带伞。' }]), {
    kind: 'weather', commentary: '今天有雨。', closing: '带伞。',
  });
  const refused: GenreContent = { kind: 'weather', commentary: '今天有雨。', closing: null };
  assert.deepEqual(missingEditorSlots(refused), []);
  assert.throws(() => applyEditorAdditions(refused, [{ path: 'closing', value: '不能补。' }]));
});

test('typesetter may fill the extra banner only with a one-line English title translation', () => {
  const extra: GenreContent = { kind: 'extra', report: '今天宣布一个好消息。' };
  const slot = missingEditorSlots(extra).find((item) => item.path === 'englishSubtitle');
  assert.ok(slot?.description_zh.includes('顶层 title'));
  assert.deepEqual(applyEditorAdditions(extra, [{ path: 'englishSubtitle', value: 'A WONDERFUL ANNOUNCEMENT' }]), {
    kind: 'extra', report: '今天宣布一个好消息。', englishSubtitle: 'A WONDERFUL ANNOUNCEMENT',
  });
  assert.throws(() => applyEditorAdditions(extra, [{ path: 'englishSubtitle', value: '今天有好消息' }]), /one line of English/);
  assert.throws(() => applyEditorAdditions(extra, [{ path: 'englishSubtitle', value: 'GOOD NEWS\nTODAY' }]), /one line of English/);

  const emblem: GenreContent = { kind: 'emblem', memorialText: '把这一天留在纸上。' };
  const emblemSlot = missingEditorSlots(emblem).find((item) => item.path === 'englishSubtitle');
  assert.ok(emblemSlot?.description_zh.includes('顶层 title'));
  assert.deepEqual(applyEditorAdditions(emblem, [{ path: 'englishSubtitle', value: 'ONE YEAR TOGETHER' }]), {
    kind: 'emblem', memorialText: '把这一天留在纸上。', englishSubtitle: 'ONE YEAR TOGETHER',
  });
  assert.throws(() => applyEditorAdditions(emblem, [{ path: 'englishSubtitle', value: '一周年' }]), /one line of English/);
});

test('mascot mood is a bounded typesetter presentation decision, not an author content field', () => {
  const fortune = CONTENT_EXAMPLES.omikuji;
  assert.deepEqual(missingEditorSlots(fortune).map((slot) => slot.path), ['presentation.mascotMood']);
  const additions = [{ path: 'presentation.mascotMood', value: 'thinking' }];
  assert.deepEqual(applyEditorAdditions(fortune, additions), fortune);
  assert.equal(editorMascotMood(fortune, additions), 'thinking');
  assert.throws(() => applyEditorAdditions(fortune, [{ path: 'presentation.mascotMood', value: 'sleepy' }]));
  assert.equal(GENRE_CONTENT_SCHEMA.safeParse({ ...fortune, mascotMood: 'happy' }).success, false);
});

test('top-level title and subtitle are accepted only where the finished paper can display them', () => {
  assert.doesNotThrow(() => validateManuscript({ schemaVersion: 3, intent: 'note', title: '标题', content: CONTENT_EXAMPLES.note }));
  assert.throws(() => validateManuscript({ schemaVersion: 3, intent: 'note', title: '会丢失', content: CONTENT_EXAMPLES.weather }), /title slot/);
  assert.doesNotThrow(() => validateManuscript({ schemaVersion: 3, intent: 'note', subtitle: '清晨', content: CONTENT_EXAMPLES.wakepaper }));
  assert.throws(() => validateManuscript({ schemaVersion: 3, intent: 'note', subtitle: '会丢失', content: CONTENT_EXAMPLES.postcard }), /subtitle slot/);
});

test('author bylines are optional secondary fields and only real double-byline papers accept a recipient', () => {
  const emblem = validateManuscript({
    schemaVersion: 3,
    intent: 'note',
    title: '纪念日',
    content: CONTENT_EXAMPLES.emblem,
    bylines: { issuer: '我', recipient: '你' },
  }).manuscript;
  assert.deepEqual('bylines' in emblem ? emblem.bylines : undefined, { issuer: '我', recipient: '你' });
  assert.throws(() => validateManuscript({
    schemaVersion: 3,
    intent: 'note',
    content: CONTENT_EXAMPLES.note,
    bylines: { recipient: '这个位置不存在' },
  }), /recipient byline slot/);
  assert.throws(() => validateManuscript({
    schemaVersion: 3,
    intent: 'note',
    content: CONTENT_EXAMPLES.note,
    signature: '旧字段',
    bylines: { issuer: '新字段' },
  }), /instead of sending both/);
});
