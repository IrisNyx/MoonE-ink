import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EphemeraConfig } from './config.js';
import { StorageSchemaError } from './storage/errors.js';

export const RESTORE_POLICY_FILE = 'restore-policy.json';

export interface RestorePolicy {
  schema_version: 1;
  mode: 'migrate' | 'disaster';
  instance_id: string;
  restored_from_instance_id: string;
  restore_epoch: string;
  credential_policy_sha256: string;
  unknown_operation_ids: string[];
  created_at: string;
}

export function credentialPolicySha256(config: EphemeraConfig): string {
  const credentials = config.auth.credentials
    .map((entry) => ({
      credential_id: entry.credential_id,
      caller_id: entry.caller_id,
      token_sha256: entry.token_sha256,
      revoked: entry.revoked,
    }))
    .sort((a, b) => a.credential_id.localeCompare(b.credential_id));
  const device = config.deviceChannel.enabled
    ? {
        enabled: true,
        owner_token_sha256: config.deviceChannel.owner_token_sha256,
        channel_id: config.deviceChannel.channel_id,
        publisher_caller_ids: [...config.deviceChannel.publisher_caller_ids].sort(),
      }
    : { enabled: false };
  return createHash('sha256').update(JSON.stringify({ credentials, device })).digest('hex');
}

export function readRestorePolicy(dataDir: string, instanceId: string): RestorePolicy | null {
  const file = join(dataDir, RESTORE_POLICY_FILE);
  if (!existsSync(file)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new StorageSchemaError('restore policy is unreadable');
  }
  const policy = value as Partial<RestorePolicy>;
  const valid =
    policy.schema_version === 1 &&
    (policy.mode === 'migrate' || policy.mode === 'disaster') &&
    policy.instance_id === instanceId &&
    typeof policy.restored_from_instance_id === 'string' &&
    typeof policy.restore_epoch === 'string' &&
    typeof policy.credential_policy_sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(policy.credential_policy_sha256) &&
    Array.isArray(policy.unknown_operation_ids) &&
    policy.unknown_operation_ids.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(policy.unknown_operation_ids).size === policy.unknown_operation_ids.length &&
    typeof policy.created_at === 'string';
  if (!valid) {
    throw new StorageSchemaError('restore policy is invalid or does not match the data instance');
  }
  return policy as RestorePolicy;
}

export function assertRestoreCredentials(policy: RestorePolicy | null, config: EphemeraConfig): void {
  if (policy === null) {
    return;
  }
  if (credentialPolicySha256(config) !== policy.credential_policy_sha256) {
    throw new StorageSchemaError('configured credentials do not match the restored data policy');
  }
}
