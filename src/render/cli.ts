#!/usr/bin/env node
/**
 * Offline postcard renderer CLI.
 *
 *   node dist/src/render/cli.js --input manuscript.json --output <new-empty-dir>
 *
 * Arguments are parsed as an argv array (node:util parseArgs, strict). The
 * output directory must not exist or must be empty; nothing is overwritten.
 * On success stdout carries a single bounded JSON object (file basenames,
 * sizes, hashes, profile, toolchain identity). On failure stderr carries a
 * stable `{ok:false,error:{code,message}}` and the exit code is non-zero —
 * never body content, absolute paths, stack traces or secrets.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { RenderError, internalRenderError } from './errors.js';
import { renderPostcard } from './render.js';
import { RENDERER_BUILD } from '../version.js';

const MAX_MANUSCRIPT_BYTES = 128 * 1024;

function usage(): string {
  return [
    'ephemera postcard renderer (offline)',
    '',
    'usage: node dist/src/render/cli.js --input <manuscript.json> --output <new-empty-directory>',
    '',
    'manuscript: {"schema_version":1,"genre":"postcard","intent":"...","body":"...",',
    '             "tone?":"cream"|"gold"}  (title/subtitle have no postcard slot)',
  ].join('\n');
}

async function main(): Promise<number> {
  let values: { input?: string; output?: string; help?: boolean };
  try {
    values = parseArgs({
      options: {
        input: { type: 'string' },
        output: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }).values;
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'invalid_input', message: 'invalid command line arguments' } })}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (typeof values.input !== 'string' || typeof values.output !== 'string' || values.input.length === 0 || values.output.length === 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'invalid_input', message: '--input and --output are required' } })}\n`);
    return 2;
  }

  let raw: Buffer;
  try {
    raw = await readFile(values.input);
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'invalid_input', message: 'manuscript file could not be read' } })}\n`);
    return 2;
  }
  if (raw.length > MAX_MANUSCRIPT_BYTES) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'invalid_input', message: 'manuscript exceeds the maximum input size' } })}\n`);
    return 2;
  }
  let manuscript: unknown;
  try {
    manuscript = JSON.parse(raw.toString('utf8'));
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'invalid_input', message: 'manuscript is not valid JSON' } })}\n`);
    return 2;
  }

  const outcome = await renderPostcard({
    manuscript,
    manuscriptBytes: raw.length,
    outputPath: values.output,
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      profile: outcome.profile,
      genre: 'postcard',
      tone: outcome.tone,
      page: outcome.page,
      files: outcome.files,
      fonts: { manifest_version: outcome.fonts.manifestVersion, count: outcome.fonts.count, served: outcome.fonts.served },
      gray4: { byte_length: outcome.gray4.byteLength, ink_pixels: outcome.gray4.inkPixels },
      toolchain: {
        chromium: outcome.chromium.version,
        chromium_revision: outcome.chromium.revision,
        playwright: outcome.chromium.playwright,
        renderer_build: RENDERER_BUILD,
      },
    })}\n`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    const failure = error instanceof RenderError ? error : internalRenderError();
    process.stderr.write(`${JSON.stringify(failure.toShape())}\n`);
    process.exit(failure.exitCode);
  },
);
