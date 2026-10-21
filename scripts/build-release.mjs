#!/usr/bin/env node
import '../dist/src/runtime-security.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || destination === source || destination.startsWith(source + sep) || existsSync(destination)) {
  throw new Error('Pass a new output directory outside the source checkout: npm run release -- <directory>');
}
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Release command failed');
  return result.stdout;
}
if (run('git', ['status', '--porcelain']).trim()) throw new Error('Commit the release source before packaging.');
const commit = run('git', ['rev-parse', 'HEAD']).trim();
const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean);
mkdirSync(destination, { recursive: true });
for (const name of tracked) {
  const file = join(source, name);
  if (!lstatSync(file).isFile()) throw new Error(`Release source must be a regular file: ${name}`);
  mkdirSync(dirname(join(destination, name)), { recursive: true });
  cpSync(file, join(destination, name));
}
cpSync(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], destination);
const pkg = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
pkg.scripts = { start: 'node dist/src/index.js', 'check:runtime': 'node dist/src/runtime-security.js',
  data: 'node scripts/data-admin.mjs', 'simulate:device': 'node scripts/device-simulator.mjs' };
writeFileSync(join(destination, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release contains a symbolic link');
    if (entry.isDirectory()) walk(path);
    else {
      const data = readFileSync(path);
      files.push({ path: relative(destination, path).replaceAll('\\', '/'), bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
}
walk(destination);
const manifest = { schema_version: 1, created_at: new Date().toISOString(), service_version: pkg.version,
  source_commit: commit, build_platform: { platform: process.platform, arch: process.arch, node: process.version },
  unverified_platforms: ['linux', 'darwin'], required_node: pkg.engines.node,
  runtime_dependencies: Object.keys(pkg.dependencies).sort(),
  external_runtime: { chromium: '151.0.7922.34', environment: 'PLAYWRIGHT_BROWSERS_PATH' }, files };
writeFileSync(join(destination, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output: destination, version: pkg.version, source_commit: commit, files: files.length }));
