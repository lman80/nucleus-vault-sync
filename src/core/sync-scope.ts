import {
  isConfigPath,
  isSafeSyncPath,
  mayWriteConfigPath,
  type ConfigSyncOptions,
} from "./config-paths";
import type { SyncRecord } from "./types";

/** Machine-owned or regenerable trees that are not part of the synced vault. */
export const EXCLUDED_PREFIXES = [
  ".obsidian",
  ".trash",
  ".smart-env",
  ".claude",
  ".claudian",
  ".git",
];

export function isExcludedVaultPath(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Whether this device currently owns a remote path.
 *
 * This is deliberately stricter than "the path is absent locally". A path
 * excluded by device policy must be ignored, not interpreted as a deletion.
 * Otherwise turning off config sync would tombstone every plugin and setting
 * already stored by another device.
 */
export function isManagedRemotePath(
  configDir: string,
  path: string,
  config: ConfigSyncOptions,
): boolean {
  if (!isSafeSyncPath(path)) return false;
  if (isConfigPath(configDir, path)) return mayWriteConfigPath(configDir, path, config);
  return !isExcludedVaultPath(path);
}

export interface RemoteScopeEntry {
  source_ref: string;
  kind: string;
  byte_size?: number | null;
  deleted_at?: string | null;
}

export interface DeviceSyncScope {
  config: ConfigSyncOptions;
  attachments: "all" | "under-limit" | "none";
  attachmentLimitBytes: number;
}

/** Whether absence of this remote row is allowed to mean deletion here. */
export function isManagedRemoteDocument(
  configDir: string,
  row: RemoteScopeEntry,
  scope: DeviceSyncScope,
): boolean {
  if (row.deleted_at || !isManagedRemotePath(configDir, row.source_ref, scope.config)) {
    return false;
  }
  // Binary files inside the config directory are plugins/themes, not optional
  // vault attachments, so the attachment policy must not hide them.
  if (row.kind !== "attachment" || isConfigPath(configDir, row.source_ref)) return true;
  if (scope.attachments === "none") return false;
  return !(
    scope.attachments === "under-limit" &&
    (row.byte_size ?? 0) > scope.attachmentLimitBytes
  );
}

/**
 * The proof required before absence on this device may delete a shared row.
 *
 * Merely appearing in the second listing of a two-way pass is not proof: it may
 * have been created by another device after this device's pull snapshot. The
 * local reconciliation record must show that this device previously held and
 * agreed with this exact remote hash.
 */
export function mayTombstoneRemoteDocument(
  configDir: string,
  row: RemoteScopeEntry & { content_hash?: string | null },
  record: SyncRecord | undefined,
  seenLocally: boolean,
  scope: DeviceSyncScope,
  deletionEnabled: boolean,
): boolean {
  if (!deletionEnabled || seenLocally) return false;
  if (!isManagedRemoteDocument(configDir, row, scope)) return false;
  if (!record || record.diskHash === null || record.layerHash === null) return false;
  return record.layerHash === (row.content_hash ?? null);
}

/** A failed pull makes the device's view incomplete, so deletion is unsafe. */
export function deletionsAllowedAfterPull(requested: boolean, failedCount: number): boolean {
  return requested && failedCount === 0;
}
