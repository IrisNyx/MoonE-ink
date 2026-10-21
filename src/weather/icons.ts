import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEATHER_ICON_KINDS, type WeatherIconKind } from './types.js';

const iconRoot = join(import.meta.dirname, '../../../assets/weather');
const cache = new Map<WeatherIconKind, string>();

export function weatherIconDataUrl(kind: WeatherIconKind): string {
  const cached = cache.get(kind);
  if (cached !== undefined) return cached;
  const safe = (WEATHER_ICON_KINDS as readonly string[]).includes(kind) ? kind : 'unknown';
  const bytes = readFileSync(join(iconRoot, `${safe}.svg`));
  const value = `data:image/svg+xml;base64,${bytes.toString('base64')}`;
  cache.set(kind, value);
  return value;
}

export function weatherSnapshotIconData(snapshot: {
  current: { icon: WeatherIconKind };
  days: readonly [{ icon: WeatherIconKind }, { icon: WeatherIconKind }, { icon: WeatherIconKind }];
}): { current: string; days: [string, string, string] } {
  return {
    current: weatherIconDataUrl(snapshot.current.icon),
    days: snapshot.days.map((day) => weatherIconDataUrl(day.icon)) as [string, string, string],
  };
}
