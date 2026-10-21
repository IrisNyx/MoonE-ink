#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ADMIN_SCHEMA = 1;
const DATA_SCHEMA = 10;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE_VERSION = JSON.parse(readFileSync(join(SCRIPT_DIR, '..', 'package.json'), 'utf8')).version;
const POLICY_FILE = 'restore-policy.json';
const DEVICE_KEY_FILE = 'device-channel.key';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function parse(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--') || i + 1 >= rest.length) fail(`invalid argument: ${key}`);
    values[key.slice(2)] = rest[++i];
  }
  return values;
}

function requirePath(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`--${name} is required`);
  return resolve(value);
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function acquireAdministrationLock(dataDir) {
  const lock = join(dataDir, 'ephemera.lock');
  let fd;
  try {
    fd = openSync(lock, 'wx');
    writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), owner: 'ephemera-data' }));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error?.code === 'EEXIST') fail('service must be fully stopped before backup');
    fail('data directory administration lock could not be created');
  }
  closeSync(fd);
  return () => {
    try {
      const owner = JSON.parse(readFileSync(lock, 'utf8'));
      if (owner.pid === process.pid && owner.owner === 'ephemera-data') unlinkSync(lock);
    } catch {}
  };
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function safeRelative(root, file) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail('path escaped its root');
  return rel;
}

function walk(root) {
  const found = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) fail('symbolic links are not allowed in backup data');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) found.push(file);
    }
  }
  if (existsSync(root)) visit(root);
  return found.sort((a, b) => a.localeCompare(b));
}

function copyTree(source, target) {
  for (const file of walk(source)) {
    const rel = safeRelative(source, file);
    const output = join(target, ...rel.split('/'));
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(file, output);
  }
}

function readConfig(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('configuration is unreadable');
  }
  const credentials = value?.auth?.credentials;
  if (!Array.isArray(credentials) || credentials.length === 0) fail('configuration has no credential table');
  const normalized = credentials.map((entry) => {
    if (
      !ID.test(entry?.credential_id ?? '') ||
      !ID.test(entry?.caller_id ?? '') ||
      !SHA256.test(entry?.token_sha256 ?? '') ||
      typeof entry?.revoked !== 'boolean'
    ) fail('configuration credential table is invalid');
    return {
      credential_id: entry.credential_id,
      caller_id: entry.caller_id,
      token_sha256: entry.token_sha256,
      revoked: entry.revoked,
    };
  }).sort((a, b) => a.credential_id.localeCompare(b.credential_id));
  if (!normalized.some((entry) => !entry.revoked)) fail('configuration has no active credential');
  const configuredData = value?.server?.dataDir;
  if (typeof configuredData !== 'string' || configuredData.length === 0) fail('configuration dataDir is invalid');
  const device = value?.deviceChannel;
  const devicePolicy = device?.enabled === true
    ? {
        enabled: true,
        owner_token_sha256: SHA256.test(device?.owner_token_sha256 ?? '') ? device.owner_token_sha256 : fail('device owner credential is invalid'),
        channel_id: ID.test(device?.channel_id ?? '') ? device.channel_id : fail('device channel id is invalid'),
        publisher_caller_ids: Array.isArray(device?.publisher_caller_ids) ? [...device.publisher_caller_ids].sort() : fail('device publisher mapping is invalid'),
      }
    : { enabled: false };
  return {
    digest: createHash('sha256').update(JSON.stringify({ credentials: normalized, device: devicePolicy })).digest('hex'),
    // Match src/config.ts exactly: service-relative paths are resolved from
    // the launch working directory, not from the directory containing the
    // configuration file. Administration and runtime must agree on the same
    // directory before any backup or restore is allowed.
    dataDir: isAbsolute(configuredData) ? resolve(configuredData) : resolve(process.cwd(), configuredData),
  };
}

function inspectDatabase(dbFile, { checkpoint = false } = {}) {
  const db = new DatabaseSync(dbFile);
  try {
    if (checkpoint) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA foreign_keys = ON');
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') fail('database quick_check failed');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== DATA_SCHEMA) fail(`unsupported data schema: ${String(version)}`);
    const instance = db.prepare('SELECT instance_id, created_at FROM instance WHERE singleton = 1').get();
    if (!instance || typeof instance.instance_id !== 'string') fail('database instance identity is missing');
    const assets = db.prepare('SELECT sha256, byte_length, relative_path FROM asset ORDER BY relative_path').all();
    return { instance, assets };
  } finally {
    db.close();
  }
}

function verifyAssets(dataDir, rows) {
  for (const row of rows) {
    if (!SHA256.test(row.sha256) || typeof row.relative_path !== 'string') fail('database asset record is invalid');
    const file = resolve(dataDir, row.relative_path);
    const rel = relative(resolve(dataDir), file);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) fail('database asset path escapes data directory');
    if (!existsSync(file) || !lstatSync(file).isFile()) fail('referenced asset is missing');
    if (statSync(file).size !== row.byte_length || sha256File(file) !== row.sha256) fail('referenced asset failed integrity verification');
  }
}

function manifestFiles(dataRoot) {
  return walk(dataRoot).map((file) => ({
    path: safeRelative(dataRoot, file),
    bytes: statSync(file).size,
    sha256: sha256File(file),
  }));
}

function readManifest(backup) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(backup, 'backup-manifest.json'), 'utf8'));
  } catch {
    fail('backup manifest is unreadable');
  }
  if (
    manifest?.schema_version !== ADMIN_SCHEMA ||
    manifest?.data_schema_version !== DATA_SCHEMA ||
    manifest?.service_version !== SERVICE_VERSION ||
    typeof manifest?.instance_id !== 'string' ||
    !SHA256.test(manifest?.credential_policy_sha256 ?? '') ||
    !Array.isArray(manifest?.files)
  ) fail('backup manifest is incompatible');
  return manifest;
}

function verifyBackup(backup) {
  if (!existsSync(backup) || !lstatSync(backup).isDirectory()) fail('backup directory does not exist');
  const manifest = readManifest(backup);
  const data = join(backup, 'data');
  verifyDataFiles(data, manifest);
  const inspected = inspectDatabase(join(data, 'ephemera.sqlite'));
  if (inspected.instance.instance_id !== manifest.instance_id) fail('backup identity does not match its manifest');
  verifyAssets(data, inspected.assets);
  return { manifest, data, inspected };
}

function verifyDataFiles(data, manifest) {
  const expected = new Map();
  for (const entry of manifest.files) {
    if (
      typeof entry?.path !== 'string' || entry.path.length === 0 || entry.path.includes('..') ||
      typeof entry?.bytes !== 'number' || !SHA256.test(entry?.sha256 ?? '') || expected.has(entry.path)
    ) fail('backup manifest file entry is invalid');
    expected.set(entry.path, entry);
  }
  const actual = manifestFiles(data);
  if (actual.length !== expected.size) fail('backup file set does not match its manifest');
  for (const entry of actual) {
    const recorded = expected.get(entry.path);
    if (!recorded || recorded.bytes !== entry.bytes || recorded.sha256 !== entry.sha256) fail('backup file integrity check failed');
  }
}

function backup(values) {
  const dataDir = requirePath(values['data-dir'], 'data-dir');
  const configFile = requirePath(values.config, 'config');
  const output = requirePath(values.output, 'output');
  if (!existsSync(dataDir) || !lstatSync(dataDir).isDirectory()) fail('data directory does not exist');
  if (existsSync(output)) fail('backup output already exists');
  if (isInside(output, dataDir) || output === dataDir) fail('backup output must be outside the data directory');
  const config = readConfig(configFile);
  if (config.dataDir !== dataDir) fail('configuration dataDir does not match --data-dir');
  const releaseLock = acquireAdministrationLock(dataDir);
  const temporary = `${output}.tmp-${randomUUID()}`;
  try {
    const inspected = inspectDatabase(join(dataDir, 'ephemera.sqlite'), { checkpoint: true });
    verifyAssets(dataDir, inspected.assets);
    const data = join(temporary, 'data');
    mkdirSync(data, { recursive: true });
    copyFileSync(join(dataDir, 'ephemera.sqlite'), join(data, 'ephemera.sqlite'));
    if (existsSync(join(dataDir, 'assets'))) copyTree(join(dataDir, 'assets'), join(data, 'assets'));
    if (existsSync(join(dataDir, POLICY_FILE))) copyFileSync(join(dataDir, POLICY_FILE), join(data, POLICY_FILE));
    if (existsSync(join(dataDir, DEVICE_KEY_FILE))) copyFileSync(join(dataDir, DEVICE_KEY_FILE), join(data, DEVICE_KEY_FILE));
    const manifest = {
      schema_version: ADMIN_SCHEMA,
      created_at: new Date().toISOString(),
      service_version: SERVICE_VERSION,
      data_schema_version: DATA_SCHEMA,
      instance_id: inspected.instance.instance_id,
      instance_created_at: inspected.instance.created_at,
      credential_policy_sha256: config.digest,
      consistency: 'full-stop-sqlite-quick-check-and-asset-sha256',
      files: manifestFiles(data),
    };
    writeFileSync(join(temporary, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    verifyBackup(temporary);
    renameSync(temporary, output);
    return { ok: true, operation: 'backup', output, instance_id: manifest.instance_id, files: manifest.files.length };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    releaseLock();
  }
}

function rewriteDisasterDatabase(dbFile) {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const oldInstance = db.prepare('SELECT instance_id FROM instance WHERE singleton = 1').get()?.instance_id;
    if (typeof oldInstance !== 'string') fail('database instance identity is missing');
    const unknown = db.prepare("SELECT operation_id FROM operation WHERE status IN ('accepted','processing') ORDER BY acceptance_seq").all().map((row) => row.operation_id);
    const nextInstance = `inst_${randomBytes(16).toString('hex')}`;
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      db.prepare("UPDATE operation SET status = 'failed', lease_id = NULL, lease_expires_at = NULL, failure_code = 'storage_unavailable', completed_at = ? WHERE status IN ('accepted','processing')").run(at);
      db.prepare('UPDATE request_ledger SET instance_id = ? WHERE instance_id = ?').run(nextInstance, oldInstance);
      db.prepare('UPDATE withdraw_ledger SET instance_id = ? WHERE instance_id = ?').run(nextInstance, oldInstance);
      db.prepare('DELETE FROM history_cursor').run();
      db.prepare('DELETE FROM device_event').run();
      db.prepare('DELETE FROM device_binding_state').run();
      db.prepare('DELETE FROM device_history_cursor').run();
      db.prepare('DELETE FROM device_pairing').run();
      db.prepare('DELETE FROM device_binding').run();
      db.prepare("UPDATE device_channel SET epoch = ?, revision = revision + 1, offer_fingerprint = '', current_publication_id = NULL").run(`epoch_${randomBytes(16).toString('hex')}`);
      db.prepare('UPDATE instance SET instance_id = ? WHERE singleton = 1').run(nextInstance);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length !== 0) fail('disaster restore produced invalid foreign keys');
    return { oldInstance, nextInstance, unknown, at };
  } finally {
    db.close();
  }
}

function restore(values) {
  const backupDir = requirePath(values.backup, 'backup');
  const target = requirePath(values.target, 'target');
  const configFile = requirePath(values.config, 'config');
  const mode = values.mode;
  if (mode !== 'migrate' && mode !== 'disaster') fail('--mode must be migrate or disaster');
  if (target === backupDir || isInside(target, backupDir) || isInside(backupDir, target)) {
    fail('restore target and backup directory must be separate');
  }
  const verified = verifyBackup(backupDir);
  const config = readConfig(configFile);
  if (config.dataDir !== target) fail('configuration dataDir does not match --target');
  if (mode === 'migrate' && config.digest !== verified.manifest.credential_policy_sha256) fail('migration restore requires the original credential policy');
  if (mode === 'disaster' && config.digest === verified.manifest.credential_policy_sha256) fail('disaster restore requires a new credential policy');
  if (existsSync(target) && readdirSync(target).length !== 0) fail('restore target must not exist or must be empty');
  const temporary = join(dirname(target), `.${basename(target)}.restore-${randomUUID()}`);
  try {
    copyTree(verified.data, temporary);
    verifyDataFiles(temporary, verified.manifest);
    let instanceId = verified.manifest.instance_id;
    let restoredFrom = instanceId;
    let unknown = [];
    const at = new Date().toISOString();
    if (mode === 'disaster') {
      const changed = rewriteDisasterDatabase(join(temporary, 'ephemera.sqlite'));
      restoredFrom = changed.oldInstance;
      instanceId = changed.nextInstance;
      unknown = changed.unknown;
    }
    const policy = {
      schema_version: 1,
      mode,
      instance_id: instanceId,
      restored_from_instance_id: restoredFrom,
      restore_epoch: randomUUID(),
      credential_policy_sha256: config.digest,
      unknown_operation_ids: unknown,
      created_at: at,
    };
    writeFileSync(join(temporary, POLICY_FILE), `${JSON.stringify(policy, null, 2)}\n`);
    const inspected = inspectDatabase(join(temporary, 'ephemera.sqlite'));
    if (inspected.instance.instance_id !== instanceId) fail('restored database identity verification failed');
    verifyAssets(temporary, inspected.assets);
    if (existsSync(target)) rmSync(target);
    renameSync(temporary, target);
    return { ok: true, operation: 'restore', mode, target, instance_id: instanceId, restored_from_instance_id: restoredFrom, unknown_after_restore: unknown.length };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return [
    'Ephemera data administration (service must be stopped)',
    '  backup  --data-dir <dir> --config <config.json> --output <new-dir>',
    '  verify  --backup <dir>',
    '  restore --backup <dir> --target <new-or-empty-dir> --config <config.json> --mode migrate|disaster',
  ].join('\n');
}

try {
  const values = parse(process.argv.slice(2));
  let result;
  if (values.command === 'backup') result = backup(values);
  else if (values.command === 'verify') {
    const checked = verifyBackup(requirePath(values.backup, 'backup'));
    result = { ok: true, operation: 'verify', instance_id: checked.manifest.instance_id, files: checked.manifest.files.length };
  } else if (values.command === 'restore') result = restore(values);
  else {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = values.command ? 2 : 0;
  }
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'administration failed' })}\n`);
  process.exitCode = 1;
}
