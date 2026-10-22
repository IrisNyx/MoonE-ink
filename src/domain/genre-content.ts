import { z } from 'zod';
import { MASCOT_MOODS, NON_SLEEPY_MASCOT_MOODS, type MascotMood } from './mascot.js';

const mainText = (label: string, max = 16_384) => z.string().min(1).max(max).describe(label);
const secondaryText = (label: string, max = 4_096) => z.string().min(1).max(max).nullable().optional().describe(
  `${label}；省略表示可不刊或允许排版工补充，null 表示作者明确要求不刊登，排版工不得补写。`,
);
const textLines = (label: string, maxItems = 64) => z.array(mainText(label, 2_048)).min(1).max(maxItems);
const telegramLine = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Z]+(?: [A-Z]+)*$/, 'telegram lines must be short uppercase English words separated by single spaces')
  .refine((line) => !line.split(' ').includes('STOP'), 'do not include STOP; the telegram layout adds it')
  .describe('一条已经写成电报体的纯英文大写短句；只用 A–Z 和单个空格，不写标点，也不要自行添加 STOP。');

const pinSchema = z.strictObject({
  time: mainText('作者提供的时间或时段，例如 08:30、上午；不得由服务编造。', 64),
  item: mainText('今日钉子的事项；须来自作者已有的真实事项。', 1_024),
});

const itineraryEntrySchema = z.strictObject({
  time: mainText('时段或时间。', 64),
  text: mainText('这一段行程的中文主要内容。', 2_048),
  english: secondaryText('辅助英文译文。', 2_048),
  mark: secondaryText('简短记号或同行标记。', 128),
});

const passportStampSchema = z.strictObject({
  place: mainText('印章地点或文学场景名称。', 512),
  english: secondaryText('地点的辅助英文名称。', 512),
  date: mainText('作者确定的日期文字。', 128),
  travellingAlone: z.boolean().describe('true 表示独行，false 表示同行。'),
});

const customsItemSchema = z.strictObject({
  item: mainText('申报的事物。', 1_024),
  quantity: mainText('数量或文学化数量表达。', 128),
  taxable: z.boolean().describe('作者希望票面标作应税时为 true。'),
  note: secondaryText('这一项的辅助备注。', 1_024),
});

const authorOptionalText = (label: string, max = 4_096) => z.string().min(1).max(max).nullable().optional().describe(
  `${label}；省略表示不刊，null 也表示明确不刊。这是作者内容，排版工不得补写。`,
);

const settlementSchema = z.strictObject({
  when: mainText('何时偿付或在什么条件成立后偿付。', 1_024),
  method: mainText('如何偿付。', 2_048),
  conditions: z.array(mainText('作者确定的附加条件。', 1_024)).max(16).optional(),
  overduePolicy: authorOptionalText('逾期或未实现时的处理办法。', 1_024),
});

const prescriptionItemSchema = z.strictObject({
  instruction: mainText('作者给出的具体嘱咐。', 2_048),
  dosage: mainText('用法、频次或执行方式。', 512),
});

const checkupItemSchema = z.strictObject({
  item: mainText('检查或观察项目。', 512),
  grade: z.enum(['A', 'B', 'C', 'D', 'E']).describe('作者依据自身资料给出的 A–E 评级；服务不会自动评 A。'),
  note: secondaryText('辅助备注；不得引入新的健康判断。', 1_024),
  highlight: z.boolean().optional().describe('是否在版面上重点标记；省略等同于 false。'),
});

const nightLogEntrySchema = z.strictObject({
  time: mainText('事件发生的时间或时段。', 64),
  event: mainText('事件内容；声称已经执行的动作必须有作者侧真实记录。', 2_048),
  tag: secondaryText('基于该事件的简短标签。', 128),
});

const programmeEntrySchema = z.strictObject({
  time: mainText('节目时间或顺序标记。', 64),
  text: mainText('节目主要内容。', 2_048),
  english: secondaryText('节目辅助英文译文。', 2_048),
  act: secondaryText('幕次或段落标签。', 128),
});

export const noteContentSchema = z.strictObject({
  kind: z.literal('note'),
  text: mainText('便签正文，保留作者换行。'),
});

export const wakepaperContentSchema = z.strictObject({
  kind: z.literal('wakepaper'),
  nightText: mainText('“夜里这边”的完整主文；过长时会自动成为同一作品的附刊。', 64 * 1024),
  todayPins: z.array(pinSchema).max(24).optional().describe('作者已经掌握的今日事项；省略时服务不读取或编造 Todo。'),
  oneLine: secondaryText('辅助的一句话或晨间收尾。', 1_024),
});

export const weatherContentSchema = z.strictObject({
  kind: z.literal('weather'),
  commentary: mainText('先用 ephemera_peek(scope=weather) 读取真实三日预报，再写天气说明或寄语；不要猜天气。天气事实由服务出版时重新核对并填入。', 8_192),
  closing: secondaryText('可选的天气提醒或收尾；涉及天气事实时应依据刚读取的预报。', 1_024),
});

export const almanacContentSchema = z.strictObject({
  kind: z.literal('almanac'),
  suitable: mainText('作者创作的“宜”内容。', 4_096),
  avoid: mainText('作者创作的“忌”内容。', 4_096),
  closing: secondaryText('辅助寄语或收尾。', 1_024),
});

export const postcardContentSchema = z.strictObject({
  kind: z.literal('postcard'),
  message: mainText('明信片留言，保留作者换行。', 8_192),
  sentFrom: secondaryText('寄出地或文学场景。', 512),
  closing: secondaryText('辅助收尾。', 1_024),
});

export const boardingPassContentSchema = z.strictObject({
  kind: z.literal('boarding-pass'),
  origin: mainText('出发地。', 256),
  destination: mainText('目的地。', 256),
  passenger: mainText('乘客或被邀请者。', 256),
  seat: mainText('座位或文学化席位。', 128),
  gate: mainText('登机口或文学化入口。', 128),
  boardingTime: mainText('登机时间或出发时段。', 128),
  message: secondaryText('辅助寄语或收尾。', 1_024),
});

export const itineraryContentSchema = z.strictObject({
  kind: z.literal('itinerary'),
  entries: z.array(itineraryEntrySchema).min(1).max(64).describe('完整、有序的行程条目。'),
  closing: secondaryText('辅助收尾。', 1_024),
});

export const passportContentSchema = z.strictObject({
  kind: z.literal('passport'),
  holder: mainText('护照页持有人或纪念对象。', 256),
  stamps: z.array(passportStampSchema).min(1).max(64).describe('完整、有序的印章条目。'),
  closing: secondaryText('辅助寄语或收尾。', 1_024),
});

export const customsContentSchema = z.strictObject({
  kind: z.literal('customs'),
  items: z.array(customsItemSchema).min(1).max(64).describe('完整、有序的申报条目。'),
  summary: secondaryText('辅助总结或题注。', 2_048),
});

export const iouContentSchema = z.strictObject({
  kind: z.literal('iou'),
  declaration: mainText('“立据”栏正文，例如“记名在此”；这是票面正文，不是底部落款。', 1_024),
  reason: mainText('立下欠条的事由；必须由作者说清。', 2_048),
  obligation: mainText('具体所欠的事物、行动或承诺。', 4_096),
  settlement: settlementSchema,
  note: authorOptionalText('作者希望额外列明的备注。', 1_024),
  closing: secondaryText('辅助收尾。', 1_024),
});

export const ticketStubContentSchema = z.strictObject({
  kind: z.literal('ticket-stub'),
  promise: mainText('这张票根所兑现的约定或共同经历。', 2_048),
  fulfilledAt: mainText('实际兑现的日期或时段；不得由服务猜测。', 256),
  fulfillment: mainText('实际做了什么或发生了什么。', 4_096),
  note: authorOptionalText('作者希望额外列明的备注。', 1_024),
  closing: secondaryText('辅助收尾。', 1_024),
});

export const telegramContentSchema = z.strictObject({
  kind: z.literal('telegram'),
  lines: z.array(telegramLine).min(1).max(16)
    .describe('完整的电报正文；每项都是纯英文大写短句，模板会在每句后添加 STOP。'),
});

export const extraContentSchema = z.strictObject({
  kind: z.literal('extra'),
  report: mainText('号外的完整报道正文。', 16_384),
  englishSubtitle: secondaryText('黑色标题框底部的白色英文装饰句；只能是号外大标题的英文翻译。', 1_024),
  closing: secondaryText('辅助收尾。', 1_024),
});

export const prescriptionContentSchema = z.strictObject({
  kind: z.literal('prescription'),
  complaint: mainText('作者基于自身上下文提供的主诉或照顾主题。', 2_048),
  items: z.array(prescriptionItemSchema).min(1).max(32).describe('完整、有序的嘱咐条目。'),
  closing: secondaryText('不引入新健康判断的辅助关怀或收尾。', 1_024),
});

export const checkupContentSchema = z.strictObject({
  kind: z.literal('checkup'),
  items: z.array(checkupItemSchema).min(1).max(32).describe('作者依据自身资料给出的完整检查条目。'),
  overall: mainText('作者给出的完整总评；服务不会自动生成评级。', 2_048),
  closing: secondaryText('不引入新健康判断的辅助关怀或题注。', 1_024),
});

export const nightLogContentSchema = z.strictObject({
  kind: z.literal('night-log'),
  entries: z.array(nightLogEntrySchema).min(1).max(64).describe('完整、有序的夜航事件条目。'),
  handover: secondaryText('只基于已有事件的辅助交班文字。', 2_048),
});

export const starmapContentSchema = z.strictObject({
  kind: z.literal('starmap'),
  nightText: mainText('虚拟星空场景中的当夜文字；不表示真实观测。', 8_192),
  caption: secondaryText('虚拟星图的辅助图注。', 1_024),
  closing: secondaryText('辅助寄语或收尾。', 1_024),
});

export const poemContentSchema = z.strictObject({
  kind: z.literal('poem'),
  text: mainText('完整诗稿字符串；用换行符（JSON 中写作 \\n）分行，保留原文、空行和顺序。单句是否过长由实际排版检查，不会自动折行或删改。', 65_536),
});

export const omikujiContentSchema = z.strictObject({
  kind: z.literal('omikuji'),
  level: mainText('作者确定的签级。', 128),
  poem: textLines('作者原始的一行签诗。', 32),
  interpretation: mainText('作者给出的核心签意。', 4_096),
  englishSubtitle: secondaryText('辅助英文副题。', 1_024),
});

export const emblemContentSchema = z.strictObject({
  kind: z.literal('emblem'),
  memorialText: mainText('完整的纪念文字；纪念依据由作者侧掌握。', 16_384),
  englishSubtitle: secondaryText('大标题底下的英文装饰行；只能是印记徽大标题的英文翻译。', 1_024),
  closing: secondaryText('辅助收尾。', 1_024),
});

export const programmeContentSchema = z.strictObject({
  kind: z.literal('programme'),
  entries: z.array(programmeEntrySchema).min(1).max(64).describe('完整、有序的节目条目。'),
  closing: secondaryText('辅助收尾。', 1_024),
});

/**
 * The single executable author-content contract for every currently enabled
 * genre. Weekly chart deliberately remains outside this union: its renderer
 * and history stay supported, while new submissions are shelved.
 */
export const GENRE_CONTENT_SCHEMA = z.discriminatedUnion('kind', [
  noteContentSchema,
  wakepaperContentSchema,
  weatherContentSchema,
  almanacContentSchema,
  postcardContentSchema,
  boardingPassContentSchema,
  itineraryContentSchema,
  passportContentSchema,
  customsContentSchema,
  iouContentSchema,
  ticketStubContentSchema,
  telegramContentSchema,
  extraContentSchema,
  prescriptionContentSchema,
  checkupContentSchema,
  nightLogContentSchema,
  starmapContentSchema,
  poemContentSchema,
  omikujiContentSchema,
  emblemContentSchema,
  programmeContentSchema,
]);

// Published snapshots and queued jobs may still contain the original line
// array. Read them without migrating the author's stored content or digest.
export const STORED_GENRE_CONTENT_SCHEMA = z.union([
  GENRE_CONTENT_SCHEMA,
  z.strictObject({ kind: z.literal('poem'), lines: textLines('原始诗行', 64) }),
]);
export type GenreContent = z.infer<typeof STORED_GENRE_CONTENT_SCHEMA>;
export type EnabledGenreId = GenreContent['kind'];

function poemText(content: Extract<GenreContent, { kind: 'poem' }>): string {
  return 'text' in content ? content.text : content.lines.join('\n');
}

function poemLines(content: Extract<GenreContent, { kind: 'poem' }>): string[] {
  return 'text' in content ? content.text.split(/\r\n|\r|\n/) : [...content.lines];
}

export interface GenreContentGuide {
  name_zh: string;
  writing_zh: string;
  primary_zh: string;
  optional_zh: string;
  facts_zh: string;
}

export interface EditorSlot {
  /** Stable public path inside `content`; never an internal renderer abbreviation. */
  path: string;
  description_zh: string;
}

export interface EditorAddition {
  path: string;
  value: string;
}

/**
 * Return only secondary text slots that are actually absent. A present string
 * is immutable, however short; explicit null means "do not print" and is not
 * offered to the editor.
 */
export function missingEditorSlots(content: GenreContent): readonly EditorSlot[] {
  const slots: EditorSlot[] = [];
  const add = (path: string, value: string | null | undefined, description_zh: string): void => {
    if (value === undefined) slots.push({ path, description_zh });
  };
  switch (content.kind) {
    case 'note': break;
    case 'wakepaper':
      add('oneLine', content.oneLine, '不添加新事项的一句晨间辅助收尾');
      add('presentation.mascotMood', undefined, '根据整篇晨间内容选择 normal、happy、sad、thinking 或 sleepy；不能用表情改变文字含义');
      break;
    case 'weather': add('closing', content.closing, '只基于本次真实天气事实的辅助提醒或收尾'); break;
    case 'almanac': add('closing', content.closing, '不改宜忌、不编历法事实的辅助寄语'); break;
    case 'postcard':
      add('sentFrom', content.sentFrom, '不冒充真实定位的寄出地或文学场景');
      add('closing', content.closing, '不改留言的辅助收尾');
      break;
    case 'boarding-pass': add('message', content.message, '不发明旅程信息的辅助寄语'); break;
    case 'itinerary':
      content.entries.forEach((item, index) => {
        add(`entries.${index}.english`, item.english, '只翻译同一条中文行程的辅助英文');
        add(`entries.${index}.mark`, item.mark, '不改变行程内容的简短记号');
      });
      add('closing', content.closing, '不增加行程的辅助收尾');
      add('presentation.mascotMood', undefined, '已确定且令人高兴的行程选 happy，提议或待决定选 thinking，平常行程选 normal，取消或遗憾选 sad');
      break;
    case 'passport':
      content.stamps.forEach((item, index) => add(`stamps.${index}.english`, item.english, '同一地点的辅助英文名称'));
      add('closing', content.closing, '不增加经历的辅助寄语');
      break;
    case 'customs':
      content.items.forEach((item, index) => add(`items.${index}.note`, item.note, '不增加申报物品的辅助备注'));
      add('summary', content.summary, '只概括已有项目的辅助总结');
      break;
    case 'iou': add('closing', content.closing, '不改变承诺或偿付条件的辅助收尾'); break;
    case 'ticket-stub': add('closing', content.closing, '不改变兑付事实的辅助收尾'); break;
    case 'telegram': break;
    case 'extra':
      add('englishSubtitle', content.englishSubtitle, '只能把作者稿件顶层 title（号外大标题）忠实翻译成一行英文；不得改写标题、翻译报道正文或另拟副题');
      add('closing', content.closing, '不增加新事实的辅助收尾');
      break;
    case 'prescription': add('closing', content.closing, '不引入新健康判断的辅助关怀或收尾'); break;
    case 'checkup':
      content.items.forEach((item, index) => add(`items.${index}.note`, item.note, '不引入新观察或评级的辅助备注'));
      add('closing', content.closing, '不引入新健康判断的辅助关怀');
      break;
    case 'night-log':
      content.entries.forEach((item, index) => add(`entries.${index}.tag`, item.tag, '只概括同一事件、不新增行动的标签'));
      add('handover', content.handover, '只依据已有事件的辅助交班文字');
      break;
    case 'starmap':
      add('caption', content.caption, '明确为虚拟星空的辅助图注');
      add('closing', content.closing, '不声称真实观测的辅助寄语');
      break;
    case 'poem': break;
    case 'omikuji':
      add('englishSubtitle', content.englishSubtitle, '不改变签意的辅助英文副题');
      add('presentation.mascotMood', undefined, '结合签级、签诗和签解选择 happy、normal、thinking 或 sad；不能只看单个关键词');
      break;
    case 'emblem':
      add('englishSubtitle', content.englishSubtitle, '只能把作者稿件顶层 title（印记徽大标题）忠实翻译成一行英文；不得改写标题、翻译纪念正文或另拟副题');
      add('closing', content.closing, '不增加纪念事实的辅助收尾');
      break;
    case 'programme':
      content.entries.forEach((item, index) => {
        add(`entries.${index}.english`, item.english, '只翻译同一条节目的辅助英文');
        add(`entries.${index}.act`, item.act, '不改变节目内容的幕次或段落标签');
      });
      add('closing', content.closing, '不增加节目的辅助收尾');
      break;
  }
  return slots;
}

/** Validate and apply a model's bounded additions without touching author data. */
export function applyEditorAdditions(content: GenreContent, additions: readonly EditorAddition[]): GenreContent {
  const allowed = new Set(missingEditorSlots(content).map((slot) => slot.path));
  const seen = new Set<string>();
  const copy = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  for (const addition of additions) {
    if (!allowed.has(addition.path) || seen.has(addition.path) || addition.value.length < 1 ||
        Array.from(addition.value).length > 4_096) {
      throw new Error('editor addition is outside the offered secondary slots');
    }
    seen.add(addition.path);
    if (addition.path === 'presentation.mascotMood') {
      const allowedMoods: readonly string[] = content.kind === 'wakepaper' ? MASCOT_MOODS : NON_SLEEPY_MASCOT_MOODS;
      if (!allowedMoods.includes(addition.value)) throw new Error('editor mascot mood is invalid for this layout');
      continue;
    }
    if ((content.kind === 'extra' || content.kind === 'emblem') && addition.path === 'englishSubtitle') {
      const isOneLineEnglish = Array.from(addition.value).length <= 256 &&
        /\p{Script=Latin}/u.test(addition.value) &&
        /^[\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}]+$/u.test(addition.value) &&
        !/[\r\n]/u.test(addition.value);
      if (!isOneLineEnglish) throw new Error('editor title translation must be one line of English');
    }
    const parts = addition.path.split('.');
    let current: unknown = copy;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index]!;
      if (Array.isArray(current)) {
        const itemIndex = Number(key);
        if (!Number.isInteger(itemIndex) || current[itemIndex] === undefined) throw new Error('editor addition path is invalid');
        current = current[itemIndex];
      } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, key)) {
        current = (current as Record<string, unknown>)[key];
      } else {
        throw new Error('editor addition path is invalid');
      }
    }
    const leaf = parts.at(-1)!;
    if (typeof current !== 'object' || current === null || Array.isArray(current)) throw new Error('editor addition path is invalid');
    (current as Record<string, unknown>)[leaf] = addition.value;
  }
  return STORED_GENRE_CONTENT_SCHEMA.parse(copy);
}

/** Presentation-only model decision; it never becomes author content. */
export function editorMascotMood(content: GenreContent, additions: readonly EditorAddition[]): MascotMood | undefined {
  const addition = additions.find((item) => item.path === 'presentation.mascotMood');
  if (addition === undefined) return undefined;
  const allowedMoods: readonly string[] = content.kind === 'wakepaper' ? MASCOT_MOODS : NON_SLEEPY_MASCOT_MOODS;
  return allowedMoods.includes(addition.value) ? addition.value as MascotMood : undefined;
}

export const GENRE_CONTENT_GUIDES: Readonly<Record<EnabledGenreId, GenreContentGuide>> = {
  note: { name_zh: '便签', writing_zh: '日常文字，保留原换行，可自动分页。', primary_zh: '正文', optional_zh: '标题、落款', facts_zh: '出版日期由服务填写' },
  wakepaper: { name_zh: '醒来纸', writing_zh: '清晨长文；主文过长会带同一作品附刊。', primary_zh: '夜里这边主文', optional_zh: '作者已有的今日钉子、一句话', facts_zh: '出版日期由服务填写；Todo 只收作者提供的事项' },
  weather: { name_zh: '气象简报', writing_zh: '先用 ephemera_peek(scope=weather) 取得真实预报，再以 content.kind=weather 投稿；不要把天气稿作为 note。', primary_zh: '天气说明或寄语', optional_zh: '天气提醒、收尾', facts_zh: '服务端出版时重新核对真实当前天气和含今天的三日预报；不能猜测' },
  almanac: { name_zh: '残月黄历', writing_zh: '作者写宜忌，历法事实由程序给出。', primary_zh: '宜、忌', optional_zh: '寄语、收尾', facts_zh: '真实农历、节气、月相' },
  postcard: { name_zh: '明信片', writing_zh: '旅行、想念或留白较多的短寄语。', primary_zh: '留言', optional_zh: '寄出地、收尾', facts_zh: '邮戳出版日期由服务填写' },
  'boarding-pass': { name_zh: '登机牌', writing_zh: '旅程、邀请或即将出发的拟物票面。', primary_zh: '出发地、目的地、乘客、座位、入口、时间', optional_zh: '寄语、收尾', facts_zh: '右上出版日期由服务填写；不接航班源' },
  itinerary: { name_zh: '行程单', writing_zh: '按时段提交完整有序行程。', primary_zh: '时间与中文行程条目', optional_zh: '英文译文、记号、收尾', facts_zh: '无' },
  passport: { name_zh: '护照盖章页', writing_zh: '用地点、日期和同行状态保存回忆。', primary_zh: '持有人与印章地点、日期、同行状态', optional_zh: '英文地名、寄语', facts_zh: '无' },
  customs: { name_zh: '海关申报单', writing_zh: '逐项列出想带回的事物。', primary_zh: '事物、数量、应税标记', optional_zh: '备注、总结', facts_zh: '顶部出版日期由服务填写' },
  iou: { name_zh: '欠条', writing_zh: '按原版“立据、事由、所欠、偿付、备注”分别写清，不再自由命名条款。', primary_zh: '立据、事由、所欠、偿付时机与方式', optional_zh: '附加条件、逾期处理、备注、收尾、双方落款', facts_zh: '出版日期由服务填写' },
  'ticket-stub': { name_zh: '票根', writing_zh: '分别写清兑现的约定、实际日期和实际经历。', primary_zh: '兑现约定、实际日期、实际经历', optional_zh: '备注、收尾、落款', facts_zh: '事件应真实发生' },
  telegram: { name_zh: '电报', writing_zh: '只写简短的纯英文大写电报句；不用标点，不自行写 STOP，模板会添加 STOP。', primary_zh: '完整英文大写短句列表', optional_zh: '无', facts_zh: '无出版日期栏' },
  extra: { name_zh: '号外', writing_zh: '发布值得庆祝或突然宣布的消息。', primary_zh: '大标题和完整报道正文', optional_zh: '黑框底部的大标题英文翻译、收尾', facts_zh: '顶部出版日期由服务填写' },
  prescription: { name_zh: '处方笺', writing_zh: '生活照顾与身体关怀，不冒充医疗诊断。', primary_zh: '主诉、嘱咐、用法', optional_zh: '关怀题注、收尾', facts_zh: '出版日期由服务填写；健康依据由作者侧掌握' },
  checkup: { name_zh: '健診表', writing_zh: '按作者掌握的资料列检查项目与评级。', primary_zh: '项目、评级、总评', optional_zh: '备注、关怀题注', facts_zh: '右侧出版日期由服务填写；不自动评级' },
  'night-log': { name_zh: '夜航日志', writing_zh: '按时刻记录夜里真实发生或作者明确创作的片段。', primary_zh: '时间与完整事件条目', optional_zh: '标签、交班文字', facts_zh: '右侧出版日期由服务填写；完成式行动须有真实记录' },
  starmap: { name_zh: '某夜星空', writing_zh: '虚拟星空与文学场景，不代表真实观测。', primary_zh: '当夜文字', optional_zh: '图注、寄语、收尾', facts_zh: '右侧日期和真实出版时间由服务填写；已有有效天气快照时追加天气，否则省略；不接星历或观测源' },
  poem: { name_zh: '诗', writing_zh: '用 content.text 提交整首诗，以换行符（JSON 中写作 \\n）分行；原文和空行保留，单句过长由排版工退回并说明。', primary_zh: '完整诗稿字符串', optional_zh: '无', facts_zh: '出版日期由服务填写' },
  omikuji: { name_zh: '御神签', writing_zh: '作者创作的签级、签诗与签意，不冒充预测。', primary_zh: '签级、签诗、核心签意', optional_zh: '英文副题', facts_zh: '无' },
  emblem: { name_zh: '印记徽', writing_zh: '纪念日或关系里程碑的文字，可分页。', primary_zh: '纪念标题和纪念文字', optional_zh: '标题下方的大标题英文翻译、收尾', facts_zh: '出版日期由服务填写；纪念依据由作者侧掌握' },
  programme: { name_zh: '节目单', writing_zh: '按顺序提交共同活动或一天安排。', primary_zh: '时间与中文节目条目', optional_zh: '英文译文、幕次、收尾', facts_zh: '无' },
};

export function genreForContent(content: GenreContent): EnabledGenreId {
  return content.kind;
}

/** A deterministic internal projection for legacy job fields; authors never duplicate this as body. */
export function contentPrimaryText(content: GenreContent): string {
  switch (content.kind) {
    case 'note': return content.text;
    case 'wakepaper': return content.nightText;
    case 'weather': return content.commentary;
    case 'almanac': return `${content.suitable}\n${content.avoid}`;
    case 'postcard': return content.message;
    case 'boarding-pass': return [content.origin, content.destination, content.passenger, content.seat, content.gate, content.boardingTime].join('\n');
    case 'itinerary': return content.entries.map((item) => `${item.time} ${item.text}`).join('\n');
    case 'passport': return [content.holder, ...content.stamps.map((item) => `${item.place} ${item.date}`)].join('\n');
    case 'customs': return content.items.map((item) => `${item.item} ${item.quantity}`).join('\n');
    case 'iou': return [
      content.declaration, content.reason, content.obligation, content.settlement.when, content.settlement.method,
      ...(content.settlement.conditions ?? []),
      ...(present(content.settlement.overduePolicy) ? [content.settlement.overduePolicy] : []),
    ].join('\n');
    case 'ticket-stub': return [content.promise, content.fulfilledAt, content.fulfillment].join('\n');
    case 'telegram': return content.lines.join('\n');
    case 'extra': return content.report;
    case 'prescription': return [content.complaint, ...content.items.map((item) => `${item.instruction} ${item.dosage}`)].join('\n');
    case 'checkup': return [...content.items.map((item) => `${item.item} ${item.grade}`), content.overall].join('\n');
    case 'night-log': return content.entries.map((item) => `${item.time} ${item.event}`).join('\n');
    case 'starmap': return content.nightText;
    case 'poem': return poemText(content);
    case 'omikuji': return [content.level, ...content.poem, content.interpretation].join('\n');
    case 'emblem': return content.memorialText;
    case 'programme': return content.entries.map((item) => `${item.time} ${item.text}`).join('\n');
  }
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string';
}

/** Every author-owned textual segment, in author order, for loss detection. */
export function contentTextSegments(content: GenreContent): readonly string[] {
  const out: string[] = [];
  const push = (...values: Array<string | null | undefined>) => values.forEach((value) => { if (present(value)) out.push(value); });
  switch (content.kind) {
    case 'note': push(content.text); break;
    case 'wakepaper':
      push(content.nightText);
      content.todayPins?.forEach((item) => push(item.time, item.item));
      push(content.oneLine);
      break;
    case 'weather': push(content.commentary, content.closing); break;
    case 'almanac': push(content.suitable, content.avoid, content.closing); break;
    case 'postcard': push(content.message, content.sentFrom, content.closing); break;
    case 'boarding-pass': push(content.origin, content.destination, content.passenger, content.seat, content.gate, content.boardingTime, content.message); break;
    case 'itinerary':
      content.entries.forEach((item) => push(item.time, item.text, item.english, item.mark));
      push(content.closing);
      break;
    case 'passport':
      push(content.holder);
      content.stamps.forEach((item) => push(item.place, item.english, item.date));
      push(content.closing);
      break;
    case 'customs':
      content.items.forEach((item) => push(item.item, item.quantity, item.note));
      push(content.summary);
      break;
    case 'iou':
      push(content.declaration, content.reason, content.obligation, content.settlement.when, content.settlement.method);
      content.settlement.conditions?.forEach((item) => push(item));
      push(content.settlement.overduePolicy, content.note, content.closing);
      break;
    case 'ticket-stub':
      push(content.promise, content.fulfilledAt, content.fulfillment, content.note, content.closing);
      break;
    case 'telegram': content.lines.forEach((line) => push(line)); break;
    case 'extra': push(content.report, content.englishSubtitle, content.closing); break;
    case 'prescription':
      push(content.complaint);
      content.items.forEach((item) => push(item.instruction, item.dosage));
      push(content.closing);
      break;
    case 'checkup':
      content.items.forEach((item) => push(item.item, item.grade, item.note));
      push(content.overall, content.closing);
      break;
    case 'night-log':
      content.entries.forEach((item) => push(item.time, item.event, item.tag));
      push(content.handover);
      break;
    case 'starmap': push(content.nightText, content.caption, content.closing); break;
    case 'poem': poemLines(content).forEach((line) => push(line)); break;
    case 'omikuji': push(content.level, ...content.poem, content.interpretation, content.englishSubtitle); break;
    case 'emblem': push(content.memorialText, content.englishSubtitle, content.closing); break;
    case 'programme':
      content.entries.forEach((item) => push(item.time, item.text, item.english, item.act));
      push(content.closing);
      break;
  }
  return out;
}

/** Human-readable, lossless-enough plain-text projection used by author peek and the console original view. */
export function contentDisplayText(content: GenreContent): string {
  const line = (label: string, value: string | null | undefined): string[] => present(value) ? [`${label}：${value}`] : [];
  switch (content.kind) {
    case 'note': return content.text;
    case 'wakepaper': return [
      '夜里这边：', content.nightText,
      ...(content.todayPins === undefined ? [] : ['今日钉子：', ...content.todayPins.map((item) => `${item.time}｜${item.item}`)]),
      ...line('一句话', content.oneLine),
    ].join('\n');
    case 'weather': return ['天气说明：', content.commentary, ...line('收尾', content.closing)].join('\n');
    case 'almanac': return [`宜：${content.suitable}`, `忌：${content.avoid}`, ...line('寄语', content.closing)].join('\n');
    case 'postcard': return [content.message, ...line('寄出地', content.sentFrom), ...line('收尾', content.closing)].join('\n');
    case 'boarding-pass': return [
      `出发地：${content.origin}`, `目的地：${content.destination}`, `乘客：${content.passenger}`,
      `座位：${content.seat}`, `登机口：${content.gate}`, `登机时间：${content.boardingTime}`,
      ...line('寄语', content.message),
    ].join('\n');
    case 'itinerary': return [
      ...content.entries.map((item, index) => `${index + 1}. ${item.time}｜${item.text}${present(item.english) ? `｜${item.english}` : ''}${present(item.mark) ? `｜${item.mark}` : ''}`),
      ...line('收尾', content.closing),
    ].join('\n');
    case 'passport': return [
      `持有人：${content.holder}`,
      ...content.stamps.map((item, index) => `${index + 1}. ${item.place}${present(item.english) ? `｜${item.english}` : ''}｜${item.date}｜${item.travellingAlone ? '独行' : '同行'}`),
      ...line('寄语', content.closing),
    ].join('\n');
    case 'customs': return [
      ...content.items.map((item, index) => `${index + 1}. ${item.item}｜数量 ${item.quantity}｜${item.taxable ? '应税' : '不应税'}${present(item.note) ? `｜${item.note}` : ''}`),
      ...line('总结', content.summary),
    ].join('\n');
    case 'iou': return [
      `立据：${content.declaration}`,
      `事由：${content.reason}`,
      `所欠：${content.obligation}`,
      `偿付时机：${content.settlement.when}`,
      `偿付方式：${content.settlement.method}`,
      ...(content.settlement.conditions ?? []).map((item, index) => `附加条件 ${index + 1}：${item}`),
      ...line('逾期处理', content.settlement.overduePolicy),
      ...line('备注', content.note),
      ...line('收尾', content.closing),
    ].join('\n');
    case 'ticket-stub': return [
      `兑付：${content.promise}`,
      `日期：${content.fulfilledAt}`,
      `实付：${content.fulfillment}`,
      ...line('备注', content.note),
      ...line('收尾', content.closing),
    ].join('\n');
    case 'telegram': return content.lines.join('\n');
    case 'extra': return [content.report, ...line('英文副题', content.englishSubtitle), ...line('收尾', content.closing)].join('\n');
    case 'prescription': return [
      `主诉：${content.complaint}`,
      ...content.items.map((item, index) => `${index + 1}. ${item.instruction}｜${item.dosage}`),
      ...line('收尾', content.closing),
    ].join('\n');
    case 'checkup': return [
      ...content.items.map((item, index) => `${index + 1}. ${item.item}｜评级 ${item.grade}${present(item.note) ? `｜${item.note}` : ''}${item.highlight === true ? '｜重点' : ''}`),
      `总评：${content.overall}`,
      ...line('收尾', content.closing),
    ].join('\n');
    case 'night-log': return [
      ...content.entries.map((item, index) => `${index + 1}. ${item.time}｜${item.event}${present(item.tag) ? `｜${item.tag}` : ''}`),
      ...line('交班', content.handover),
    ].join('\n');
    case 'starmap': return [content.nightText, ...line('图注', content.caption), ...line('寄语', content.closing)].join('\n');
    case 'poem': return poemText(content);
    case 'omikuji': return [
      `签级：${content.level}`, ...content.poem, `签解：${content.interpretation}`,
      ...line('英文副题', content.englishSubtitle),
    ].join('\n');
    case 'emblem': return [content.memorialText, ...line('英文副题', content.englishSubtitle), ...line('收尾', content.closing)].join('\n');
    case 'programme': return [
      ...content.entries.map((item, index) => `${index + 1}. ${item.time}｜${item.text}${present(item.english) ? `｜${item.english}` : ''}${present(item.act) ? `｜${item.act}` : ''}`),
      ...line('收尾', content.closing),
    ].join('\n');
  }
}

/** Adapter from public names to the established visual component's internal Paper fields. */
export function contentToPaperFields(content: GenreContent): Record<string, unknown> {
  switch (content.kind) {
    case 'note': return { text: content.text, paragraphs: content.text.split(/\r\n|\r|\n/) };
    case 'wakepaper': return {
      night: content.nightText,
      ...(content.todayPins === undefined ? {} : { pins: content.todayPins.map((item) => ({ t: item.time, v: item.item })) }),
      ...(present(content.oneLine) ? { oneline: content.oneLine } : {}),
    };
    case 'weather': return { night: content.commentary, ...(present(content.closing) ? { oneline: content.closing } : {}) };
    case 'almanac': return { goodText: content.suitable, badText: content.avoid, ...(present(content.closing) ? { oneline: content.closing } : {}) };
    case 'postcard': return { text: content.message, ...(present(content.sentFrom) ? { place: content.sentFrom } : {}), ...(present(content.closing) ? { oneline: content.closing } : {}) };
    case 'boarding-pass': return {
      from: content.origin, to: content.destination, recipient: content.passenger,
      seat: content.seat, gate: content.gate, boards: content.boardingTime,
      ...(present(content.message) ? { oneline: content.message } : {}),
    };
    case 'itinerary': return {
      legs: content.entries.map((item) => ({ t: item.time, zh: item.text, en: present(item.english) ? item.english : '', x: present(item.mark) ? item.mark : '' })),
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'passport': return {
      holder: content.holder,
      stamps: content.stamps.map((item) => ({ ring: 'double', line: item.place, en: present(item.english) ? item.english : '', d: item.date, alone: item.travellingAlone })),
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'customs': return {
      customs: content.items.map((item) => ({ it: item.item, q: item.quantity, tax: item.taxable, note: present(item.note) ? item.note : '' })),
      ...(present(content.summary) ? { night: content.summary } : {}),
    };
    case 'iou': return {
      clauses: [
        { k: '立据', v: content.declaration },
        { k: '事由', v: content.reason },
        { k: '所欠', v: content.obligation },
        { k: '偿付', v: [content.settlement.when, content.settlement.method,
          ...(content.settlement.conditions ?? []),
          ...(present(content.settlement.overduePolicy) ? [content.settlement.overduePolicy] : []),
        ].join('；') },
        ...(present(content.note) ? [{ k: '备注', v: content.note }] : []),
      ],
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'ticket-stub': return {
      clauses: [
        { k: '兑付', v: content.promise },
        { k: '日期', v: content.fulfilledAt },
        { k: '实付', v: content.fulfillment },
        ...(present(content.note) ? [{ k: '备注', v: content.note }] : []),
      ],
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'telegram': return { tg: [...content.lines] };
    case 'extra': return {
      night: content.report,
      ...(present(content.englishSubtitle) ? { en: content.englishSubtitle } : {}),
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'prescription': return {
      note: content.complaint,
      rx: content.items.map((item) => ({ d: item.instruction, sig: item.dosage })),
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'checkup': return {
      checks: content.items.map((item) => ({ k: item.item, g: item.grade, note: present(item.note) ? item.note : '', ...(item.highlight === undefined ? {} : { over: item.highlight }) })),
      night: content.overall,
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'night-log': return {
      log: content.entries.map((item) => ({ t: item.time, e: item.event, tag: present(item.tag) ? item.tag : '' })),
      ...(present(content.handover) ? { night: content.handover } : {}),
    };
    case 'starmap': return {
      night: content.nightText,
      ...(present(content.caption) ? { caption: content.caption } : {}),
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'poem': return { poem: poemLines(content) };
    case 'omikuji': return {
      level: content.level, text: content.poem.join('\n'), poem: [...content.poem], note: content.interpretation,
      ...(present(content.englishSubtitle) ? { en: content.englishSubtitle } : {}),
    };
    case 'emblem': return {
      night: content.memorialText,
      ...(present(content.englishSubtitle) ? { en: content.englishSubtitle } : {}),
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
    case 'programme': return {
      prog: content.entries.map((item) => ({ t: item.time, zh: item.text, en: present(item.english) ? item.english : '', x: present(item.act) ? item.act : '' })),
      ...(present(content.closing) ? { oneline: content.closing } : {}),
    };
  }
}
