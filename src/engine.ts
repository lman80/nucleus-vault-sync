/**
 * engine — one sync pass, in both directions, against a real Obsidian vault.
 *
 * The decision logic lives in `core/decide.ts` and is shared with the Mac
 * connector; this file is the part that knows about Obsidian: how to list
 * files, read bytes, create a folder that does not exist yet, and delete
 * something without losing it.
 *
 * ## Per-device state, deliberately
 *
 * Telling "changed here" from "changed there" needs a third fact: what the two
 * sides looked like when they last agreed. That record is per-device — your
 * phone and your Mac legitimately last agreed at different moments — so it
 * lives in the plugin's own `data.json`, which this plugin never syncs.
 * Sharing it between devices would be a bug, not a feature.
 *
 * ## What it will not do
 *
 * It never overwrites a file you changed. If a note moved on both sides since
 * they last agreed, the layer's version is written beside yours as a conflict
 * copy and yours is left alone. That rule is in `decide()`, it has tests, and
 * nothing in this file may work around it.
 */

import type { App, TFile, TFolder } from "obsidian";
import { normalizePath, TFile as TFileClass, TFolder as TFolderClass } from "obsidian";

import { decide, renderNote, conflictName } from "./core/decide";
import { splitFrontmatter, extractTags, extractLinks, titleFor, mimeFor, sha256, uuidV5 } from "./core/parse";
import type { DocumentRow, SyncRecord, SyncState } from "./core/types";
import type { NucleusClient } from "./client";
import {
  isExcludedVaultPath,
  isManagedRemoteDocument,
  isManagedRemotePath,
} from "./core/sync-scope";
import {
  listConfigFiles,
  statConfigFile,
  readConfigText,
  readConfigBinary,
  writeConfigText,
  writeConfigBinary,
  removeConfigFile,
  mayWriteConfigPath,
  isConfigPath,
  type ConfigSyncOptions,
} from "./config-sync";

export interface EngineOptions {
  app: App;
  client: NucleusClient;
  vaultName: string;
  state: SyncState;
  /** Persist the sync record. Called periodically, not only at the end. */
  saveState: (state: SyncState) => Promise<void>;
  log?: (line: string) => void;
  /** Report progress for long passes; `done`/`total` are file counts. */
  onProgress?: (done: number, total: number, what: string) => void;
  /** Which attachments this device wants downloaded. Notes always come down. */
  attachments?: "all" | "under-limit" | "none";
  attachmentLimitBytes?: number;
  /** Whether to carry `.obsidian` — plugins, themes, hotkeys — as well. */
  config?: ConfigSyncOptions;
  /**
   * Restrict this pass to part of the vault.
   *
   * "text" is everything that makes the vault usable — notes, plugins,
   * settings — and weighs a few megabytes. "attachments" is the rest, which for
   * a vault with video in it is nearly all the bytes and none of the urgency.
   * Splitting them is what lets setup hand the vault over in seconds and finish
   * the heavy half afterwards.
   */
  only?: "text" | "attachments";
  /** False for setup modes where remote-only files must be preserved. */
  deleteRemoteMissing?: boolean;
}

export interface PassResult {
  uploaded: number;
  downloaded: number;
  deletedLocally: number;
  tombstoned: number;
  unchanged: number;
  /** Deliberately not fetched — e.g. an attachment above this device's limit. */
  skipped: number;
  /** Files still to come, and their weight, after this pass. */
  outstanding: number;
  outstandingBytes: number;
  conflicts: { path: string; savedAs: string }[];
  failed: { path: string; reason: string }[];
}

const emptyResult = (): PassResult => ({
  uploaded: 0,
  downloaded: 0,
  deletedLocally: 0,
  tombstoned: 0,
  unchanged: 0,
  skipped: 0,
  outstanding: 0,
  outstandingBytes: 0,
  conflicts: [],
  failed: [],
});

export function isExcluded(path: string): boolean {
  return isExcludedVaultPath(path);
}

/** Bytes as a short human string, for progress lines. */
function mb(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * Every file the plugin considers part of the vault.
 *
 * `vault.getFiles()` already omits dot-folders, but the filter stays: a
 * customised config directory, or a future Obsidian that reports more, must not
 * silently start syncing the user's plugin settings.
 */
export function vaultFiles(app: App): TFile[] {
  return app.vault.getFiles().filter((f) => !isExcluded(f.path));
}

/**
 * Make sure every folder on the way to `path` exists.
 *
 * `vault.create()` does NOT create missing parents, and `createFolder()`
 * throws if the folder is already there — so this walks the path a level at a
 * time and asks first. Getting this wrong shows up as "cannot create file"
 * on exactly the notes that live in new folders, which is most of a restore.
 */
async function ensureParentFolders(app: App, path: string): Promise<void> {
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

/** Preserve a locally changed config file somewhere Obsidian will not load it. */
async function backUpConfigConflict(
  app: App,
  path: string,
  info: NonNullable<Awaited<ReturnType<typeof statConfigFile>>>,
): Promise<string> {
  const relative = path.startsWith(`${app.vault.configDir}/`)
    ? path.slice(app.vault.configDir.length + 1)
    : path;
  const named = conflictName(relative, new Date().toISOString());
  const target = normalizePath(`Nucleus Config Conflicts/${named}`);
  await ensureParentFolders(app, target);
  if (info.binary) {
    await app.vault.createBinary(target, await readConfigBinary(app, path));
  } else {
    await app.vault.create(target, await readConfigText(app, path));
  }
  return target;
}

/** Read one vault file as the row the layer expects. Bytes are NOT included. */
export async function describeFile(
  app: App,
  file: TFile,
  vaultName: string,
): Promise<Partial<DocumentRow> & { _bytes?: ArrayBuffer }> {
  const common = {
    id: uuidV5(`${vaultName}\n${file.path}`),
    vault: vaultName,
    source_ref: file.path,
    source_app: "obsidian",
    byte_size: file.stat.size,
    file_created_at: new Date(file.stat.ctime).toISOString(),
    file_modified_at: new Date(file.stat.mtime).toISOString(),
    deleted_at: null,
  };

  if (isMarkdown(file.path)) {
    const raw = await app.vault.read(file);
    const { frontmatter, body } = splitFrontmatter(raw);
    return {
      ...common,
      kind: "note",
      title: titleFor(file.path, frontmatter),
      raw,
      body,
      frontmatter,
      tags: extractTags(frontmatter, body),
      links: extractLinks(frontmatter, body),
      content_hash: await sha256(raw),
      storage_path: null,
      mime_type: null,
    };
  }

  const bytes = await app.vault.readBinary(file);
  const hash = await sha256(bytes);
  return {
    ...common,
    kind: "attachment",
    title: file.name,
    raw: null,
    body: null,
    frontmatter: null,
    tags: [],
    links: [],
    content_hash: hash,
    // Content-addressed, matching the Mac connector exactly: the same bytes
    // are stored once and a moved file needs no re-upload.
    storage_path: `${vaultName}/${hash}`,
    mime_type: mimeFor(file.path),
    _bytes: bytes,
  };
}


/**
 * Move everything currently in the vault into one folder, so the layer's copy
 * can arrive on a clean floor.
 *
 * This is the default answer when both sides have files and they have never
 * synced. Interleaving two histories and sprinkling "(conflict)" copies through
 * the tree is technically safe and practically horrible — you end up with a
 * vault you have to untangle note by note. Setting the old contents aside keeps
 * every byte, keeps the folder structure, and leaves the result obvious: your
 * notes are in one place, the ones from your Nucleus are where they belong.
 *
 * Uses `vault.rename`, NOT `fileManager.renameFile`.
 *
 * `renameFile` rewrites links that point at the moved file — which sounds
 * right, and in bulk is a disaster: Obsidian raises its "update internal links?"
 * dialog once per file, so setting aside a few hundred notes means a few hundred
 * prompts. Reported from a real run.
 *
 * It is also unnecessary here. Obsidian resolves `[[wikilinks]]` by note name
 * across the whole vault, not by path, so moving every file together into one
 * folder leaves those links resolving exactly as before, with nothing rewritten
 * and nothing to confirm.
 */
export async function setAside(
  app: App,
  folderName: string,
  log: (line: string) => void = () => {},
): Promise<{ moved: number; failed: { path: string; reason: string }[] }> {
  const files = vaultFiles(app);
  const failed: { path: string; reason: string }[] = [];
  let moved = 0;

  if (files.length === 0) return { moved, failed };

  for (const file of files) {
    // Do not move things into themselves on a second run.
    if (file.path.startsWith(`${folderName}/`)) continue;
    const target = normalizePath(`${folderName}/${file.path}`);
    try {
      await ensureParentFolders(app, target);
      await app.vault.rename(file, target);
      moved += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not move ${file.path}: ${reason}`);
      failed.push({ path: file.path, reason });
    }
  }
  // Everything moved out of the old tree; do not leave its skeleton standing.
  await removeEmptyFolders(app, log);
  return { moved, failed };
}


/**
 * Check that what arrived is what was asked for, before it touches the vault.
 *
 * An interrupted download leaves a truncated file, and a truncated file has no
 * sync record — so the next pass sees "the layer changed AND the disk changed"
 * and dutifully makes a conflict copy of a corrupt file. The user stops a sync
 * on their phone once and ends up with junk twins through their vault.
 *
 * Verifying here turns that into a clean retry: bad bytes are never written, so
 * the file simply is not there next time and gets fetched again.
 */
async function verifiedBytes(
  bytes: ArrayBuffer,
  expectedHash: string | null | undefined,
  path: string,
): Promise<ArrayBuffer> {
  if (!expectedHash) return bytes;
  const actual = await sha256(bytes);
  if (actual !== expectedHash) {
    throw new Error(
      `incomplete download for ${path} (got ${bytes.byteLength} bytes, checksum did not match) — ` +
        `it will be fetched again on the next sync`,
    );
  }
  return bytes;
}


/**
 * Empty the vault, so the layer's copy can be the only copy.
 *
 * The "I do not care about what is here, just give me my vault" answer, which
 * had no button at all in the first version — leaving someone whose sync was
 * interrupted with no way to simply start over.
 *
 * Files go to Obsidian's trash rather than being destroyed: this is the most
 * destructive choice on offer, so it should still be the one that can be undone.
 */
export async function replaceLocal(
  app: App,
  log: (line: string) => void = () => {},
): Promise<{ removed: number; failed: { path: string; reason: string }[] }> {
  const failed: { path: string; reason: string }[] = [];
  let removed = 0;
  for (const file of vaultFiles(app)) {
    try {
      await app.fileManager.trashFile(file);
      removed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not remove ${file.path}: ${reason}`);
      failed.push({ path: file.path, reason });
    }
  }
  // The files are gone; the folders they lived in should go too.
  await removeEmptyFolders(app, log);
  return { removed, failed };
}


/**
 * Remove folders that no longer hold anything.
 *
 * Obsidian's file list contains files, not folders, so removing every file
 * leaves the whole directory tree standing — empty. After "start clean" that
 * means a vault that reports zero notes and still shows every folder you were
 * trying to get rid of, which reads as a half-done job because it is one.
 *
 * Deepest first, so a folder whose only contents were other empty folders is
 * itself emptied before it is judged. Repeats until a pass removes nothing,
 * which is cheaper than reasoning about depth and impossible to get wrong.
 */
export async function removeEmptyFolders(
  app: App,
  log: (line: string) => void = () => {},
): Promise<number> {
  let removedTotal = 0;

  for (;;) {
    const empties: TFolder[] = [];
    const walk = (folder: TFolder): void => {
      for (const child of folder.children) {
        if (child instanceof TFolderClass) walk(child);
      }
      // Never the vault root, and never anything excluded — the config folder
      // is not ours to tidy.
      if (folder.path === "/" || folder.path === "") return;
      if (isExcluded(folder.path)) return;
      if (folder.children.length === 0) empties.push(folder);
    };
    walk(app.vault.getRoot());

    if (empties.length === 0) break;

    let removedThisPass = 0;
    // Deepest first: removing a child can make its parent empty.
    for (const folder of empties.sort((a, b) => b.path.length - a.path.length)) {
      try {
        await app.fileManager.trashFile(folder);
        removedThisPass += 1;
      } catch (error) {
        log(`could not remove empty folder ${folder.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (removedThisPass === 0) break;
    removedTotal += removedThisPass;
  }

  return removedTotal;
}


/**
 * The original timestamps for a row, as Obsidian wants them.
 *
 * `create` and `modify` both accept `{ ctime, mtime }` and I never passed them,
 * so every downloaded note took the moment it arrived as its creation date.
 * For anyone who sorts by "created" — which is most people, and is how this
 * vault is organised — that silently destroys the ordering of the whole vault
 * while leaving every note's contents perfect. The data was right and the shelf
 * it sat on was wrong.
 */
function timesFor(row: DocumentRow): { ctime?: number; mtime?: number } {
  const created = row.file_created_at ? Date.parse(row.file_created_at) : NaN;
  const modified = row.file_modified_at ? Date.parse(row.file_modified_at) : NaN;
  const out: { ctime?: number; mtime?: number } = {};
  if (Number.isFinite(created)) out.ctime = created;
  if (Number.isFinite(modified)) out.mtime = modified;
  return out;
}

/**
 * Return the recorded disk hash without reopening the file when its cheap
 * metadata proves that it is still the same file we recorded.
 */
function unchangedRecordedHash(
  record: SyncRecord | undefined,
  size: number,
  mtime: number,
): string | null | undefined {
  if (!record || record.size !== size || record.mtime !== mtime) return undefined;
  return record.diskHash;
}

/**
 * Push: make the layer match the vault.
 *
 * Refuses to tombstone more than half of a vault of 20+ files — an Obsidian
 * that has not finished indexing, or a vault opened before its files are
 * present, must never read as "the user deleted everything".
 */
export async function push(options: EngineOptions): Promise<PassResult> {
  const { app, client, vaultName, state, log = () => {}, onProgress = () => {} } = options;
  const result = emptyResult();

  const files = vaultFiles(app);
  const configOpts = options.config ?? { enabled: false, includeCaches: false };
  onProgress(0, 1, "checking what has changed here…");
  const configPaths = await listConfigFiles(app, configOpts);
  const remote = await client.listDocumentsSlim();
  const remoteByPath = new Map(remote.filter((r) => !r.deleted_at).map((r) => [r.source_ref, r]));

  const seen = new Set<string>();
  let done = 0;

  const total = files.length + configPaths.length;
  for (const file of files) {
    done += 1;
    onProgress(done, total, file.path);
    seen.add(file.path);

    try {
      const existing = remoteByPath.get(file.path);

      // Cheap check first. If the file is the same size and has the same
      // modified time as when we last agreed, and the layer still holds the
      // hash we recorded, nothing can have changed — so do not open it.
      //
      // Without this, every pass read and hashed the entire vault. On a 1.4 GB
      // vault that is minutes of disk per sync, on a phone it is worse, and it
      // happens even when the answer is "nothing to do".
      const record = state[file.path];
      if (
        existing &&
        record &&
        record.size === file.stat.size &&
        record.mtime === file.stat.mtime &&
        record.layerHash === existing.content_hash
      ) {
        result.unchanged += 1;
        continue;
      }

      const row = await describeFile(app, file, vaultName);

      if (existing && existing.content_hash === row.content_hash) {
        result.unchanged += 1;
        state[file.path] = {
          layerHash: row.content_hash ?? null,
          diskHash: row.content_hash ?? null,
          size: file.stat.size,
          mtime: file.stat.mtime,
          at: new Date().toISOString(),
        };
        continue;
      }

      const bytes = row._bytes;
      delete row._bytes;

      // Bytes before the row that points at them: a row whose storage_path
      // leads nowhere is worse than a file the layer does not know about yet.
      if (bytes && row.storage_path) {
        await client.putObject(row.storage_path, bytes, row.mime_type ?? "application/octet-stream");
      }

      await client.upsertDocuments([{ ...row, id: existing?.id ?? row.id }]);
      result.uploaded += 1;
      state[file.path] = {
        layerHash: row.content_hash ?? null,
        diskHash: row.content_hash ?? null,
        size: file.stat.size,
        mtime: file.stat.mtime,
        at: new Date().toISOString(),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not upload ${file.path}: ${reason}`);
      result.failed.push({ path: file.path, reason });
    }
  }

  // The config directory — plugins, themes, hotkeys. Separate loop because
  // these are invisible to the vault API and have to go through the adapter.
  for (const path of configPaths) {
    done += 1;
    onProgress(done, total, path);
    seen.add(path);
    try {
      const info = await statConfigFile(app, path);
      if (!info) continue;

      const existing = remoteByPath.get(path);
      const record = state[path];
      if (
        existing &&
        record &&
        record.size === info.size &&
        record.mtime === info.mtime &&
        record.layerHash === existing.content_hash
      ) {
        result.unchanged += 1;
        continue;
      }

      const bytes = info.binary ? await readConfigBinary(app, path) : null;
      const text = info.binary ? null : await readConfigText(app, path);
      const hash = await sha256(info.binary ? bytes! : text!);

      if (existing && existing.content_hash === hash) {
        result.unchanged += 1;
        state[path] = { layerHash: hash, diskHash: hash, size: info.size, mtime: info.mtime, at: new Date().toISOString() };
        continue;
      }

      const id = existing?.id ?? uuidV5(`${vaultName}\n${path}`);
      const row: Partial<DocumentRow> = {
        id,
        vault: vaultName,
        source_ref: path,
        source_app: "obsidian",
        // Config files ride as attachments: bytes in the file store, not text
        // inline. A theme's font is not a note and should not sit in a column.
        kind: info.binary ? "attachment" : "note",
        title: path.split("/").pop() ?? path,
        raw: text,
        body: text,
        frontmatter: null,
        tags: [],
        links: [],
        content_hash: hash,
        byte_size: info.size,
        storage_path: info.binary ? `${vaultName}/${hash}` : null,
        mime_type: info.binary ? mimeFor(path) : null,
        file_modified_at: new Date(info.mtime).toISOString(),
        deleted_at: null,
      };

      if (info.binary && bytes && row.storage_path) {
        await client.putObject(row.storage_path, bytes, row.mime_type ?? "application/octet-stream");
      }
      await client.upsertDocuments([row]);
      result.uploaded += 1;
      state[path] = { layerHash: hash, diskHash: hash, size: info.size, mtime: info.mtime, at: new Date().toISOString() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not upload ${path}: ${reason}`);
      result.failed.push({ path, reason });
    }
  }

  // Anything the layer still calls live but the vault no longer has.
  // An ignored path is outside this device's policy, not deleted. In
  // particular, turning config sync off must never erase the server's copy of
  // every plugin and preference because `listConfigFiles` returned none.
  const managedRemote = remote.filter((row) =>
    isManagedRemoteDocument(app.vault.configDir, row, {
      config: configOpts,
      attachments: options.attachments ?? "all",
      attachmentLimitBytes: options.attachmentLimitBytes ?? Number.POSITIVE_INFINITY,
    }),
  );
  const gone =
    options.deleteRemoteMissing === false
      ? []
      : managedRemote.filter((row) => !seen.has(row.source_ref));
  const liveCount = managedRemote.length;
  if (liveCount >= 20 && gone.length / liveCount > 0.5) {
    log(
      `Refusing to delete ${gone.length} of ${liveCount} files — the vault only read as ` +
        `${files.length} files. That usually means Obsidian has not finished loading, not that ` +
        `you deleted everything.`,
    );
    await options.saveState(state);
    return result;
  }

  const now = new Date().toISOString();
  for (const row of gone) {
    try {
      await client.patchDocument(row.id, { deleted_at: now });
      result.tombstoned += 1;
      delete state[row.source_ref];
    } catch (error) {
      result.failed.push({
        path: row.source_ref,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await options.saveState(state);
  return result;
}

/**
 * Pull: make the vault match the layer.
 *
 * This is the direction an agent's writes arrive through, and the one that can
 * destroy work, so every decision goes through the shared `decide()` table.
 */
export async function pull(options: EngineOptions): Promise<PassResult> {
  const { app, client, state, log = () => {}, onProgress = () => {} } = options;
  const result = emptyResult();

  // The list itself takes several seconds on a large vault; without this the
  // status bar sat on "syncing" with nothing to show for it.
  onProgress(0, 1, "checking what is on the server…");
  // Metadata only — see client.listDocumentsMeta for why this matters. Bodies
  // are fetched below, for the short list that is actually going to be written.
  const fetched = await client.listDocumentsMeta();
  const configOpts = options.config ?? { enabled: false, includeCaches: false };

  // Two phases: everything that makes the vault WORK, then the heavy files.
  //
  // iOS suspends Obsidian the moment the screen locks, so a phone gets sync in
  // short bursts rather than one long run. In path order a single 169 MB video
  // sits at the front of a burst and blocks every note behind it — measured on
  // a real phone: 40 MB of 1,466 MB across several sessions, with barely a note
  // to show for it.
  //
  // So notes and settings go first — all 447 notes are 2.6 MB between them and
  // land in seconds — and the vault is fully usable before a single video is
  // touched. Attachments follow smallest-first, and a note whose image has not
  // arrived yet still opens fine.
  const isHeavy = (r: DocumentRow) => r.kind === "attachment";
  const only = options.only;
  const wanted = fetched.filter(
    (row) =>
      isManagedRemotePath(app.vault.configDir, row.source_ref, configOpts) &&
      (only === "text" ? !isHeavy(row) : only === "attachments" ? isHeavy(row) : true),
  );
  const rows = [
    ...wanted.filter((r) => !isHeavy(r)).sort((a, b) => (a.byte_size ?? 0) - (b.byte_size ?? 0)),
    ...wanted.filter(isHeavy).sort((a, b) => (a.byte_size ?? 0) - (b.byte_size ?? 0)),
  ];
  const noteCount = wanted.filter((r) => !isHeavy(r)).length;

  // A notes-first restore deliberately leaves the heavy half for the next
  // pass. Report that work as outstanding instead of claiming the vault is
  // already complete. A cheap saved-state check avoids counting attachments
  // that this device already has byte-for-byte.
  if (only === "text") {
    for (const row of fetched) {
      if (
        row.deleted_at ||
        !isHeavy(row) ||
        !isManagedRemotePath(app.vault.configDir, row.source_ref, configOpts)
      ) {
        continue;
      }
      if (isConfigPath(app, row.source_ref)) {
        const info = await statConfigFile(app, row.source_ref);
        const known = info
          ? unchangedRecordedHash(state[row.source_ref], info.size, info.mtime)
          : undefined;
        if (known === row.content_hash) continue;
      } else {
        const existing = app.vault.getAbstractFileByPath(normalizePath(row.source_ref));
        const file = existing instanceof TFileClass ? existing : null;
        const known = file
          ? unchangedRecordedHash(state[row.source_ref], file.stat.size, file.stat.mtime)
          : undefined;
        if (known === row.content_hash) continue;
      }
      result.outstanding += 1;
      result.outstandingBytes += row.byte_size ?? 0;
    }
  }
  // Work out the short list before fetching any text: only notes whose content
  // differs from what is on disk need their body at all, and on a settled vault
  // that is almost none of them.
  onProgress(0, 1, "working out what changed…");
  const needsBody: { id: string; size: number }[] = [];
  for (const row of rows) {
    if (row.deleted_at || row.kind === "attachment") continue;
    const path = normalizePath(row.source_ref);
    const existing = app.vault.getAbstractFileByPath(path);
    const file = existing instanceof TFileClass ? existing : null;
    let onDisk: string | null = null;
    if (file) {
      try {
        const known = unchangedRecordedHash(
          state[row.source_ref],
          file.stat.size,
          file.stat.mtime,
        );
        onDisk = known === undefined ? await sha256(await app.vault.read(file)) : known;
      } catch {
        onDisk = null;
      }
    } else if (isConfigPath(app, row.source_ref)) {
      const info = await statConfigFile(app, row.source_ref);
      if (info) {
        try {
          const known = unchangedRecordedHash(state[row.source_ref], info.size, info.mtime);
          onDisk =
            known === undefined
              ? info.binary
                ? await sha256(await readConfigBinary(app, row.source_ref))
                : await sha256(await readConfigText(app, row.source_ref))
              : known;
        } catch {
          onDisk = null;
        }
      }
    }
    if (decide({ row, onDisk, record: state[row.source_ref] }).action !== "none") {
      needsBody.push({ id: row.id, size: row.byte_size ?? 0 });
    }
  }

  const missingBodyIds = new Set<string>();
  if (needsBody.length > 0) {
    // Your notes before plugin code. All 447 notes weigh 2.5 MB between them;
    // the config text is 30 MB of plugin JavaScript. Fetching them in one
    // undifferentiated lump means waiting for a plugin bundle before a single
    // note of your own arrives.
    const byId = new Map(rows.map((r) => [r.id, r]));
    needsBody.sort((a, b) => {
      const aConfig = isConfigPath(app, byId.get(a.id)?.source_ref ?? "") ? 1 : 0;
      const bConfig = isConfigPath(app, byId.get(b.id)?.source_ref ?? "") ? 1 : 0;
      if (aConfig !== bConfig) return aConfig - bConfig;
      return a.size - b.size;
    });

    onProgress(0, 1, `fetching ${needsBody.length} files…`);
    const bodies = await client.getDocumentBodies(needsBody, (fetched, total) => {
      onProgress(0, 1, `fetching text — ${fetched} of ${total}`);
    });
    for (const item of needsBody) {
      if (!bodies.has(item.id)) missingBodyIds.add(item.id);
    }
    for (const row of rows) {
      const body = bodies.get(row.id);
      if (body) {
        row.raw = body.raw;
        row.body = body.body;
        row.frontmatter = body.frontmatter;
      }
    }
  }

  let done = 0;
  let sinceSave = 0;
  let remaining = rows.reduce((sum, r) => sum + (r.byte_size ?? 0), 0);

  for (const row of rows) {
    done += 1;
    // Name the size as soon as the file is reached — a 169 MB video that says
    // so is a wait; the same file in silence is a hang — and carry how much of
    // the whole job is left, so an interrupted sync can be judged rather than
    // guessed at.
    if (done === noteCount + 1 && noteCount > 0) {
      onProgress(done, rows.length, "notes are all here — fetching attachments now");
    }
    remaining -= row.byte_size ?? 0;
    onProgress(
      done,
      rows.length,
      ((row.byte_size ?? 0) > 2_000_000
        ? `${row.source_ref} (${mb(row.byte_size ?? 0)})`
        : row.source_ref) + (remaining > 5_000_000 ? ` · ${mb(remaining)} left` : ""),
    );

    // Config files take a completely different route: the vault API cannot see
    // or write inside `.obsidian`, so they are read, hashed and written through
    // the adapter. The permission check runs on the way DOWN as well as up,
    // because a row written by an older version could otherwise deliver
    // another device's key and sync record into this vault.
    if (isConfigPath(app, row.source_ref)) {
      if (!mayWriteConfigPath(app, row.source_ref, configOpts)) {
        result.skipped += 1;
        continue;
      }
      try {
        const info = await statConfigFile(app, row.source_ref);
        const known = info
          ? unchangedRecordedHash(state[row.source_ref], info.size, info.mtime)
          : undefined;
        const onDiskHash = !info
          ? null
          : known !== undefined
            ? known
            : info.binary
              ? await sha256(await readConfigBinary(app, row.source_ref))
              : await sha256(await readConfigText(app, row.source_ref));

        const { action } = decide({ row, onDisk: onDiskHash, record: state[row.source_ref] });
        if (action === "none") {
          result.unchanged += 1;
          continue;
        }
        if (action === "delete") {
          if (info && onDiskHash === state[row.source_ref]?.diskHash) {
            await removeConfigFile(app, row.source_ref);
            delete state[row.source_ref];
            result.deletedLocally += 1;
          }
          continue;
        }
        // Never put a conflict twin inside a plugin/theme directory where
        // Obsidian could try to load it. Preserve the local version in a normal
        // vault folder, then apply the shared version at its real config path.
        if (action === "conflict" && info) {
          const savedAs = await backUpConfigConflict(app, row.source_ref, info);
          result.conflicts.push({ path: row.source_ref, savedAs });
        }
        if (row.kind === "attachment" && !row.storage_path) {
          throw new Error(`the server row for ${row.source_ref} has no attachment object path`);
        }
        if (row.kind === "attachment") {
          const storagePath = row.storage_path;
          if (!storagePath) throw new Error(`the server row for ${row.source_ref} has no attachment object path`);
          const fetched = await client.getObject(storagePath);
          await writeConfigBinary(
            app,
            row.source_ref,
            await verifiedBytes(fetched, row.content_hash, row.source_ref),
            timesFor(row),
          );
        } else {
          if (missingBodyIds.has(row.id)) {
            throw new Error(`the server did not return the text requested for ${row.source_ref}`);
          }
          const text = renderNote(row);
          await verifiedBytes(
            new TextEncoder().encode(text).buffer,
            row.content_hash,
            row.source_ref,
          );
          await writeConfigText(app, row.source_ref, text, timesFor(row));
        }
        const after = await statConfigFile(app, row.source_ref);
        state[row.source_ref] = {
          layerHash: row.content_hash ?? null,
          diskHash: row.content_hash ?? null,
          size: after?.size,
          mtime: after?.mtime,
          at: new Date().toISOString(),
        };
        result.downloaded += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`could not write ${row.source_ref}: ${reason}`);
        result.failed.push({ path: row.source_ref, reason });
      }
      continue;
    }

    if (isExcluded(row.source_ref)) continue;

    const path = normalizePath(row.source_ref);
    const existing = app.vault.getAbstractFileByPath(path);
    const file = existing instanceof TFileClass ? existing : null;

    let onDisk: string | null = null;
    if (file) {
      try {
        const known = unchangedRecordedHash(
          state[row.source_ref],
          file.stat.size,
          file.stat.mtime,
        );
        onDisk =
          known !== undefined
            ? known
            : isMarkdown(path)
              ? await sha256(await app.vault.read(file))
              : await sha256(await app.vault.readBinary(file));
      } catch (error) {
        result.failed.push({
          path: row.source_ref,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    // Attachment policy, applied before any network call. Already-present
    // attachments still count as unchanged; only content this device genuinely
    // lacks is reported as skipped/outstanding.
    if (row.kind === "attachment" && !row.deleted_at && onDisk !== row.content_hash) {
      const policy = options.attachments ?? "all";
      const limit = options.attachmentLimitBytes ?? Number.POSITIVE_INFINITY;
      if (policy === "none" || (policy === "under-limit" && (row.byte_size ?? 0) > limit)) {
        result.skipped += 1;
        result.outstanding += 1;
        result.outstandingBytes += row.byte_size ?? 0;
        continue;
      }
    }

    const { action } = decide({ row, onDisk, record: state[row.source_ref] });
    if (action === "none") {
      result.unchanged += 1;
      continue;
    }

    try {
      if (action === "delete") {
        // Only remove a file that still looks like what was last synced, and
        // send it to Obsidian's trash rather than deleting outright — a wrong
        // decision here should be recoverable by the user, not final.
        if (file && onDisk === state[row.source_ref]?.diskHash) {
          await app.fileManager.trashFile(file);
          delete state[row.source_ref];
          result.deletedLocally += 1;
        }
        continue;
      }

      if (row.kind !== "attachment" && missingBodyIds.has(row.id)) {
        throw new Error(`the server did not return the text requested for ${row.source_ref}`);
      }

      if (row.kind === "attachment" && !row.storage_path) {
        throw new Error(`the server row for ${row.source_ref} has no attachment object path`);
      }
      const storagePath = row.storage_path;

      const bytes =
        row.kind === "attachment"
          ? await verifiedBytes(
              await client.getObject(storagePath!, (received, total) => {
                // Big files are the ones that look frozen, so say how far in
                // we are. Small ones would just flicker.
                if ((total ?? row.byte_size ?? 0) > 2_000_000) {
                  onProgress(done, rows.length, `${row.source_ref} — ${mb(received)} of ${mb(total ?? row.byte_size ?? 0)}`);
                }
              }),
              row.content_hash,
              row.source_ref,
            )
          : await verifiedBytes(
              new TextEncoder().encode(renderNote(row)).buffer,
              row.content_hash,
              row.source_ref,
            );

      const target = action === "conflict" ? normalizePath(conflictName(row.source_ref, new Date().toISOString())) : path;

      await ensureParentFolders(app, target);
      const targetFile = app.vault.getAbstractFileByPath(target);
      const asFile = targetFile instanceof TFileClass ? targetFile : null;

      const times = timesFor(row);
      if (row.kind === "attachment") {
        if (asFile) await app.vault.modifyBinary(asFile, bytes, times);
        else await app.vault.createBinary(target, bytes, times);
      } else {
        const text = new TextDecoder().decode(bytes);
        if (asFile) await app.vault.modify(asFile, text, times);
        else await app.vault.create(target, text, times);
      }

      if (action === "conflict") {
        result.conflicts.push({ path: row.source_ref, savedAs: target });
        // Deliberately no state update: the two sides have NOT agreed, and
        // recording that they had would make the next pass overwrite the file
        // this one just protected.
      } else {
        result.downloaded += 1;
        const written = app.vault.getAbstractFileByPath(target);
        const writtenFile = written instanceof TFileClass ? written : null;
        state[row.source_ref] = {
          layerHash: row.content_hash ?? null,
          diskHash: await sha256(bytes),
          size: writtenFile?.stat.size,
          mtime: writtenFile?.stat.mtime,
          at: new Date().toISOString(),
        };
      }

      // Checkpoint as we go: iOS can suspend the app mid-pass, and a run that
      // forgets everything it placed would redo it all and risk conflicts.
      sinceSave += 1;
      if (sinceSave >= 25) {
        await options.saveState(state);
        sinceSave = 0;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not write ${row.source_ref}: ${reason}`);
      result.failed.push({ path: row.source_ref, reason });
    }
  }

  await options.saveState(state);
  return result;
}


/**
 * Check every local file against the layer and fix anything that does not match.
 *
 * For the case this was written for: a sync stopped part-way. Some files are
 * complete, some are truncated, and the sync record says nothing about either.
 * A normal pass would treat the truncated ones as edits and make conflict
 * copies; this one recognises them as damage and simply removes them, so the
 * next pass fetches them again.
 *
 * Nothing is deleted unless the layer holds a copy to replace it with — a file
 * the layer has never heard of is yours, and is left alone.
 */
export async function verifyAndRepair(options: EngineOptions): Promise<{
  checked: number;
  corrupt: string[];
  missing: string[];
}> {
  const { app, client, state, onProgress = () => {} } = options;
  const rows = await client.listDocumentsFull();
  const corrupt: string[] = [];
  const missing: string[] = [];
  let checked = 0;

  for (const row of rows) {
    checked += 1;
    onProgress(checked, rows.length, row.source_ref);
    if (row.deleted_at || !row.content_hash) continue;
    if (isConfigPath(app, row.source_ref)) continue;

    const existing = app.vault.getAbstractFileByPath(normalizePath(row.source_ref));
    const file = existing instanceof TFileClass ? existing : null;
    if (!file) {
      missing.push(row.source_ref);
      continue;
    }

    let onDisk: string;
    try {
      onDisk = row.kind === "attachment"
        ? await sha256(await app.vault.readBinary(file))
        : await sha256(await app.vault.read(file));
    } catch {
      corrupt.push(row.source_ref);
      continue;
    }

    if (onDisk === row.content_hash) {
      // Whole and correct — record the agreement so the next pass skips it
      // cheaply instead of hashing it again.
      state[row.source_ref] = {
        layerHash: row.content_hash,
        diskHash: onDisk,
        size: file.stat.size,
        mtime: file.stat.mtime,
        at: new Date().toISOString(),
      };
      continue;
    }

    // Differs. If we have never recorded these two agreeing, this is almost
    // certainly a half-written file from an interrupted run rather than an
    // edit — an edit would have been made in Obsidian, on a file that had
    // finished downloading, and would therefore have a record.
    if (!state[row.source_ref]) {
      await app.fileManager.trashFile(file);
      corrupt.push(row.source_ref);
    }
  }

  await options.saveState(state);
  return { checked, corrupt, missing };
}


/**
 * Put the original created/modified dates back on files already downloaded.
 *
 * Needed because earlier versions wrote every file without them, so a restored
 * vault came out looking as though every note had been written the day it was
 * downloaded. Contents were perfect; the dates — which is how this vault is
 * sorted — were all today.
 *
 * Rewrites each file with its own current contents and the correct timestamps,
 * so nothing is fetched and nothing can be lost: the bytes on disk go back
 * exactly as they are, only the dates change.
 */
export async function repairDates(options: EngineOptions): Promise<{ checked: number; fixed: number }> {
  const { app, client, onProgress = () => {} } = options;
  const rows = await client.listDocumentsMeta();
  let checked = 0;
  let fixed = 0;

  for (const row of rows) {
    checked += 1;
    onProgress(checked, rows.length, row.source_ref);
    if (row.deleted_at) continue;

    const times = timesFor(row);
    if (times.ctime === undefined && times.mtime === undefined) continue;

    try {
      if (isConfigPath(app, row.source_ref)) continue; // config dates do not matter
      const existing = app.vault.getAbstractFileByPath(normalizePath(row.source_ref));
      const file = existing instanceof TFileClass ? existing : null;
      if (!file) continue;

      // Within a second is close enough; rewriting every file to correct a few
      // milliseconds would be churn for nothing.
      const ctimeMatches =
        times.ctime === undefined || Math.abs(file.stat.ctime - times.ctime) < 1000;
      const mtimeMatches =
        times.mtime === undefined || Math.abs(file.stat.mtime - times.mtime) < 1000;
      if (ctimeMatches && mtimeMatches) continue;

      if (row.kind === "attachment") {
        await app.vault.modifyBinary(file, await app.vault.readBinary(file), times);
      } else {
        await app.vault.modify(file, await app.vault.read(file), times);
      }
      fixed += 1;
    } catch (error) {
      options.log?.(`could not fix dates on ${row.source_ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { checked, fixed };
}

/** One full pass: pull first so local edits are never sent into a conflict, then push. */
export async function syncBothWays(options: EngineOptions): Promise<{ pulled: PassResult; pushed: PassResult }> {
  const pulled = await pull(options);
  const pushed = await push(options);
  return { pulled, pushed };
}
