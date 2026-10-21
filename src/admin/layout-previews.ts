import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthorFieldValue, ManuscriptV3 } from '../domain/manuscript.js';
import { contentPrimaryText, type GenreContent } from '../domain/genre-content.js';
import { realRenderJob } from '../jobs/renderer.js';
import {
  PRODUCTION_CATALOG_REVISION,
  PRODUCTION_LAYOUTS,
  type ProductionGenreId,
  type ProductionLayoutId,
} from '../production-catalog.js';
import type { PersonalizationStore } from './personalization.js';

const structured: Partial<Record<ProductionGenreId, Record<string, AuthorFieldValue>>> = {
  'weekly-chart': { notes: [.2, .4, .5, .7, .6, .8, .9], week: '这一周' },
  weather: { wxToday: { label: '今日' }, wx: [{ when: '明日', sky: 'cloud-sun', cond: '晴' }] },
  almanac: { dateCn: '十月十三', phase: '残月', goodText: '宜慢慢来', badText: '忌着急' },
  'boarding-pass': { from: '家', to: '远方', seat: '01A', gate: '月台', boards: '清晨' },
  itinerary: { legs: [{ t: '09:00', zh: '一起出发', en: 'departure', x: '·' }, { t: '12:30', zh: '好好吃饭', en: 'lunch', x: '·' }] },
  passport: { holder: '持证人', stamps: [{ ring: 'double', line: '月光站', en: 'MOON', d: '10.13', alone: false }] },
  customs: { customs: [{ it: '今晚的好心情', q: '1', tax: false, note: '珍藏' }] },
  iou: { clauses: [{ k: '约定', v: '一起散步' }] },
  'ticket-stub': { clauses: [{ k: '凭此', v: '兑换一个拥抱' }] },
  prescription: { rx: [{ d: '早点休息', sig: '今晚一次' }] },
  checkup: { checks: [{ k: '心情', g: 'A', note: '平稳' }] },
  'night-log': { log: [{ t: '22:10', e: '窗边有一点风', tag: '夜' }, { t: '23:40', e: '一切安静', tag: '眠' }] },
  poem: { poem: ['月光落下', '窗边很静', '等你醒来'] },
  omikuji: { level: '大吉', note: '慢慢走也会抵达' },
  programme: { prog: [{ t: '一', zh: '吃一顿晚饭', en: 'DINNER', x: '·' }, { t: '二', zh: '看一场电影', en: 'MOVIE', x: '·' }] },
};

function previewManuscript(layoutId: ProductionLayoutId, genre: ProductionGenreId): ManuscriptV3 {
  const relationalContent: GenreContent | undefined = genre === 'iou'
    ? { kind: 'iou', declaration: '记名在此。', reason: '上次错过了散步', obligation: '陪你走完河边的路',
        settlement: { when: '本周六傍晚', method: '一起慢慢走一圈' }, note: '此据收讫存档。', closing: '长期有效。' }
    : genre === 'ticket-stub'
      ? { kind: 'ticket-stub', promise: '一起看完那场电影', fulfilledAt: '2026-10-12 晚上',
          fulfillment: '已经坐在最后一排看完，回家路上还聊了结局', closing: '这张留作纪念。' }
      : genre === 'poem'
        ? { kind: 'poem', lines: ['月光落下', '窗边很静', '等你醒来'] }
        : genre === 'prescription'
          ? { kind: 'prescription', complaint: '最近睡得太晚，眼睛有些发涩。',
              items: [{ instruction: '早点休息', dosage: '今晚一次' }], closing: '照顾好自己。' }
        : undefined;
  const body = relationalContent === undefined
    ? genre === 'wakepaper'
      ? '早上好。窗外的光已经落在桌边，今天也请慢慢来。这里是一张固定样例，只用来预览版式。'
      : '这是一张固定样例，用来查看字体、留白、装饰和落款在纸面上的位置。'
    : contentPrimaryText(relationalContent);
  const previewTitle = genre === 'note' ? '给你的一张纸'
    : genre === 'iou' ? '欠　条'
      : genre === 'extra' ? '好　消　息'
        : genre === 'emblem' ? '纪　念　日'
          : undefined;
  return {
    schemaVersion: 3,
    intent: genre === 'extra' ? 'celebration' : 'note',
    body,
    ...(previewTitle === undefined ? {} : { title: previewTitle }),
    genrePreference: genre,
    genrePreferenceMode: 'strict',
    layoutVariant: layoutId,
    ...(relationalContent === undefined ? {} : { content: relationalContent }),
    ...(relationalContent !== undefined || structured[genre] === undefined ? {} : { authorFields: structured[genre] }),
  };
}

/** Generates a real first-page proof lazily and caches it per theme revision. */
export class LayoutPreviewStore {
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly dataDir: string,
    private readonly personalization: PersonalizationStore,
  ) {}

  async preview(layoutId: string): Promise<Buffer | null> {
    const layout = PRODUCTION_LAYOUTS.find((item) => item.id === layoutId);
    if (layout === undefined) return null;
    const branding = this.personalization.renderBranding();
    const key = `${layout.id}-${PRODUCTION_CATALOG_REVISION}-${branding.revision}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const root = join(this.dataDir, 'layout-previews', key);
    const cached = join(root, 'preview.png');
    if (existsSync(cached)) return readFileSync(cached);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const task = (async () => {
      mkdirSync(root, { recursive: true });
      const outcome = await realRenderJob({
        manuscript: previewManuscript(layout.id, layout.genre),
        date: '2026-10-13',
        acceptedAt: '2026-10-13T15:40:00.000Z',
        timezone: 'Asia/Shanghai',
        tmpDir: root,
        branding,
      });
      const name = outcome.pages?.[0]?.pngName ?? 'page.png';
      const bytes = readFileSync(join(root, name));
      // The renderer owns the PNG; keeping a stable alias makes subsequent
      // reads independent of renderer-internal page file names.
      const target = join(root, 'preview.png');
      if (!existsSync(target)) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(target, bytes, { flag: 'wx' });
      }
      return bytes;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}
