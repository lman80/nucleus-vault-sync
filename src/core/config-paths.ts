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

/**
 * Caches that rewrite themselves continuously.
 *
 * Excluded by default for one functional reason, not tidiness: a vector cache
 * that changes every time its plugin runs would keep the sync permanently busy
 * and never let it settle. Everything else in the config directory travels.
 */
const CACHE_DIRS = ["plugins/smart-connections/.smart-env", ".smart-env"];

export interface ConfigSyncOptions {
  /** Sync the config directory at all. */
  enabled: boolean;
  /** Include plugin caches that rewrite themselves constantly. */
  includeCaches: boolean;
}

/** A server-provided path must stay vault-relative after normalisation. */
export function isSafeSyncPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
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
  // The ONE file that cannot travel. Everything else in `.obsidian` does —
  // which plugins are enabled, every plugin's own settings, themes, snippets,
  // hotkeys, appearance, graph settings, and the workspace layout.
  //
  // This one is not a preference. It holds the API key AND this device's sync
  // record, and that record is *supposed* to differ per device: it is the only
  // thing that distinguishes "changed here" from "changed there". Copying it
  // between devices would break conflict detection on all of them at once.
  if (relative === OWN_DATA_FILE) return true;
  if (!options.includeCaches && CACHE_DIRS.some((d) => relative === d || relative.startsWith(`${d}/`))) {
    return true;
  }
  return false;
}

/** True when `path` is inside `configDir`. `.obsidian-backup` is NOT `.obsidian`. */
export function isConfigPath(configDir: string, path: string): boolean {
  return isSafeSyncPath(path) && (path === configDir || path.startsWith(`${configDir}/`));
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
  if (!isSafeSyncPath(path)) return false;
  if (!path.startsWith(`${configDir}/`)) return false;
  return !isExcludedConfigPath(path.slice(configDir.length + 1), options);
}
