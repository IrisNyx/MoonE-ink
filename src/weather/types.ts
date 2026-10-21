export const WEATHER_SNAPSHOT_SCHEMA = 'ephemera-weather-snapshot-v1' as const;
export const WEATHER_ICON_MAPPING_REVISION = 'weather-icons-qweather-wmo-2026-10-13.1';

export const WEATHER_ICON_KINDS = [
  'clear', 'clear-night', 'cloud-sun', 'cloud-moon', 'cloud', 'overcast',
  'rain', 'snow', 'storm', 'fog', 'unknown',
] as const;
export type WeatherIconKind = (typeof WEATHER_ICON_KINDS)[number];

export interface WeatherLocation {
  id: string;
  name: string;
  full_name: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface WeatherCurrentFact {
  observed_at: string;
  temperature_c: number;
  feels_like_c: number | null;
  description: string;
  provider_code: string;
  is_day: boolean;
  icon: WeatherIconKind;
}

export interface WeatherDailyFact {
  date: string;
  forecast_start: string;
  forecast_end: string;
  temperature_min_c: number;
  temperature_max_c: number;
  description: string;
  provider_code: string;
  icon: WeatherIconKind;
  sunrise: string | null;
  sunset: string | null;
}

export interface WeatherSnapshot {
  schema: typeof WEATHER_SNAPSHOT_SCHEMA;
  provider: 'qweather';
  provider_name: '和风天气';
  mapping_revision: string;
  location: WeatherLocation;
  fetched_at: string;
  valid_until: string;
  attribution: readonly string[];
  current: WeatherCurrentFact;
  days: readonly [WeatherDailyFact, WeatherDailyFact, WeatherDailyFact];
}

function dayNight(base: 'clear' | 'cloud-sun', isDay: boolean): WeatherIconKind {
  if (base === 'clear') return isDay ? 'clear' : 'clear-night';
  return isDay ? 'cloud-sun' : 'cloud-moon';
}

/** Map current QWeather condition codes without discarding the provider text. */
export function qweatherIcon(code: string, isDay: boolean): WeatherIconKind {
  const value = Number(code);
  if (!Number.isInteger(value)) return 'unknown';
  if (value === 100 || value === 150) return dayNight('clear', isDay);
  if ([101, 102, 103, 151, 152, 153].includes(value)) return dayNight('cloud-sun', isDay);
  if (value === 104) return 'overcast';
  if (value >= 200 && value <= 213) return 'cloud';
  if ([302, 303, 304].includes(value)) return 'storm';
  if ((value >= 300 && value <= 399) || (value >= 350 && value <= 399)) return 'rain';
  if (value >= 400 && value <= 499) return 'snow';
  if (value >= 500 && value <= 515) return 'fog';
  return 'unknown';
}

/** Kept at the normalization boundary so an Open-Meteo choice needs no renderer change. */
export function wmoIcon(code: number, isDay: boolean): WeatherIconKind {
  if (code === 0) return dayNight('clear', isDay);
  if (code === 1 || code === 2) return dayNight('cloud-sun', isDay);
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code === 95 || code === 96 || code === 99) return 'storm';
  return 'unknown';
}

export function weatherDayLabel(index: number): string {
  return index === 0 ? '今天' : index === 1 ? '明天' : index === 2 ? '后天' : `第 ${index + 1} 天`;
}

export function weatherTemperatureLabel(minimum: number, maximum: number): string {
  return `${Math.round(minimum)}–${Math.round(maximum)}℃`;
}
