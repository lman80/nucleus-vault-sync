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
import { normalizePath, TFile as TFileClass } from "obsidian";

import { decide, renderNote, conflictName } from "./core/decide";
import { splitFrontmatter, extractTags, extractLinks, titleFor, mimeFor, sha256, uuidV5 } from "./core/parse";
import type { DocumentRow, SyncRecord, SyncState } from "./core/types";
import type { NucleusClient } from "./client";

/** Folders never touched, in either direction. */
const EXCLUDED_PREFIXES = [".obsidian", ".trash", ".smart-env", ".claude", ".claudian", ".git"];

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
}

export interface PassResult {
  uploaded: number;
  downloaded: number;
  deletedLocally: number;
  tombstoned: number;
  unchanged: number;
  /** Deliberately not fetched — e.g. an attachment above this device's limit. */
  skipped: number;
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
  conflicts: [],
  failed: [],
});

export function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
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
 * Uses `fileManager.renameFile` rather than `vault.rename` so links between the
 * moved notes are rewritten and keep working.
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
      await app.fileManager.renameFile(file, target);
      moved += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`could not move ${file.path}: ${reason}`);
      failed.push({ path: file.path, reason });
    }
  }
  return { moved, failed };
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
  const remote = await client.listDocumentsSlim();
  const remoteByPath = new Map(remote.filter((r) => !r.deleted_at).map((r) => [r.source_ref, r]));

  const seen = new Set<string>();
  let done = 0;

  for (const file of files) {
    done += 1;
    onProgress(done, files.length, file.path);
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

  // Anything the layer still calls live but the vault no longer has.
  const gone = remote.filter((r) => !r.deleted_at && !seen.has(r.source_ref));
  const liveCount = remote.filter((r) => !r.deleted_at).length;
  if (liveCount >= 20 && gone.length / liveCount > 0.5) {
    log(
      `Refusing to delete ${gone.length} of ${liveCount} files — the vault only read as ` +
        `${files.length} files. That usually means Obsidian has not finished loading, not that ` +
        `you deleted everything.`,
    );
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

  const rows = await client.listDocumentsFull();
  let done = 0;
  let sinceSave = 0;

  for (const row of rows) {
    done += 1;
    onProgress(done, rows.length, row.source_ref);

    if (isExcluded(row.source_ref)) continue;

    // Attachment policy, applied before any network call: a file we are not
    // going to keep should cost nothing at all, not a download we then discard.
    if (row.kind === "attachment") {
      const policy = options.attachments ?? "all";
      const limit = options.attachmentLimitBytes ?? Number.POSITIVE_INFINITY;
      if (policy === "none" || (policy === "under-limit" && (row.byte_size ?? 0) > limit)) {
        result.skipped += 1;
        continue;
      }
    }

    const path = normalizePath(row.source_ref);
    const existing = app.vault.getAbstractFileByPath(path);
    const file = existing instanceof TFileClass ? existing : null;

    let onDisk: string | null = null;
    if (file) {
      try {
        onDisk = isMarkdown(path)
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

      const bytes =
        row.kind === "attachment" && row.storage_path
          ? await client.getObject(row.storage_path)
          : new TextEncoder().encode(renderNote(row)).buffer;

      const target = action === "conflict" ? normalizePath(conflictName(row.source_ref, new Date().toISOString())) : path;

      await ensureParentFolders(app, target);
      const targetFile = app.vault.getAbstractFileByPath(target);
      const asFile = targetFile instanceof TFileClass ? targetFile : null;

      if (row.kind === "attachment") {
        if (asFile) await app.vault.modifyBinary(asFile, bytes);
        else await app.vault.createBinary(target, bytes);
      } else {
        const text = new TextDecoder().decode(bytes);
        if (asFile) await app.vault.modify(asFile, text);
        else await app.vault.create(target, text);
      }

      if (action === "conflict") {
        result.conflicts.push({ path: row.source_ref, savedAs: target });
        // Deliberately no state update: the two sides have NOT agreed, and
        // recording that they had would make the next pass overwrite the file
        // this one just protected.
      } else {
        result.downloaded += 1;
        state[row.source_ref] = {
          layerHash: row.content_hash ?? null,
          diskHash: await sha256(bytes),
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

/** One full pass: pull first so local edits are never sent into a conflict, then push. */
export async function syncBothWays(options: EngineOptions): Promise<{ pulled: PassResult; pushed: PassResult }> {
  const pulled = await pull(options);
  const pushed = await push(options);
  return { pulled, pushed };
}
