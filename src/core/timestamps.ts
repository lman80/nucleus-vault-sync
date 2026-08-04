import type { DocumentRow } from "./types";

export function timesFor(row: Pick<DocumentRow, "file_created_at" | "file_modified_at">): {
  ctime?: number;
  mtime?: number;
} {
  const created = row.file_created_at ? Date.parse(row.file_created_at) : NaN;
  const modified = row.file_modified_at ? Date.parse(row.file_modified_at) : NaN;
  const out: { ctime?: number; mtime?: number } = {};
  if (Number.isFinite(created)) out.ctime = created;
  if (Number.isFinite(modified)) out.mtime = modified;
  return out;
}

export function timesKey(
  row: Pick<DocumentRow, "file_created_at" | "file_modified_at">,
): string {
  return `${row.file_created_at ?? ""}|${row.file_modified_at ?? ""}`;
}

export function localTimesMatch(
  stat: { ctime: number; mtime: number },
  wanted: { ctime?: number; mtime?: number },
): boolean {
  return (
    (wanted.ctime === undefined || Math.abs(stat.ctime - wanted.ctime) < 1000) &&
    (wanted.mtime === undefined || Math.abs(stat.mtime - wanted.mtime) < 1000)
  );
}

/** Existing valid server dates win; clients only backfill metadata absent on old rows. */
export function remoteTimesPresent(
  row: Pick<DocumentRow, "file_created_at" | "file_modified_at">,
): boolean {
  const created = row.file_created_at ? Date.parse(row.file_created_at) : NaN;
  const modified = row.file_modified_at ? Date.parse(row.file_modified_at) : NaN;
  return Number.isFinite(created) && Number.isFinite(modified);
}
