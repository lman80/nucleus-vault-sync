/**
 * decide — the layer → vault direction, reduced to a pure decision.
 *
 * Ported verbatim from the Node connector's `src/pull.js`. Everything that
 * touched the disk stayed behind; what is here is the table that says what one
 * row implies for one file, and how a file's bytes are produced. No fs, no
 * network, no Obsidian — which is the point: this is the code that can delete
 * or overwrite a note in a real vault, so it has to be testable on its own.
 *
 * ## The rule that makes this safe
 *
 * **Nothing is ever overwritten in place when both sides changed.** If a file
 * on disk differs from what the layer last saw *and* the layer's copy has also
 * moved on, the layer's version is written beside it as
 * `Note (conflict 2026-08-03T09-12-00Z).md` and the file you were editing is
 * left exactly as it is. You lose nothing and get to decide.
 *
 * Deciding "who changed" needs a third fact beyond the two current states: what
 * both sides looked like when they last agreed. That is the *sync record*, kept
 * per file by the caller.
 *
 * | on disk vs record | in layer vs record | what happens |
 * |---|---|---|
 * | same | same | nothing |
 * | same | changed | layer wins, file rewritten |
 * | changed | same | vault wins, nothing written (the push pass sends it up) |
 * | changed | changed | **conflict copy**, your file untouched |
 * | missing | present | file restored from the layer |
 * | present | tombstoned | file deleted — but only if it matches the record |
 *
 * The last row is the wipe guard, and it lives in the caller as well as here:
 * `decide` only says "delete", and the caller must still check that the file on
 * disk is byte-for-byte what was last synced before removing it. A file touched
 * since is not ours to remove.
 */

import type { DecideInput, DecideResult, RenderableNote } from "./types";

/**
 * The bytes a note's file should contain.
 *
 * `raw` is the file's exact text and is used whenever it is present — a
 * restore is then a byte-for-byte write, not a reconstruction. The reassembly
 * below is a fallback for rows written by something that only set `body` and
 * `frontmatter` (an agent composing a new note, for instance), and is the only
 * path where formatting could drift from what a human would have typed.
 */
export function renderNote(row: RenderableNote): string {
  if (typeof row.raw === "string" && row.raw.length > 0) return row.raw;
  const body = row.body ?? "";
  if (!row.frontmatter || Object.keys(row.frontmatter).length === 0) return body;
  // Only re-emit frontmatter this tool can round-trip losslessly. Anything
  // else is left to the push side, which never rewrites a file at all.
  const lines = Object.entries(row.frontmatter).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}:\n${value.map((v) => `  - ${String(v)}`).join("\n")}`;
    if (value === null || value === undefined) return `${key}:`;
    if (typeof value === "object") return `${key}: ${JSON.stringify(value)}`;
    return `${key}: ${String(value)}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** What one row implies for one file. Pure — no disk, no network. */
export function decide({ row, onDisk, record }: DecideInput): DecideResult {
  const layerHash = row?.deleted_at ? null : row?.content_hash ?? null;
  const diskHash = onDisk ?? null;
  const seenLayer = record?.layerHash ?? null;
  const seenDisk = record?.diskHash ?? null;

  const layerMoved = layerHash !== seenLayer;
  const diskMoved = diskHash !== seenDisk;

  if (!layerMoved && !diskMoved) return { action: "none" };

  if (layerMoved && !diskMoved) {
    if (layerHash === null) return { action: "delete" };
    if (diskHash === layerHash) return { action: "none" };
    return { action: "write" };
  }

  if (!layerMoved && diskMoved) return { action: "none", reason: "vault is ahead; push will send it" };

  // Both moved. If they happen to have landed on identical content, there is
  // nothing to reconcile.
  if (layerHash !== null && layerHash === diskHash) return { action: "none" };
  if (layerHash === null && diskHash === null) return { action: "none" };
  if (layerHash === null) return { action: "none", reason: "deleted in layer but edited here; keeping yours" };
  return { action: "conflict" };
}

/**
 * Where a conflict copy goes: beside the original, same extension, with the
 * timestamp in the name. Keeping the extension matters — a `.md` conflict has
 * to stay a note Obsidian will open, and colons are illegal in filenames on
 * every platform this runs on, so the ISO stamp is flattened to dashes.
 *
 * `at` is an ISO-8601 string; `relPath` is vault-relative with forward slashes.
 */
export function conflictName(relPath: string, at: string): string {
  const stamp = at.replace(/[:.]/g, "-");
  const dot = relPath.lastIndexOf(".");
  // A dot that comes before the last slash belongs to a folder name, not this
  // file — treat the file as having no extension.
  if (dot <= relPath.lastIndexOf("/")) return `${relPath} (conflict ${stamp})`;
  return `${relPath.slice(0, dot)} (conflict ${stamp})${relPath.slice(dot)}`;
}
