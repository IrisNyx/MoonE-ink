import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { WeatherSettingsStore } from '../src/weather/settings.js';
import { WEATHER_SNAPSHOT_SCHEMA } from '../src/weather/types.js';
import { connectModernClient } from './helpers/client.js';
import { freshDir } from './helpers/env.js';
import { startService } from './helpers/proc.js';

test('author credential sees exactly publish and peek, and peek contains content state rather than diagnostics', async () => {
  const service = await startService({
    configOverride(config) {
      const auth = config['auth'] as { credentials: Array<Record<string, unknown>> };
      auth.credentials[0]!['tool_view'] = 'author';
    },
  });
  try {
    const connection = await connectModernClient({ port: service.port, token: service.token });
    try {
      const listed = await connection.client.listTools();
      deepStrictEqual(listed.tools.map((tool) => tool.name).sort(), ['ephemera_peek', 'ephemera_publish']);
      const peekTool = listed.tools.find((tool) => tool.name === 'ephemera_peek')!;
      const publishTool = listed.tools.find((tool) => tool.name === 'ephemera_publish')!;
      strictEqual(JSON.stringify(peekTool.inputSchema).includes('expected_instance_id'), false);
      const publishSchema = JSON.stringify(publishTool.inputSchema);
      strictEqual(publishSchema.includes('\"const\"'), false, 'author schema avoids const for mobile MCP hosts');
      strictEqual(publishSchema.includes('\"oneOf\"'), false, 'author schema avoids oneOf for mobile MCP hosts');
      strictEqual(JSON.stringify(publishTool.outputSchema).includes('\"const\"'), false,
        'author output schema avoids const for mobile MCP hosts');
      for (const kind of ['wakepaper', 'weather', 'almanac', 'telegram', 'checkup', 'night-log', 'starmap', 'programme']) {
        ok(publishSchema.includes(`\"${kind}\"`), `author schema advertises ${kind}`);
      }
      strictEqual(publishSchema.includes('weekly-chart'), false, 'shelved weekly chart is absent from the author schema');
      strictEqual(publishSchema.includes('authorFields'), false, 'new author tool never exposes the legacy arbitrary field bag');
      ok(publishTool.description?.includes('周谱目前搁置'));
      const published = await connection.client.callTool({
        name: 'ephemera_publish',
        arguments: {
          manuscript: {
            schemaVersion: 3,
            intent: 'note',
            title: '结构稿实测',
            signature: '月亮',
            content: { kind: 'note', text: '这段文字经由真实 MCP 投稿。' },
          },
        },
      }) as unknown as { isError?: boolean; structuredContent?: { status: string; work: { body: string; title?: string; signature?: string } } };
      strictEqual(published.isError, undefined);
      strictEqual(published.structuredContent?.status, 'published');
      strictEqual(published.structuredContent?.work.body, '这段文字经由真实 MCP 投稿。');
      strictEqual(published.structuredContent?.work.title, '结构稿实测');
      strictEqual(published.structuredContent?.work.signature, '月亮');
      const result = await connection.client.callTool({ name: 'ephemera_peek', arguments: {} }) as unknown as {
        structuredContent: { current_state: string; current: unknown; unread_count: number; items: unknown[] };
      };
      strictEqual(result.structuredContent.current_state, 'unknown');
      strictEqual(result.structuredContent.current, null);
      strictEqual(result.structuredContent.unread_count, 1);
      strictEqual(result.structuredContent.items.length, 1);
    } finally {
      await connection.close();
    }
  } finally {
    await service.stop();
  }
});

test('author must read the real forecast before publishing a weather brief through the same two tools', { timeout: 120_000 }, async () => {
  const dataDir = freshDir('author-weather');
  const location = {
    id: 'test-hangzhou', name: '杭州', full_name: '杭州 · 浙江省 · 中国',
    latitude: 30.25, longitude: 120.16, timezone: 'Asia/Shanghai',
  };
  const store = new WeatherSettingsStore(dataDir);
  store.save({ enabled: true, api_host: 'demo.xy.qweatherapi.com', api_key: 'test-secret-not-for-author', location });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: location.timezone });
  const dates = [0, 1, 2].map((days) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  });
  const snapshot = {
    schema: WEATHER_SNAPSHOT_SCHEMA, provider: 'qweather', provider_name: '和风天气', mapping_revision: 'test',
    location, fetched_at: new Date().toISOString(), valid_until: new Date(Date.now() + 30 * 60_000).toISOString(),
    attribution: ['和风天气'],
    current: { observed_at: new Date().toISOString(), temperature_c: 19, feels_like_c: 18, description: '小雨', provider_code: '305', is_day: true, icon: 'rain' },
    days: dates.map((date, index) => ({
      date, forecast_start: `${date}T00:00:00Z`, forecast_end: `${date}T23:59:00Z`,
      temperature_min_c: 12 + index, temperature_max_c: 20 + index,
      description: ['小雨', '多云', '晴'][index], provider_code: ['305', '101', '100'][index],
      icon: ['rain', 'cloud-sun', 'clear'][index], sunrise: null, sunset: null,
    })),
  };
  mkdirSync(join(dataDir, 'settings', 'weather'), { recursive: true });
  writeFileSync(join(dataDir, 'settings', 'weather', 'snapshot.json'), JSON.stringify(snapshot));
  const service = await startService({
    dataDir,
    configOverride(config) {
      const auth = config['auth'] as { credentials: Array<Record<string, unknown>> };
      auth.credentials[0]!['tool_view'] = 'author';
    },
  });
  try {
    const connection = await connectModernClient({ port: service.port, token: service.token });
    try {
      const manuscript = { schemaVersion: 3, intent: 'share', content: { kind: 'weather', commentary: '明天多云，记得带上好心情。' } };
      const premature = await connection.client.callTool({ name: 'ephemera_publish', arguments: { manuscript } }) as unknown as {
        isError?: boolean; content: Array<{ text: string }>; structuredContent?: { status: string };
      };
      strictEqual(premature.isError, undefined);
      strictEqual(premature.structuredContent?.status, 'rejected');
      ok(premature.content[0]?.text.includes('scope=weather'));
      const peeked = await connection.client.callTool({ name: 'ephemera_peek', arguments: { scope: 'weather' } }) as unknown as {
        structuredContent?: { weather?: { forecast: Array<{ label: string; date: string; description: string }> } };
      };
      deepStrictEqual(peeked.structuredContent?.weather?.forecast.map((day) => [day.label, day.date, day.description]), [
        ['今天', dates[0], '小雨'], ['明天', dates[1], '多云'], ['后天', dates[2], '晴'],
      ]);
      strictEqual(JSON.stringify(peeked).includes('test-secret-not-for-author'), false);
      const published = await connection.client.callTool({ name: 'ephemera_publish', arguments: { manuscript } }) as unknown as {
        isError?: boolean; structuredContent?: { status: string; work: { genre: string } };
      };
      strictEqual(published.isError, undefined);
      strictEqual(published.structuredContent?.status, 'published');
      strictEqual(published.structuredContent?.work.genre, 'weather');
    } finally {
      await connection.close();
    }
  } finally {
    await service.stop();
  }
});
