#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`--${name} is required`);
  return resolve(process.argv[index + 1]);
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

try {
  const build = argument('build');
  const output = argument('output');
  const definitions = [
    { name: 'bootloader.bin', address: 0x0000 },
    { name: 'partitions.bin', address: 0x8000 },
    { name: 'firmware.bin', address: 0x10000 },
  ];
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const segments = definitions.map((definition) => {
    const source = resolve(build, definition.name);
    const target = resolve(output, basename(definition.name));
    copyFileSync(source, target);
    return {
      ...definition,
      bytes: statSync(target).size,
      sha256: digest(target),
    };
  });
  const imageSettings = {
    // The board profile emits DIO image headers even though its flash chip is
    // wired for QIO-capable operation.  The header is the boot contract: do
    // not let a browser flasher rewrite it from board metadata.
    flash_mode: 'keep',
    flash_frequency: 'keep',
    flash_size: 'keep',
  };
  const releaseId = createHash('sha256')
    .update(JSON.stringify(imageSettings))
    .update(':')
    .update(segments.map((segment) => segment.sha256).join(':'))
    .digest('hex')
    .slice(0, 16);
  const manifest = {
    schema_version: 1,
    product: 'mooneink-t5-pro-lite',
    chip: 'ESP32-S3',
    release_id: releaseId,
    ...imageSettings,
    erase_all: true,
    segments,
  };
  writeFileSync(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, output, release_id: releaseId, segments: segments.length })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'export failed' })}\n`);
  process.exitCode = 1;
}
