/**
 * Which files inside Obsidian's config directory may be synced.
 *
 * Pure string logic, deliberately in `core/` with no Obsidian import: these
 * rules decide whether an API key and a device's private sync record leave the
 * machine, so they must be testable without the app. (They were not, at first —
 * the test could not even load the module, because `obsidian` is a types-only
 * package with nothing to import at runtime.)
 */

/** This plugin's own settings file, relative to the config directory. */
export const OWN_DATA_FILE = "plugins/nucleus-vault-sync/data.json";

/** Which panes are open. Per-device by nature. */
const WORKSPACE_FILES = ["workspace.json", "workspace-mobile.json"];

/** Caches a plugin rebuilds by itself — large, machine-specific, pointless to move. */
const CACHE_DIRS = ["plugins/smart-connections/.smart-env", ".smart-env"];

export interface ConfigSyncOptions {
  /** Sync the config directory at all. */
  enabled: boolean;
  /** Include the per-device window layout. */
  includeWorkspace: boolean;
}

/**
 * `relative` is the path WITHIN the config directory.
 *
 * `data.json` for this plugin is the one that matters: it holds the API key and
 * this device's sync record. The record is supposed to differ per device — it
 * is what distinguishes "changed here" from "changed there" — so sharing it
 * would break conflict detection on every device at once.
 */
export function isExcludedConfigPath(relative: string, options: ConfigSyncOptions): boolean {
  if (relative === OWN_DATA_FILE) return true;
  if (!options.includeWorkspace && WORKSPACE_FILES.includes(relative)) return true;
  if (CACHE_DIRS.some((d) => relative === d || relative.startsWith(`${d}/`))) return true;
  return false;
}

/** True when `path` is inside `configDir`. `.obsidian-backup` is NOT `.obsidian`. */
export function isConfigPath(configDir: string, path: string): boolean {
  return path === configDir || path.startsWith(`${configDir}/`);
}

/**
 * May this path be written to disk?
 *
 * Checked on the way DOWN as well as up: rows written by an older build, before
 * these rules existed, are still in the layer and would otherwise deliver
 * another device's key straight into this vault.
 */
export function mayWriteConfigPath(
  configDir: string,
  path: string,
  options: ConfigSyncOptions,
): boolean {
  if (!options.enabled) return false;
  if (!path.startsWith(`${configDir}/`)) return false;
  return !isExcludedConfigPath(path.slice(configDir.length + 1), options);
}
