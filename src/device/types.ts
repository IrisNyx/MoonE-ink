export const DEVICE_PROTOCOL_VERSION = 1 as const;
export const PORTRAIT_PROFILE = 'epaper-540x960-gray4-v1' as const;
export const LANDSCAPE_PROFILE = 'epaper-960x540-gray4-v1' as const;

export interface ProtocolLimits {
  max_pages_per_edition: number;
  max_pages_response_bytes: number;
  max_history_response_bytes: number;
  max_actions_per_frame: number;
  max_string_bytes: number;
  max_json_depth: number;
  max_event_body_bytes: number;
  max_history_items: number;
  request_timeout_ms: number;
  asset_download_timeout_ms: number;
}

export interface DeviceBindingRecord {
  binding_id: string;
  device_id: string;
  channel_id: string;
  instance_id: string;
  epoch: string;
  protocol_version: 1;
  profiles: string[];
  limits: ProtocolLimits;
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
}

export interface PairingRecord {
  code_digest: string;
  pairing_id: string;
  channel_id: string;
  allowed_profiles: string[];
  created_at: string;
  expires_at: string;
  max_attempts: number;
  failed_attempts: number;
  consumed_at: string | null;
  request_id: string | null;
  request_digest: string | null;
  binding_id: string | null;
}

export interface DeviceFrameRecord {
  publication_id: string;
  acceptance_seq: number;
  accepted_at: string;
  committed_at: string;
  expires_at: string | null;
  withdrawn_at: string | null;
  delivery_id: string;
  edition_id: string;
  profile: string;
  page_id: string;
  part_id: string;
  page_index: number;
  page_count: number;
  width: number;
  height: number;
  sha256: string;
  byte_length: number;
  relative_path: string;
}

export interface DeviceHistoryRecord {
  publication_id: string;
  acceptance_seq: number;
  accepted_at: string;
  committed_at: string;
  expires_at: string | null;
  withdrawn_at: string | null;
  delivery_id: string;
  edition_id: string;
  profile: string;
  page_count: number;
  genre: string;
  canonical_blob: Uint8Array;
  unread: number;
}

export type DeviceHistoryFilter = 'legacy' | 'recent' | 'unread';

export interface DeviceLibraryState {
  revision: number;
  unread_count: number;
  selected_unread: boolean | null;
}

export interface AdminDeviceBindingView {
  binding_id: string;
  device_id: string;
  channel_id: string;
  profiles: string[];
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
  last_seq: number | null;
  last_reported_at: string | null;
  power: AdminDevicePowerView | null;
}

export interface AdminDevicePowerView {
  source: 'external' | 'battery' | 'unknown';
  battery_percent: number | null;
  battery_mv: number | null;
  mode: 'external_online' | 'active' | 'battery_idle' | 'retry_backoff' | 'low_battery';
  current_ma?: number;
  average_current_ma?: number;
  remaining_mah?: number;
  full_mah?: number;
  light_sleep_seconds?: number;
  uptime_seconds?: number;
}

export interface AdminDeviceEventView {
  binding_id: string;
  device_id: string;
  seq: number;
  kind: 'cached' | 'presented' | 'acknowledged' | 'status' | 'interaction';
  publication_id: string | null;
  page_id: string | null;
  received_at: string;
}

export interface DeviceChannelRepository {
  configureChannel(input: {
    channelId: string;
    publisherCallerIds: readonly string[];
    nowIso: string;
    epochSource: () => string;
  }): { channel_id: string; epoch: string };
  createPairing(input: {
    pairingId: string;
    codeDigest: string;
    channelId: string;
    allowedProfiles: readonly string[];
    createdAt: string;
    expiresAt: string;
    maxAttempts: number;
  }): void;
  pairingByDigest(codeDigest: string): PairingRecord | null;
  consumePairing(input: {
    codeDigest: string;
    requestId: string;
    requestDigest: string;
    bindingId: string;
    deviceId: string;
    secretSha256: string;
    profiles: readonly string[];
    limits: ProtocolLimits;
    nowIso: string;
  }): { binding: DeviceBindingRecord; duplicate: boolean };
  notePairingFailure(codeDigest: string): void;
  bindingBySecretDigest(secretDigest: string): DeviceBindingRecord | null;
  bindingById(bindingId: string): DeviceBindingRecord | null;
  adminBindings(): AdminDeviceBindingView[];
  adminRecentEvents(limit: number): AdminDeviceEventView[];
  revokeBinding(bindingId: string, nowIso: string): boolean;
  currentScreen(binding: DeviceBindingRecord, nowIso: string): {
    epoch: string;
    revision: number;
    frame: DeviceFrameRecord | null;
  };
  libraryState(channelId: string, selectedPublicationId: string | null): DeviceLibraryState;
  historyHighWater(channelId: string): number;
  historyPage(channelId: string, highWater: number, beforeSeq: number | null, limit: number, filter: DeviceHistoryFilter): DeviceHistoryRecord[];
  historyCursor(bindingId: string, cursorDigest: string): {
    snapshot_high_water: number;
    last_acceptance_seq: number;
    page_size: number;
    filter: DeviceHistoryFilter;
    library_revision: number;
    remaining_items: number | null;
    expires_at: string;
  } | null;
  insertHistoryCursor(input: {
    bindingId: string;
    cursorDigest: string;
    snapshotHighWater: number;
    lastAcceptanceSeq: number;
    pageSize: number;
    filter: DeviceHistoryFilter;
    libraryRevision: number;
    remainingItems: number | null;
    createdAt: string;
    expiresAt: string;
  }): void;
  pages(binding: DeviceBindingRecord, publicationId: string, profile: string, editionId: string | null): DeviceFrameRecord[];
  authorizedAsset(binding: DeviceBindingRecord, sha256: string): { relative_path: string; byte_length: number } | null;
  acceptEvent(input: {
    binding: DeviceBindingRecord;
    eventId: string;
    seq: number;
    kind: string;
    payloadDigest: string;
    payloadJson: string;
    publicationId: string | null;
    pageId: string | null;
    frameId: string | null;
    deliveryId: string | null;
    stateJson: string;
    receivedAt: string;
  }): { status: 'accepted' | 'duplicate'; received_at: string };
  subjectFrame(binding: DeviceBindingRecord, publicationId: string, pageId: string): DeviceFrameRecord | null;
}
