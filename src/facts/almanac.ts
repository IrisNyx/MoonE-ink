import { MoonPhase } from 'astronomy-engine';
import { Solar } from 'lunar-javascript';

export const ALMANAC_FACTS_REVISION = 'almanac-facts-lunar-js-1.7.7-astronomy-engine-2.1.19-v1';
export const ALMANAC_SUPPORTED_YEARS = { min: 1900, max: 2100 } as const;

export interface AlmanacFacts {
  schema: 'ephemera-almanac-facts-v1';
  revision: string;
  date: string;
  timezone: 'Asia/Shanghai';
  lunar_date: {
    year: number;
    month: number;
    day: number;
    leap_month: boolean;
    label: string;
    short_label: string;
  };
  solar_term: {
    current: string;
    occurs_today: boolean;
    occurs_at_local: string | null;
  };
  moon_phase: {
    angle_degrees: number;
    label: '朔月' | '蛾眉月' | '上弦月' | '盈凸月' | '满月' | '亏凸月' | '下弦月' | '残月';
    sampled_at: string;
  };
  sources: readonly ['lunar-javascript', 'astronomy-engine'];
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new RangeError('almanac date must use YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < ALMANAC_SUPPORTED_YEARS.min || year > ALMANAC_SUPPORTED_YEARS.max ||
      month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError('almanac date is outside the supported range');
  }
  const verified = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(verified.valueOf()) || verified.getUTCFullYear() !== year ||
      verified.getUTCMonth() + 1 !== month || verified.getUTCDate() !== day) {
    throw new RangeError('almanac date is not a Gregorian calendar day');
  }
  return { year, month, day };
}

function moonPhaseLabel(angle: number): AlmanacFacts['moon_phase']['label'] {
  const sector = Math.round(angle / 45) % 8;
  return (['朔月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'] as const)[sector]!;
}

/**
 * Chinese calendar facts are computed for the civil day in Asia/Shanghai.
 * The astronomical phase is sampled at local noon, avoiding a hidden
 * dependency on the server machine's timezone.
 */
export function almanacFactsForDate(date: string): AlmanacFacts {
  const { year, month, day } = parseDate(date);
  const lunar = Solar.fromYmd(year, month, day).getLunar();
  const todayTerm = String(lunar.getJieQi());
  const currentTerm = todayTerm.length > 0 ? todayTerm : String(lunar.getPrevJieQi(true).getName());
  let occursAt: string | null = null;
  if (todayTerm.length > 0) {
    const termSolar = lunar.getJieQiTable()[todayTerm];
    if (termSolar !== undefined) occursAt = String(termSolar.toYmdHms());
  }
  // 12:00 Asia/Shanghai is 04:00 UTC. The product currently has one explicit
  // almanac timezone rather than inheriting the developer machine timezone.
  const sampled = new Date(`${date}T04:00:00.000Z`);
  const phaseAngle = MoonPhase(sampled);
  const lunarMonth = Number(lunar.getMonth());
  return {
    schema: 'ephemera-almanac-facts-v1',
    revision: ALMANAC_FACTS_REVISION,
    date,
    timezone: 'Asia/Shanghai',
    lunar_date: {
      year: Number(lunar.getYear()),
      month: Math.abs(lunarMonth),
      day: Number(lunar.getDay()),
      leap_month: lunarMonth < 0,
      label: `农历${lunar.getYearInChinese()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
      short_label: `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    },
    solar_term: { current: currentTerm, occurs_today: todayTerm.length > 0, occurs_at_local: occursAt },
    moon_phase: {
      angle_degrees: Number(phaseAngle.toFixed(3)),
      label: moonPhaseLabel(phaseAngle),
      sampled_at: sampled.toISOString(),
    },
    sources: ['lunar-javascript', 'astronomy-engine'],
  };
}
