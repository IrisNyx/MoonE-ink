import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface InstallerSegment {
  readonly name: 'bootloader.bin' | 'partitions.bin' | 'firmware.bin';
  readonly address: number;
  readonly bytes: number;
  readonly sha256: string;
}

interface InstallerManifest {
  readonly schema_version: 1;
  readonly product: 'mooneink-t5-pro-lite';
  readonly chip: 'ESP32-S3';
  readonly release_id: string;
  readonly flash_mode: 'keep';
  readonly flash_frequency: 'keep';
  readonly flash_size: 'keep';
  readonly erase_all: true;
  readonly segments: readonly InstallerSegment[];
}

const INSTALLER_FILES = new Set(['bootloader.bin', 'partitions.bin', 'firmware.bin']);
const SHA256 = /^[0-9a-f]{64}$/;

function assetsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/device-installer');
}

function validManifest(value: unknown): value is InstallerManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record['schema_version'] !== 1 || record['product'] !== 'mooneink-t5-pro-lite' ||
      record['chip'] !== 'ESP32-S3' || record['flash_mode'] !== 'keep' ||
      record['flash_frequency'] !== 'keep' || record['flash_size'] !== 'keep' ||
      record['erase_all'] !== true || typeof record['release_id'] !== 'string' ||
      !Array.isArray(record['segments']) || record['segments'].length !== 3) return false;
  const expected = new Map([
    ['bootloader.bin', 0x0000],
    ['partitions.bin', 0x8000],
    ['firmware.bin', 0x10000],
  ]);
  return record['segments'].every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const segment = item as Record<string, unknown>;
    return typeof segment['name'] === 'string' && expected.get(segment['name']) === segment['address'] &&
      typeof segment['bytes'] === 'number' && Number.isInteger(segment['bytes']) && segment['bytes'] > 0 &&
      typeof segment['sha256'] === 'string' && SHA256.test(segment['sha256']);
  });
}

export class DeviceInstallerAssets {
  private readonly root = assetsRoot();
  private readonly manifest: InstallerManifest;

  constructor() {
    const parsed: unknown = JSON.parse(readFileSync(resolve(this.root, 'manifest.json'), 'utf8'));
    if (!validManifest(parsed)) throw new Error('device installer manifest is invalid');
    this.manifest = parsed;
    for (const segment of this.manifest.segments) this.readVerified(segment.name);
  }

  publicManifest(): Record<string, unknown> {
    return {
      ...this.manifest,
      segments: this.manifest.segments.map((segment) => ({
        ...segment,
        url: `/admin/v1/device-installer/files/${segment.name}`,
      })),
    };
  }

  readVerified(name: string): Buffer {
    if (!INSTALLER_FILES.has(name)) throw new Error('installer file is not allowed');
    const expected = this.manifest?.segments.find((segment) => segment.name === name);
    if (expected === undefined) throw new Error('installer file is absent from manifest');
    const content = readFileSync(resolve(this.root, name));
    if (content.length !== expected.bytes ||
        createHash('sha256').update(content).digest('hex') !== expected.sha256) {
      throw new Error('installer file failed integrity verification');
    }
    return content;
  }
}

export function esptoolBrowserBundle(): Buffer {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/esptool-js/bundle.js'));
}
