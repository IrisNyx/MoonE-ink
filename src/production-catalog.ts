import { canonicalJsonBytes } from './domain/canonical.js';
import { GENRE_CONTENT_GUIDES } from './domain/genre-content.js';

export const PRODUCTION_CATALOG_REVISION = 'production-catalog-2026-10-21.2';
export const PRODUCTION_RESOURCES_REVISION = 'ephemera-device-readable-v4';

/** The complete visual library that has already passed the device readability review. */
export const PRODUCTION_GENRE_IDS = [
  'wakepaper', 'note', 'weekly-chart', 'weather', 'almanac',
  'postcard', 'boarding-pass', 'itinerary', 'passport', 'customs',
  'iou', 'ticket-stub', 'telegram', 'extra', 'prescription', 'checkup',
  'night-log', 'starmap', 'poem', 'omikuji', 'emblem', 'programme',
] as const;

export type ProductionGenreId = (typeof PRODUCTION_GENRE_IDS)[number];

/** New-author surface. Weekly chart remains renderable/readable for history, but is shelved. */
export const ENABLED_PRODUCTION_GENRE_IDS = PRODUCTION_GENRE_IDS.filter(
  (genre): genre is Exclude<ProductionGenreId, 'weekly-chart'> => genre !== 'weekly-chart',
);
export type EnabledProductionGenreId = (typeof ENABLED_PRODUCTION_GENRE_IDS)[number];

export const PRODUCTION_LAYOUT_VARIANT_IDS = [
  'wakepaper-portrait', 'note-portrait-v4',
  'weekly-chart-portrait', 'weather-portrait', 'almanac-portrait',
  'postcard-portrait', 'boarding-pass-portrait', 'itinerary-portrait',
  'passport-portrait', 'customs-portrait', 'iou-portrait',
  'ticket-stub-portrait', 'telegram-portrait', 'extra-portrait',
  'prescription-portrait', 'checkup-portrait', 'night-log-portrait',
  'starmap-portrait', 'poem-portrait', 'omikuji-portrait',
  'emblem-portrait', 'programme-portrait',
  'postcard-landscape', 'ticket-stub-landscape', 'poem-landscape',
] as const;

export type ProductionLayoutId = (typeof PRODUCTION_LAYOUT_VARIANT_IDS)[number];
export const ENABLED_PRODUCTION_LAYOUT_VARIANT_IDS = PRODUCTION_LAYOUT_VARIANT_IDS.filter(
  (id): id is Exclude<ProductionLayoutId, 'weekly-chart-portrait'> => id !== 'weekly-chart-portrait',
);
export type PaginationPolicy = 'forbidden' | 'paged' | 'supplement';

export interface ProductionLayout {
  id: ProductionLayoutId;
  genre: ProductionGenreId;
  name_zh: string;
  purpose_zh: string;
  orientation: 'portrait' | 'landscape';
  pagination: PaginationPolicy;
  accepted_author_fields: readonly string[];
  required_fact_fields: readonly string[];
  conditional_length_guidance_zh: string;
  renderer_family: 'original-paper-v1' | 'note-v1';
  theme_revision: string;
  resources_revision: string;
  trigger: 'daily' | 'rule' | 'occasion';
  /** Human-facing guidance; observing it never triggers publication by itself. */
  trigger_recommendation_zh: string;
  usage_recommendation_zh: string;
  signature_slot: ProductionGenreId;
  byline_roles: readonly ('issuer' | 'recipient')[];
  source: 'builtin';
  availability: 'enabled' | 'shelved';
}

const META: Record<ProductionGenreId, {
  name: string; purpose: string; pagination: PaginationPolicy; trigger: 'daily' | 'rule' | 'occasion';
}> = {
  wakepaper: { name: '醒来纸', purpose: '清晨长文；正文放不下时自动带同一出版物的附刊。', pagination: 'supplement', trigger: 'daily' },
  note: { name: '便签', purpose: '标题、正文与可选落款的日常文字，可自动分页。', pagination: 'paged', trigger: 'daily' },
  'weekly-chart': { name: '周谱', purpose: '把一周状态画成谱线。', pagination: 'forbidden', trigger: 'rule' },
  weather: { name: '气象简报', purpose: '当天和后续天气的简报。', pagination: 'forbidden', trigger: 'rule' },
  almanac: { name: '残月黄历', purpose: '日期、节气与宜忌。', pagination: 'forbidden', trigger: 'rule' },
  postcard: { name: '明信片', purpose: '短篇、留白较多的旅行或日常寄语。', pagination: 'forbidden', trigger: 'occasion' },
  'boarding-pass': { name: '登机牌', purpose: '行程节点或即将出发的消息。', pagination: 'forbidden', trigger: 'occasion' },
  itinerary: { name: '行程单', purpose: '按时段排列的计划，可自动续页。', pagination: 'paged', trigger: 'occasion' },
  passport: { name: '护照盖章页', purpose: '地点与日期组成的回忆印章，可自动续页。', pagination: 'paged', trigger: 'occasion' },
  customs: { name: '海关申报单', purpose: '逐项列出想带回来的事物，可自动续页。', pagination: 'paged', trigger: 'occasion' },
  iou: { name: '欠条', purpose: '承诺、约定和兑现条件。', pagination: 'forbidden', trigger: 'occasion' },
  'ticket-stub': { name: '票根', purpose: '为一次共同经历留下凭证。', pagination: 'forbidden', trigger: 'occasion' },
  telegram: { name: '电报', purpose: '短促、要紧、需要醒目的话。', pagination: 'forbidden', trigger: 'occasion' },
  extra: { name: '号外', purpose: '值得庆祝或突然宣布的消息。', pagination: 'forbidden', trigger: 'occasion' },
  prescription: { name: '处方笺', purpose: '照顾身体与生活的具体嘱咐。', pagination: 'forbidden', trigger: 'occasion' },
  checkup: { name: '健診表', purpose: '项目式检查和观察。', pagination: 'forbidden', trigger: 'rule' },
  'night-log': { name: '夜航日志', purpose: '按时刻记录夜里的片段，可自动续页。', pagination: 'paged', trigger: 'occasion' },
  starmap: { name: '某夜星空', purpose: '虚拟星空与文学场景的当夜记录，不表示真实观测。', pagination: 'forbidden', trigger: 'rule' },
  poem: { name: '诗', purpose: '按原有行分隔展示的诗。', pagination: 'forbidden', trigger: 'occasion' },
  omikuji: { name: '御神签', purpose: '一则带签意的轻巧祝福。', pagination: 'forbidden', trigger: 'occasion' },
  emblem: { name: '印记徽', purpose: '纪念日或特殊关系的印记，可自动续页。', pagination: 'paged', trigger: 'rule' },
  programme: { name: '节目单', purpose: '按时段排列的共同安排，可自动续页。', pagination: 'paged', trigger: 'occasion' },
};

const TRIGGER_RECOMMENDATION: Record<ProductionGenreId, string> = {
  wakepaper: '适合检测到主人早晨醒来后展示；正文过长时自动带附刊，不建议在夜间突然打断当前内容。',
  note: '适合模型有一段日常话想留下时主动选择，也适合作为没有更专门体裁时的稳妥承载。',
  'weekly-chart': '适合每周固定一天、已有一周数据后生成；缺少完整一周数据时不要触发。',
  weather: '适合每天早晨或天气明显变化时生成；必须使用已授权天气数据，不能由模型猜。',
  almanac: '适合每日清晨，日期、节气和宜忌数据齐全时生成；没有数据源时不要编造。',
  postcard: '适合旅行、想念或一句留白较多的短寄语，由作者意图触发，不需要固定周期。',
  'boarding-pass': '适合出发前、接人或共同旅程临近时使用；需要真实行程字段。',
  itinerary: '适合已有多个时段安排的当天或行前展示；没有明确时间表时改用便签。',
  passport: '适合抵达新地点、旅行纪念日或回顾共同地点时使用；地点和日期必须有来源。',
  customs: '适合旅行结束、搬家或回顾想带回的事物时使用，条目应来自作者原稿。',
  iou: '适合明确承诺、约定或补偿条件出现时使用，不作为普通日常留言的默认样式。',
  'ticket-stub': '适合电影、演出、约会或共同经历结束后留存纪念，事件应当真实发生。',
  telegram: '适合短促、紧要、希望一眼看到的消息；长文应改用便签或醒来纸。',
  extra: '适合值得庆祝或突然宣布的消息，在明确喜讯出现时使用，避免日常内容滥用。',
  prescription: '适合照顾身体和生活的具体嘱咐；不是医疗诊断，内容必须来自作者。',
  checkup: '适合固定周期的状态回顾或已有检查项目时生成；没有项目数据时不要触发。',
  'night-log': '适合夜间结束、已有多个时刻记录后整理；白天普通叙述优先选择便签。',
  starmap: '适合特定夜晚或纪念时展示虚拟星空；不需要天气、星历或真实观测来源。',
  poem: '适合作者明确写成诗或保留分行十分重要的内容；不能把普通散文擅自改写成诗。',
  omikuji: '适合轻巧的鼓励或仪式感祝福，由作者意图触发；签意不得冒充预测事实。',
  emblem: '适合纪念日、关系里程碑或长期印记；应绑定真实纪念信息或作者明确意图。',
  programme: '适合已经排好顺序的共同活动或一天安排；无节目顺序时改用便签。',
};

const layoutIdFor = (genre: Exclude<ProductionGenreId, 'note'>): ProductionLayoutId =>
  `${genre}-portrait` as ProductionLayoutId;

const commonFields = [
  'schemaVersion', 'intent', 'body', 'title', 'subtitle', 'signature', 'bylines',
  'protectedText', 'tone', 'genrePreference', 'genrePreferenceMode',
  'layoutVariant', 'delivery', 'titleAdaptation', 'content', 'authorFields',
] as const;

const requiredFacts = (genre: ProductionGenreId): readonly string[] => {
  if (genre === 'weather') return ['weather_snapshot'];
  if (genre === 'almanac') return ['lunar_date', 'solar_term', 'moon_phase'];
  return [];
};

const DUAL_BYLINE_GENRES = new Set<ProductionGenreId>(['weekly-chart', 'iou', 'itinerary', 'extra', 'emblem']);

export function bylineRolesForGenre(genre: ProductionGenreId): readonly ('issuer' | 'recipient')[] {
  return DUAL_BYLINE_GENRES.has(genre) ? ['issuer', 'recipient'] : ['issuer'];
}

const generated = PRODUCTION_GENRE_IDS
  .filter((genre): genre is Exclude<ProductionGenreId, 'note'> => genre !== 'note')
  .map((genre): ProductionLayout => ({
    id: layoutIdFor(genre),
    genre,
    name_zh: META[genre].name,
    purpose_zh: META[genre].purpose,
    orientation: 'portrait',
    pagination: META[genre].pagination,
    accepted_author_fields: commonFields,
    required_fact_fields: requiredFacts(genre),
    conditional_length_guidance_zh: META[genre].pagination === 'forbidden'
      ? '单页；是否容纳以固定字号的真实渲染为准。'
      : '按真实渲染分页，最多 16 页。',
    renderer_family: 'original-paper-v1',
    theme_revision: `${genre}-device-readable-${genre === 'passport' ? 'v5' : genre === 'customs' ? 'v4' : 'v3'}`,
    resources_revision: PRODUCTION_RESOURCES_REVISION,
    trigger: META[genre].trigger,
    trigger_recommendation_zh: TRIGGER_RECOMMENDATION[genre],
    usage_recommendation_zh: META[genre].purpose,
    signature_slot: genre,
    byline_roles: bylineRolesForGenre(genre),
    source: 'builtin',
    availability: genre === 'weekly-chart' ? 'shelved' : 'enabled',
  }));

const noteLayout = (): ProductionLayout => ({
  id: 'note-portrait-v4',
  genre: 'note',
  name_zh: '便签',
  purpose_zh: META.note.purpose,
  orientation: 'portrait',
  pagination: 'paged',
  accepted_author_fields: commonFields,
  required_fact_fields: [],
  conditional_length_guidance_zh: '按真实渲染分页，最多 16 页。',
  renderer_family: 'note-v1',
  theme_revision: 'note-portrait-v4',
  resources_revision: PRODUCTION_RESOURCES_REVISION,
  trigger: META.note.trigger,
  trigger_recommendation_zh: TRIGGER_RECOMMENDATION.note,
  usage_recommendation_zh: META.note.purpose,
  signature_slot: 'note',
  byline_roles: ['issuer'],
  source: 'builtin',
  availability: 'enabled',
});

const landscapeLayout = (id: 'postcard-landscape' | 'ticket-stub-landscape' | 'poem-landscape', genre: 'postcard' | 'ticket-stub' | 'poem'): ProductionLayout => {
  const portrait = generated.find((layout) => layout.genre === genre)!;
  return {
    ...portrait,
    id,
    name_zh: `${portrait.name_zh}（横屏）`,
    orientation: 'landscape',
    theme_revision: `${genre}-landscape-device-readable-v3`,
    conditional_length_guidance_zh: '横屏单页；是否容纳以 960×540 固定字号的真实渲染为准。',
  };
};

export const PRODUCTION_LAYOUTS: readonly ProductionLayout[] = [
  ...generated.slice(0, 1),
  noteLayout(),
  ...generated.slice(1),
  landscapeLayout('postcard-landscape', 'postcard'),
  landscapeLayout('ticket-stub-landscape', 'ticket-stub'),
  landscapeLayout('poem-landscape', 'poem'),
];

export const ENABLED_PRODUCTION_LAYOUTS: readonly ProductionLayout[] = PRODUCTION_LAYOUTS.filter(
  (layout) => layout.availability === 'enabled',
);

export interface ProductionCatalogSnapshot {
  revision: string;
  resources_revision: string;
  enabled_layouts: readonly ProductionLayout[];
  request: { genre_preference: string | null; preference_mode: string | null; layout_variant: string | null };
}

interface CatalogSelectionInput { genrePreference?: unknown; genrePreferenceMode?: unknown; layoutVariant?: unknown }

export function freezeProductionCatalog(input: CatalogSelectionInput): ProductionCatalogSnapshot {
  return {
    revision: PRODUCTION_CATALOG_REVISION,
    resources_revision: PRODUCTION_RESOURCES_REVISION,
    enabled_layouts: ENABLED_PRODUCTION_LAYOUTS.map((layout) => ({
      ...layout,
      accepted_author_fields: [...layout.accepted_author_fields],
      required_fact_fields: [...layout.required_fact_fields],
    })),
    request: {
      genre_preference: typeof input.genrePreference === 'string' ? input.genrePreference : null,
      preference_mode: typeof input.genrePreferenceMode === 'string' ? input.genrePreferenceMode : null,
      layout_variant: typeof input.layoutVariant === 'string' ? input.layoutVariant : null,
    },
  };
}

export function productionCatalogSnapshotJson(snapshot: ProductionCatalogSnapshot): string {
  return Buffer.from(canonicalJsonBytes(snapshot)).toString('utf8');
}

export function layoutForGenre(genre: ProductionGenreId, requested?: string): ProductionLayout {
  if (requested !== undefined) {
    const exact = PRODUCTION_LAYOUTS.find((layout) => layout.id === requested && layout.genre === genre);
    if (exact !== undefined) return exact;
  }
  const fallback = PRODUCTION_LAYOUTS.find((layout) => layout.genre === genre && !layout.id.endsWith('v3'));
  if (fallback === undefined) throw new Error(`production layout missing for ${genre}`);
  return fallback;
}

export function authorCatalogText(): string {
  const rows = ENABLED_PRODUCTION_GENRE_IDS.map((genre) => {
    const meta = META[genre];
    const guide = GENRE_CONTENT_GUIDES[genre];
    const layouts = PRODUCTION_LAYOUTS.filter((layout) => layout.genre === genre)
      .map((layout) => `${layout.id}(${layout.name_zh})`).join(',');
    return `${genre}（${meta.name}）：${guide.writing_zh} 主要栏目=${guide.primary_zh}；` +
      `可省略次要栏目=${guide.optional_zh}；事实边界=${guide.facts_zh}；触发建议=${TRIGGER_RECOMMENDATION[genre]}；` +
      `分页=${meta.pagination}；版式=${layouts}`;
  });
  return `作者版式目录 revision=${PRODUCTION_CATALOG_REVISION}。不指定体裁时服务会按内容与结构自动选择；` +
    `结构稿由 content.kind 明确选择体裁；strict 保持作者点名的体裁，preferred 在内容不适配时允许回退。` +
    `写天气预报前先调用 ephemera_peek(scope=weather) 看真实的今天、明天、后天；天气稿提交 content:{kind:"weather",commentary:"..."}，不能提交 content.kind=note，否则就是便签。` +
    `周谱目前搁置，不接受新稿，但历史作品仍可查看。\n` + rows.map((row) => `- ${row}`).join('\n');
}
