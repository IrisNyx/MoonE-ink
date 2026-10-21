import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessError } from '../errors.js';
import { QWeatherClient } from './qweather.js';
import { WEATHER_SNAPSHOT_SCHEMA, type WeatherLocation, type WeatherSnapshot } from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface StoredWeatherSettings {
  schema_version: 1;
  provider: 'qweather';
  enabled: boolean;
  api_host: string;
  location: WeatherLocation | null;
}

export interface WeatherSettingsView {
  provider: 'qweather';
  provider_name: '和风天气';
  enabled: boolean;
  api_host: string;
  api_key_set: boolean;
  location: WeatherLocation | null;
  cache: {
    available: boolean;
    fresh: boolean;
    fetched_at: string | null;
    valid_until: string | null;
  };
  snapshot: WeatherSnapshot | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validLocation(value: unknown): value is WeatherLocation {
  const row = object(value);
  return row !== null && typeof row['id'] === 'string' && row['id'].length <= 160 &&
    typeof row['name'] === 'string' && Array.from(row['name']).length <= 160 &&
    typeof row['full_name'] === 'string' && Array.from(row['full_name']).length <= 500 &&
    typeof row['latitude'] === 'number' && Number.isFinite(row['latitude']) && row['latitude'] >= -90 && row['latitude'] <= 90 &&
    typeof row['longitude'] === 'number' && Number.isFinite(row['longitude']) && row['longitude'] >= -180 && row['longitude'] <= 180 &&
    typeof row['timezone'] === 'string' && row['timezone'].length <= 100;
}

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function snapshotIsCurrent(snapshot: WeatherSnapshot | null, now: Date): snapshot is WeatherSnapshot {
  return snapshot !== null && Date.parse(snapshot.valid_until) > now.getTime() &&
    snapshot.days[0].date === localDate(now, snapshot.location.timezone);
}

function normalizedHost(value: string): string {
  let url: URL;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw new BusinessError('invalid_input', '和风天气 API Host 不是有效地址'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '' || !url.hostname.endsWith('.qweatherapi.com')) {
    throw new BusinessError('invalid_input', '请填写和风控制台分配的 HTTPS API Host（*.qweatherapi.com）');
  }
  return `https://${url.hostname}`;
}

export class WeatherSettingsStore {
  private readonly root: string;
  private readonly settingsPath: string;
  private readonly apiKeyPath: string;
  private readonly cachePath: string;

  constructor(
    dataDir: string,
    private readonly fetcher: FetchLike = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = join(dataDir, 'settings', 'weather');
    this.settingsPath = join(this.root, 'settings.json');
    this.apiKeyPath = join(this.root, 'api-key.txt');
    this.cachePath = join(this.root, 'snapshot.json');
  }

  view(): WeatherSettingsView {
    const settings = this.readSettings();
    const snapshot = this.readMatchingSnapshot(settings.location);
    const now = this.now();
    return {
      provider: 'qweather',
      provider_name: '和风天气',
      enabled: settings.enabled,
      api_host: settings.api_host,
      api_key_set: this.readApiKey() !== null,
      location: settings.location,
      cache: {
        available: snapshot !== null,
        fresh: snapshotIsCurrent(snapshot, now),
        fetched_at: snapshot?.fetched_at ?? null,
        valid_until: snapshot?.valid_until ?? null,
      },
      snapshot,
    };
  }

  save(input: { enabled?: unknown; api_host?: unknown; api_key?: unknown; location?: unknown }): WeatherSettingsView {
    const previous = this.readSettings();
    const enabled = input.enabled === undefined ? previous.enabled : input.enabled;
    const apiHostInput = input.api_host === undefined ? previous.api_host : input.api_host;
    const location = input.location === undefined ? previous.location : input.location;
    if (typeof enabled !== 'boolean' || typeof apiHostInput !== 'string' || apiHostInput.length > 2048 ||
        (location !== null && !validLocation(location))) {
      throw new BusinessError('invalid_input', '天气设置不完整或格式不正确');
    }
    const apiHost = apiHostInput.length === 0 ? '' : normalizedHost(apiHostInput);
    let apiKey = this.readApiKey();
    if (input.api_key !== undefined) {
      if (input.api_key === null || input.api_key === '') apiKey = null;
      else if (typeof input.api_key === 'string' && input.api_key.length <= 8192) apiKey = input.api_key;
      else throw new BusinessError('invalid_input', '和风天气 API Key 无效');
    }
    if (enabled && (apiHost.length === 0 || apiKey === null || location === null)) {
      throw new BusinessError('invalid_input', '启用天气出版前，需要填写 API Host、API Key 并选择地点');
    }
    mkdirSync(this.root, { recursive: true });
    this.atomicWrite(this.settingsPath, JSON.stringify({
      schema_version: 1,
      provider: 'qweather',
      enabled,
      api_host: apiHost,
      location,
    } satisfies StoredWeatherSettings));
    this.writeApiKey(apiKey);
    if (location === null || previous.location?.id !== location.id || previous.api_host !== apiHost) this.removeCache();
    return this.view();
  }

  async search(query: string, draft?: { api_host?: unknown; api_key?: unknown }): Promise<WeatherLocation[]> {
    const settings = this.readSettings();
    const draftHost = draft?.api_host === undefined ? settings.api_host : draft.api_host;
    if (typeof draftHost !== 'string' || draftHost.length > 2048) {
      throw new BusinessError('invalid_input', '和风天气 API Host 无效');
    }
    const host = draftHost.length === 0 ? '' : normalizedHost(draftHost);
    const savedKey = this.readApiKey();
    const draftKey = draft?.api_key;
    const key = draftKey === undefined || draftKey === '' ? savedKey : draftKey;
    if (key !== null && typeof key !== 'string') throw new BusinessError('invalid_input', '和风天气 API Key 无效');
    if (host.length === 0 || key === null) {
      throw new BusinessError('invalid_input', '请先保存和风天气 API Host 和 API Key');
    }
    return new QWeatherClient(host, key, this.fetcher, this.now).search(query);
  }

  async refresh(): Promise<WeatherSnapshot> {
    const settings = this.readSettings();
    const key = this.readApiKey();
    if (settings.api_host.length === 0 || key === null || settings.location === null) {
      throw new BusinessError('invalid_input', '请先保存和风天气连接并选择地点');
    }
    const snapshot = await new QWeatherClient(settings.api_host, key, this.fetcher, this.now).forecast(settings.location);
    mkdirSync(this.root, { recursive: true });
    this.atomicWrite(this.cachePath, JSON.stringify(snapshot));
    return snapshot;
  }

  async snapshotForPublication(): Promise<WeatherSnapshot> {
    const settings = this.readSettings();
    if (!settings.enabled) throw new BusinessError('asset_unavailable', '天气出版尚未在控制台启用');
    const cached = this.readMatchingSnapshot(settings.location);
    if (snapshotIsCurrent(cached, this.now())) return cached;
    const refreshed = await this.refresh();
    if (!snapshotIsCurrent(refreshed, this.now())) {
      throw new BusinessError('asset_unavailable', '天气服务尚未返回本地今天起的三日预报，请稍后再试', true);
    }
    return refreshed;
  }

  private readSettings(): StoredWeatherSettings {
    if (!existsSync(this.settingsPath)) return { schema_version: 1, provider: 'qweather', enabled: false, api_host: '', location: null };
    try {
      const value = object(JSON.parse(readFileSync(this.settingsPath, 'utf8')) as unknown);
      if (value === null || value['schema_version'] !== 1 || value['provider'] !== 'qweather' ||
          typeof value['enabled'] !== 'boolean' || typeof value['api_host'] !== 'string' ||
          (value['location'] !== null && !validLocation(value['location']))) throw new Error('invalid settings');
      return value as unknown as StoredWeatherSettings;
    } catch {
      throw new BusinessError('storage_unavailable', '天气设置无法读取', true);
    }
  }

  private readMatchingSnapshot(location: WeatherLocation | null): WeatherSnapshot | null {
    if (location === null || !existsSync(this.cachePath)) return null;
    try {
      const value = object(JSON.parse(readFileSync(this.cachePath, 'utf8')) as unknown);
      const cachedLocation = object(value?.['location']);
      if (value?.['schema'] !== WEATHER_SNAPSHOT_SCHEMA || value['provider'] !== 'qweather' ||
          cachedLocation?.['id'] !== location.id || !Array.isArray(value['days']) || value['days'].length !== 3 ||
          typeof value['fetched_at'] !== 'string' || typeof value['valid_until'] !== 'string') return null;
      return value as unknown as WeatherSnapshot;
    } catch {
      return null;
    }
  }

  private readApiKey(): string | null {
    try {
      if (!existsSync(this.apiKeyPath)) return null;
      const value = readFileSync(this.apiKeyPath, 'utf8').trim();
      return value.length === 0 ? null : value;
    } catch {
      throw new BusinessError('storage_unavailable', '天气凭据无法读取', true);
    }
  }

  private writeApiKey(value: string | null): void {
    if (value === null) {
      if (existsSync(this.apiKeyPath)) unlinkSync(this.apiKeyPath);
      return;
    }
    this.atomicWrite(this.apiKeyPath, `${value}\n`);
  }

  private removeCache(): void {
    if (existsSync(this.cachePath)) unlinkSync(this.cachePath);
  }

  private atomicWrite(path: string, value: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    renameSync(temporary, path);
  }
}
