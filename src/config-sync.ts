/**
 * config-sync — the `.obsidian` folder: plugins, themes, snippets, hotkeys.
 *
 * Without this, a new device gets your notes and none of your setup: no
 * plugins, no theme, no hotkeys. That is not what "sync my vault" means to
 * anyone, so this covers it.
 *
 * ## Why it needs its own file
 *
 * Obsidian's normal `vault.*` API deliberately cannot see hidden folders — its
 * own docs say so: *"files included in hidden folders can only be accessed
 * using the Adapter API."* `vault.getFiles()` will never list `.obsidian`, and
 * `vault.create()` will not write into it. Everything here therefore goes
 * through `vault.adapter`, which has no caching and no `TFile` bookkeeping, and
 * that difference is the whole reason this is separate from `engine.ts`.
 *
 * ## What is never synced, and why
 *
 * **This plugin's own `data.json`.** It holds two things that must not travel:
 * the API key, and the per-device sync record. The record is *supposed* to
 * differ between devices — it is what lets each one tell "changed here" from
 * "changed there" — so copying it between them would break conflict detection
 * on every device at once. Obsidian Sync carves out the same kind of exception.
 *
 * **Workspace layout** (`workspace.json`, `workspace-mobile.json`), unless
 * asked for. Which panes you have open on a Mac is not what you want on a
 * phone.
 */

import type { App } from "obsidian";
import { normalizePath } from "obsidian";

import {
  isExcludedConfigPath,
  isConfigPath as isConfigPathPure,
  mayWriteConfigPath as mayWriteConfigPathPure,
  OWN_DATA_FILE,
  type ConfigSyncOptions,
} from "./core/config-paths";

export { OWN_DATA_FILE, type ConfigSyncOptions };

/** True when a path belongs to this vault's config directory. */
export function isConfigPath(app: App, path: string): boolean {
  return isConfigPathPure(app.vault.configDir, path);
}

/** May this config path be written here? See core/config-paths.ts. */
export function mayWriteConfigPath(app: App, path: string, options: ConfigSyncOptions): boolean {
  return mayWriteConfigPathPure(app.vault.configDir, path, options);
}

/** Our own settings file — never shared between devices. See above. */




/** The vault-relative path of the config directory — usually `.obsidian`. */
export function configDir(app: App): string {
  return app.vault.configDir;
}


/**
 * Every file under the config directory, as vault-relative paths.
 *
 * Walks with `adapter.list`, which is the only thing that can see in here.
 * A directory that cannot be read aborts this pass. Silently skipping it would
 * make the push side interpret every file below it as deleted and tombstone a
 * perfectly good remote plugin. The next automatic pass will retry.
 */
export async function listConfigFiles(app: App, options: ConfigSyncOptions): Promise<string[]> {
  if (!options.enabled) return [];
  const root = configDir(app);
  const out: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await app.vault.adapter.list(normalizePath(dir));
    } catch (error) {
      throw new Error(
        `could not list ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const file of listing.files) {
      const relative = file.slice(root.length + 1);
      if (isExcludedConfigPath(relative, options)) continue;
      out.push(file);
    }
    for (const folder of listing.folders) {
      const relative = folder.slice(root.length + 1);
      if (isExcludedConfigPath(relative, options)) continue;
      await walk(folder);
    }
  };

  await walk(root);
  return out.sort();
}

export interface ConfigFile {
  path: string;
  size: number;
  mtime: number;
  binary: boolean;
}

/** Stat one config file. Returns null if it has gone. */
export async function statConfigFile(app: App, path: string): Promise<ConfigFile | null> {
  try {
    const stat = await app.vault.adapter.stat(normalizePath(path));
    if (!stat || stat.type !== "file") return null;
    return {
      path,
      size: stat.size,
      mtime: stat.mtime,
      // Treat the text formats Obsidian's own config uses as text; everything
      // else (fonts, images in themes) as bytes.
      binary: !/\.(json|css|md|txt|js|map)$/i.test(path),
    };
  } catch {
    return null;
  }
}

export async function readConfigText(app: App, path: string): Promise<string> {
  return app.vault.adapter.read(normalizePath(path));
}

export async function readConfigBinary(app: App, path: string): Promise<ArrayBuffer> {
  return app.vault.adapter.readBinary(normalizePath(path));
}

/** Create every folder on the way to `path`. `adapter.mkdir` is not recursive. */
export async function ensureConfigFolders(app: App, path: string): Promise<void> {
  const parts = path.split("/");
  parts.pop();
  let sofar = "";
  for (const part of parts) {
    sofar = sofar ? `${sofar}/${part}` : part;
    if (!(await app.vault.adapter.exists(normalizePath(sofar)))) {
      await app.vault.adapter.mkdir(normalizePath(sofar));
    }
  }
}

export async function writeConfigText(
  app: App,
  path: string,
  text: string,
  times?: { ctime?: number; mtime?: number },
): Promise<void> {
  await ensureConfigFolders(app, path);
  await app.vault.adapter.write(normalizePath(path), text, times);
}

export async function writeConfigBinary(
  app: App,
  path: string,
  bytes: ArrayBuffer,
  times?: { ctime?: number; mtime?: number },
): Promise<void> {
  await ensureConfigFolders(app, path);
  await app.vault.adapter.writeBinary(normalizePath(path), bytes, times);
}

export async function removeConfigFile(app: App, path: string): Promise<void> {
  try {
    await app.vault.adapter.remove(normalizePath(path));
  } catch {
    // Already gone is the outcome we wanted.
  }
}
