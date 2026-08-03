/**
 * types — the shapes the sync core passes around.
 *
 * Deliberately structural and dependency-free: nothing here imports Obsidian,
 * Supabase, or Node. The core modules take these objects in and hand them back
 * out, which is what makes them unit-testable with no vault and no network.
 */

/**
 * Parsed YAML frontmatter. Values are `unknown` on purpose — a note's
 * frontmatter is whatever a human typed, and pretending otherwise would push
 * casts into every caller. Read it defensively.
 */
export type Frontmatter = Record<string, unknown>;

/** A note carries its text inline; an attachment's bytes live in the file store. */
export type DocumentKind = "note" | "attachment";

/**
 * One row of `core.documents` — the layer's record of one file in the vault.
 *
 * Most fields are optional because the layer hands back two different shapes:
 * a slim listing (id, source_ref, content_hash, deleted_at) used to plan a
 * pass, and a full row (raw, body, frontmatter) fetched only for the files a
 * pass has decided to write.
 */
export interface DocumentRow {
  /** Stable identity. First set by `uuidV5(vault + "\n" + source_ref)`; after
   *  that the row owns it, so a rename in the vault keeps the same row. */
  id: string;
  /** The vault's display name — one layer can hold more than one vault. */
  vault: string;
  /** Vault-relative path with forward slashes, e.g. `Projects/Notes/Idea.md`. */
  source_ref: string;
  /** Frozen app id for everything this connector writes: `"obsidian"`. */
  source_app: string;
  kind: DocumentKind;
  title: string;

  /**
   * The file's exact text. The source of truth: everything below is derived
   * from it and can be recomputed, and a restore writes this back unchanged.
   */
  raw?: string | null;
  /** `raw` with the frontmatter block removed. Derived. */
  body?: string | null;
  frontmatter?: Frontmatter | null;
  tags?: string[] | null;
  links?: string[] | null;

  /** Lowercase hex SHA-256 of the file's bytes. The whole sync turns on this. */
  content_hash?: string | null;
  byte_size?: number | null;

  /** Attachments only: `<vault>/<sha256>` in the layer's file store. */
  storage_path?: string | null;
  mime_type?: string | null;

  /** Timestamps the file claims (frontmatter or filesystem), ISO-8601. */
  file_created_at?: string | null;
  file_modified_at?: string | null;

  /** Timestamps the layer owns, ISO-8601. */
  created_at?: string | null;
  updated_at?: string | null;
  /** Non-null means tombstoned: the layer says this file should not exist. */
  deleted_at?: string | null;
}

/**
 * What both sides looked like the last time they agreed, kept per file.
 *
 * This third fact is what makes "who changed?" answerable at all: with only
 * the two current states you cannot tell an edit here from an edit there. No
 * record means "they have never agreed", which makes the engine conservative
 * rather than destructive.
 */
export interface SyncRecord {
  /** `content_hash` of the row when it was last reconciled; null if tombstoned. */
  layerHash: string | null;
  /** SHA-256 of the file's bytes when it was last reconciled. */
  diskHash: string | null;
  /** ISO-8601 timestamp of that reconciliation. Informational. */
  at?: string;
}

/** Per-file sync state, keyed by vault-relative path. */
export type SyncState = Record<string, SyncRecord>;

export type DecideAction = "none" | "write" | "conflict" | "delete";

export interface DecideResult {
  action: DecideAction;
  /**
   * Only set on "none" results that are a deliberate refusal rather than a
   * no-op — the caller counts those as "skipped", not "unchanged".
   */
  reason?: string;
}

/**
 * What `decide` needs to know about a row. Narrower than `DocumentRow` so the
 * decision table can be tested with two fields instead of a whole document.
 */
export interface DecidableRow {
  content_hash?: string | null;
  deleted_at?: string | null;
}

export interface DecideInput {
  row?: DecidableRow | null;
  /** SHA-256 of the file currently on disk, or null when there is no file. */
  onDisk?: string | null;
  record?: SyncRecord | null;
}

/**
 * What `renderNote` needs. A full `DocumentRow` satisfies it; so does a row
 * composed by an agent that only set `body` and `frontmatter`.
 */
export interface RenderableNote {
  raw?: string | null;
  body?: string | null;
  frontmatter?: Frontmatter | null;
}
