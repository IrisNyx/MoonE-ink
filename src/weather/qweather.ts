import { BusinessError } from '../errors.js';
import {
  WEATHER_ICON_MAPPING_REVISION,
  WEATHER_SNAPSHOT_SCHEMA,
  qweatherIcon,
  type WeatherDailyFact,
  type WeatherLocation,
  type WeatherSnapshot,
} from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function valueNumber(value: unknown): number | null {
  return finite(object(value)?.['value']);
}

function dateInZone(instant: string, timezone: string): string {
  const parsed = new Date(instant);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid provider date');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function currentHourInZone(at: Date, timezone: string): number {
  const value = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at);
  return Number(value);
}

function isDaytime(at: Date, day: WeatherDailyFact | undefined, timezone: string): boolean {
  const sunrise = day?.sunrise === null || day?.sunrise === undefined ? Number.NaN : Date.parse(day.sunrise);
  const sunset = day?.sunset === null || day?.sunset === undefined ? Number.NaN : Date.parse(day.sunset);
  if (Number.isFinite(sunrise) && Number.isFinite(sunset)) return at.getTime() >= sunrise && at.getTime() < sunset;
  const hour = currentHourInZone(at, timezone);
  return hour >= 7 && hour < 19;
}

function attributions(...payloads: unknown[]): string[] {
  const values = new Set<string>();
  for (const payload of payloads) {
    const metadata = object(object(payload)?.['metadata']);
    const items = metadata?.['attributions'];
    if (Array.isArray(items)) for (const item of items) if (typeof item === 'string') values.add(item);
  }
  values.add('和风天气');
  return [...values];
}

function locationFromProvider(value: unknown): WeatherLocation | null {
  const row = object(value);
  if (row === null) return null;
  const id = text(row['id']);
  const name = text(row['name']);
  const latitude = Number(row['lat']);
  const longitude = Number(row['lon']);
  const timezone = text(row['tz']);
  if (id === null || name === null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || timezone === null) return null;
  const hierarchy = [name, text(row['adm2']), text(row['adm1']), text(row['country'])]
    .filter((item, index, all): item is string => item !== null && all.indexOf(item) === index);
  return { id, name, full_name: hierarchy.join(' · '), latitude, longitude, timezone };
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`provider returned HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('provider response is too large');
  return JSON.parse(body) as unknown;
}

export class QWeatherClient {
  constructor(
    private readonly apiHost: string,
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async get(path: string): Promise<unknown> {
    try {
      const response = await this.fetcher(new URL(path, `${this.apiHost}/`), {
        method: 'GET',
        headers: { 'X-QW-Api-Key': this.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      return await responseJson(response);
    } catch {
      throw new BusinessError('asset_unavailable', '无法取得和风天气数据，请检查 API Host、凭据和网络', true);
    }
  }

  async search(query: string): Promise<WeatherLocation[]> {
    const value = query.trim();
    if (Array.from(value).length < 1 || Array.from(value).length > 120) {
      throw new BusinessError('invalid_input', '请输入地点名称或经纬度');
    }
    const payload = object(await this.get(`geo/v2/city/lookup?location=${encodeURIComponent(value)}&number=10&lang=zh`));
    const rows = payload?.['location'];
    if (payload?.['code'] !== '200' || !Array.isArray(rows)) {
      throw new BusinessError('asset_unavailable', '和风天气没有返回可用的地点结果', true);
    }
    return rows.flatMap((row) => {
      const location = locationFromProvider(row);
      return location === null ? [] : [location];
    });
  }

  async forecast(location: WeatherLocation): Promise<WeatherSnapshot> {
    const latitude = location.latitude.toFixed(2);
    const longitude = location.longitude.toFixed(2);
    const [currentPayload, dailyPayload] = await Promise.all([
      this.get(`weather/v1/current/${latitude}/${longitude}?localTime=false&lang=zh`),
      this.get(`weather/v1/daily/${latitude}/${longitude}?days=3&localTime=false&lang=zh`),
    ]);
    const current = object(currentPayload);
    const daily = object(dailyPayload);
    const condition = object(current?.['condition']);
    const currentCode = text(condition?.['code']);
    const currentText = text(condition?.['text']);
    const temperature = valueNumber(current?.['temperature']);
    const feelsLike = valueNumber(current?.['feelsLike']);
    const rawDays = daily?.['days'];
    if (current === null || currentCode === null || currentText === null || temperature === null || !Array.isArray(rawDays)) {
      throw new BusinessError('asset_unavailable', '和风天气返回了无法识别的实时天气格式', true);
    }
    const days = rawDays.slice(0, 3).map((value): WeatherDailyFact | null => {
      const row = object(value);
      const daytime = object(row?.['daytime']);
      const dayCondition = object(daytime?.['condition']);
      const forecastStart = text(row?.['forecastStartTime']);
      const forecastEnd = text(row?.['forecastEndTime']);
      const description = text(dayCondition?.['text']);
      const providerCode = text(dayCondition?.['code']);
      const minimum = valueNumber(row?.['temperatureMin']);
      const maximum = valueNumber(row?.['temperatureMax']);
      const astro = object(row?.['astro']);
      if (row === null || forecastStart === null || forecastEnd === null || description === null ||
          providerCode === null || minimum === null || maximum === null) return null;
      return {
        date: dateInZone(forecastStart, location.timezone),
        forecast_start: forecastStart,
        forecast_end: forecastEnd,
        temperature_min_c: minimum,
        temperature_max_c: maximum,
        description,
        provider_code: providerCode,
        icon: qweatherIcon(providerCode, true),
        sunrise: text(astro?.['sunrise']),
        sunset: text(astro?.['sunset']),
      };
    });
    if (days.length !== 3 || days.some((day) => day === null)) {
      throw new BusinessError('asset_unavailable', '和风天气没有返回完整的三日预报', true);
    }
    const typedDays = days as [WeatherDailyFact, WeatherDailyFact, WeatherDailyFact];
    const fetchedAt = this.now();
    const currentDay = typedDays.find((day) => day.date === dateInZone(fetchedAt.toISOString(), location.timezone));
    const day = isDaytime(fetchedAt, currentDay, location.timezone);
    return {
      schema: WEATHER_SNAPSHOT_SCHEMA,
      provider: 'qweather',
      provider_name: '和风天气',
      mapping_revision: WEATHER_ICON_MAPPING_REVISION,
      location,
      fetched_at: fetchedAt.toISOString(),
      valid_until: new Date(fetchedAt.getTime() + 30 * 60_000).toISOString(),
      attribution: attributions(currentPayload, dailyPayload),
      current: {
        observed_at: fetchedAt.toISOString(),
        temperature_c: temperature,
        feels_like_c: feelsLike,
        description: currentText,
        provider_code: currentCode,
        is_day: day,
        icon: qweatherIcon(currentCode, day),
      },
      days: typedDays,
    };
  }
}
