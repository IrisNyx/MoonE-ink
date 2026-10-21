#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LIMITS = {
  max_pages_per_edition: 16,
  max_pages_response_bytes: 262144,
  max_history_response_bytes: 262144,
  max_actions_per_frame: 6,
  max_string_bytes: 4096,
  max_json_depth: 8,
  max_event_body_bytes: 32768,
  max_history_items: 50,
  request_timeout_ms: 15000,
  asset_download_timeout_ms: 30000,
};

function fail(message) { throw new Error(message); }
function parse(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined) fail(`invalid argument: ${args[i] ?? ''}`);
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}
function load(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail('simulator state is unreadable'); }
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(LIMITS.request_timeout_ms), ...options });
  const text = await response.text();
  let value;
  try { value = text.length === 0 ? null : JSON.parse(text); } catch { fail(`server returned non-JSON (${response.status})`); }
  if (!response.ok) fail(`${value?.error?.code ?? 'http_error'} (${response.status})`);
  return { response, value };
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (!args.endpoint || !args.state) {
    process.stdout.write('usage: node scripts/device-simulator.mjs --endpoint <http[s]://host> --state <private-json> [--device-id <id>] [--enrollment-code <code>]\n');
    process.exitCode = 2;
    return;
  }
  const endpoint = new URL(args.endpoint).toString().replace(/\/$/, '');
  const statePath = resolve(args.state);
  let state;
  if (existsSync(statePath)) {
    state = load(statePath);
  } else {
    if (!args['enrollment-code']) fail('--enrollment-code is required for first pairing');
    const deviceId = args['device-id'] ?? 'ephemera_simulator_01';
    const paired = await jsonRequest(`${endpoint}/device/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol_version: 1,
        request_id: `pair_${Date.now().toString(36)}`,
        device_id: deviceId,
        enrollment_code: args['enrollment-code'],
        supported_profiles: ['epaper-540x960-gray4-v1'],
        limits: LIMITS,
      }),
    });
    state = {
      schema_version: 1,
      endpoint,
      binding: paired.value,
      next_seq: 1,
      outbox: [],
      etag: null,
      last_screen: null,
      presented_frame: null,
    };
    save(statePath, state);
  }
  if (state.endpoint !== endpoint) fail('endpoint differs from the paired simulator state');
  const auth = { authorization: `Bearer ${state.binding.device_secret}` };

  // Retry every durable event before observing new state. A lost response is
  // safe because the service de-duplicates the persisted id/seq/payload.
  while (state.outbox.length > 0) {
    await jsonRequest(`${endpoint}/device/v1/event`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(state.outbox[0]),
    });
    state.outbox.shift();
    save(statePath, state);
  }

  const screenResponse = await fetch(`${endpoint}/device/v1/screen`, {
    headers: { ...auth, ...(state.etag ? { 'if-none-match': state.etag } : {}) },
    signal: AbortSignal.timeout(state.binding.limits.request_timeout_ms),
  });
  let screen;
  if (screenResponse.status === 304) {
    screen = state.last_screen;
  } else {
    const text = await screenResponse.text();
    let value;
    try { value = JSON.parse(text); } catch { fail(`screen returned non-JSON (${screenResponse.status})`); }
    if (!screenResponse.ok) fail(`${value?.error?.code ?? 'screen_error'} (${screenResponse.status})`);
    screen = value;
    state.etag = screenResponse.headers.get('etag');
    state.last_screen = screen;
    save(statePath, state);
  }
  if (!screen || screen.availability?.state !== 'ready') {
    process.stdout.write(`${JSON.stringify({ ok: true, availability: screen?.availability?.state ?? 'unknown', downloaded_pages: 0 })}\n`);
    return;
  }
  const frame = screen.offer.frame;
  const pagesUrl = new URL(`${endpoint}/device/v1/publications/${encodeURIComponent(screen.offer.publication_id)}/pages`);
  pagesUrl.searchParams.set('profile', frame.profile);
  pagesUrl.searchParams.set('edition_id', frame.edition_id);
  const pages = (await jsonRequest(pagesUrl, { headers: auth })).value;
  if (pages.page_count !== pages.frames.length || pages.page_count > state.binding.limits.max_pages_per_edition) fail('pages manifest exceeds paired limits');
  const cacheDir = join(dirname(statePath), `${statePath.split(/[\\/]/).pop()}.cache`);
  mkdirSync(cacheDir, { recursive: true });
  for (const item of pages.frames) {
    const target = join(cacheDir, `${item.sha256}.bin`);
    if (!existsSync(target) || digest(readFileSync(target)) !== item.sha256) {
      const response = await fetch(new URL(item.asset, endpoint), {
        headers: auth,
        signal: AbortSignal.timeout(state.binding.limits.asset_download_timeout_ms),
      });
      if (!response.ok) fail(`asset download failed (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== item.byte_length || digest(bytes) !== item.sha256) fail('asset integrity check failed');
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
    }
  }

  const subject = {
    publication_id: screen.offer.publication_id,
    page_id: frame.page_id,
    frame_id: frame.frame_id,
    delivery_id: screen.offer.delivery_id,
  };
  const scope = {
    protocol_version: 1,
    instance_id: state.binding.instance_id,
    channel_id: state.binding.channel_id,
    epoch: state.binding.epoch,
    binding_id: state.binding.binding_id,
    device_id: state.binding.device_id,
  };
  if (state.presented_frame?.frame_id !== frame.frame_id) {
    const enqueue = (kind, presentedFrame) => {
      const seq = state.next_seq++;
      state.outbox.push({
        ...scope,
        event_id: `evt_${seq.toString().padStart(12, '0')}`,
        seq,
        kind,
        observed_at: new Date().toISOString(),
        subject,
        state: { active_app: 'ephemera', mode: 'follow_latest', pending_count: kind === 'cached' ? 1 : 0, presented_frame: presentedFrame },
      });
      save(statePath, state);
    };
    enqueue('cached', state.presented_frame);
    const presented = { publication_id: subject.publication_id, page_id: subject.page_id, frame_id: subject.frame_id };
    enqueue('presented', presented);
    state.presented_frame = presented;
    save(statePath, state);
    while (state.outbox.length > 0) {
      await jsonRequest(`${endpoint}/device/v1/event`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(state.outbox[0]),
      });
      state.outbox.shift();
      save(statePath, state);
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, availability: 'ready', publication_id: screen.offer.publication_id, edition_id: frame.edition_id, downloaded_pages: pages.page_count, presented_frame_id: frame.frame_id })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'simulator failed' })}\n`);
  process.exitCode = 1;
});
