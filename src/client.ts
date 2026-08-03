/**
 * client — the only part of the plugin that talks to the network.
 *
 * Nucleus is PostgREST plus Supabase storage, so this file is small: rows live
 * at `/rest/v1/documents` (every core table is reached through a public view),
 * attachment bytes live in the `vault` bucket at `/storage/v1/object/`, and the
 * connector's own bookkeeping lives in `/rest/v1/obsidian_state`. Ported from
 * the Node connector's `src/layer.js`, endpoint for endpoint.
 *
 * ## Two transports, on purpose
 *
 * Obsidian ships `requestUrl` precisely so plugins can ignore CORS, and it is
 * the right call for every JSON request here. But on iOS and Android it hands
 * the body to the native side **as base64**, because the app's JS↔native bridge
 * cannot pass byte arrays ("Unfortunately this won't be fixed anytime soon",
 * Obsidian devs, Oct 2024). Both the encoded string and the decoded buffer are
 * resident at once, so transfers of roughly 20–50 MB take the whole app out
 * with an OOM kill — no error, no catch, Obsidian simply dies. This vault holds
 * videos of 97, 100, 104 and 169 MB. Native `fetch` moves those same files
 * without complaint on the same iPhone.
 *
 * So: **`requestUrl` for JSON, `fetch` for bytes.** `fetch` is subject to CORS
 * and Obsidian's origin differs per platform (`app://obsidian.md` on desktop,
 * `capacitor://localhost` on iOS, `http://localhost` on Android) — this user's
 * server already allows all three on `/storage/v1/`. A server that does not can
 * set `preferFetchForBinary: false`, which puts binaries back on `requestUrl`
 * behind a size cap that **refuses** oversized transfers. Refusing one video
 * with a message the user can act on beats crashing their editor.
 */

import { requestUrl, type RequestUrlResponse } from "obsidian";

import { isTransientMessage, TIMEOUT_MESSAGE } from "./core/transient";

export { TIMEOUT_MESSAGE };

import type { DocumentRow } from "./core/types";

/** Attachment bytes all live in one bucket; the path inside it is the identity. */
const BUCKET = "vault";

/** PostgREST caps its own page size; ask for exactly that and walk. */
const PAGE = 1000;

/** Rows per upsert POST. Matches the Node connector — one request per 50 notes
 *  keeps a body small enough that a dropped connection is cheap to retry. */
const BATCH = 50;

/**
 * Retry budget: 7 attempts at 1.5 s doubling, ~90 s of trying.
 *
 * Deliberately generous, and learned the hard way. The Node connector started
 * at 5 attempts over 12 seconds and that budget was exhausted by an ordinary
 * blip on a link eight time zones from the server; the request it gave up on
 * succeeded from curl moments later. A retry budget shorter than a real outage
 * is not a retry budget. It only ever applies to network faults — a 4xx fails
 * on the first attempt, because retrying a rejected key just makes the user
 * wait 90 seconds to be told the same thing.
 */
const RETRY_ATTEMPTS = 7;
const RETRY_BASE_MS = 1500;

/**
 * `requestUrl` has no timeout, no `AbortSignal` and no cancellation, so a JSON
 * call against a black-holed connection hangs until the app is killed. Race it
 * ourselves. A timed-out request keeps running in the background — there is no
 * way to stop it — but the sync gets to move on, and the timeout counts as
 * transient so the retry loop tries again.
 */
/**
 * How long to wait for a data request before treating it as dead.
 *
 * Was 60 s, which is the wrong shape of patience. A healthy reply to any of
 * these takes about two seconds; sixty seconds only ever means the path is
 * broken, and spending a full minute discovering that — then retrying — leaves
 * someone staring at "checking what is on the server" with no idea it has
 * already given up once.
 *
 * The first attempt is short so a dead route is obvious immediately, and later
 * attempts are more patient so a genuinely slow connection still succeeds.
 */
const REST_TIMEOUT_MS = 12_000;
const REST_TIMEOUT_MAX_MS = 45_000;

/** Well under the 20–50 MB danger zone, and only consulted when the caller has
 *  turned the `fetch` path off. */
const DEFAULT_MAX_REQUESTURL_BINARY_BYTES = 8 * 1024 * 1024;

/**
 * The console attributes traffic by User-Agent prefix, so the layer can say
 * which app wrote a row. Sent on `requestUrl` only: browsers strip `User-Agent`
 * from `fetch` as a forbidden header name, and asking for it would achieve
 * nothing except widening the CORS preflight.
 */
const USER_AGENT = "ObsidianNucleus/0.1.0";

/**
 * Faults worth trying again rather than giving up on. The last few entries are
 * what WKWebView and Chromium actually say when a `fetch` fails — "Load failed"
 * and "Failed to fetch" are the entire error message on iOS and Android, which
 * is also, unhelpfully, what a CORS rejection looks like from inside the page.
 */


export interface NucleusConfig {
  url: string;
  key: string;
  vaultName: string;
  /** Move attachment bytes over native `fetch`. Default true — see the file
   *  header. Turn it off only for a server whose CORS does not allow Obsidian's
   *  origins on `/storage/v1/`; large files are then refused, not sent. */
  preferFetchForBinary?: boolean;
  /** Only consulted on the `requestUrl` binary path. Default 8 MB. */
  maxRequestUrlBinaryBytes?: number;
}

/** Just enough of a row to plan a pass: what it is, and whether it moved. */
export interface DocRowSlim {
  id: string;
  source_ref: string;
  kind: string;
  content_hash: string | null;
  storage_path: string | null;
  deleted_at: string | null;
}

/** A transport-level failure (DNS, TLS, offline, timeout, possibly CORS). */
class TransportError extends Error {
  readonly retryable = true;
}

/** The server answered, and the answer was not a success. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // Bare setTimeout, not window.setTimeout: identical inside Obsidian on
    // every platform, and it lets this client be exercised outside the app —
    // which is how it got tested against a real server before shipping.
    setTimeout(resolve, ms);
  });

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // A `fetch` failure hides the useful part in `cause`; read it structurally
    // rather than typing against ES2022's `Error.cause`.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const extra = cause?.code ?? cause?.message ?? "";
    return extra ? `${error.message} (${extra})` : error.message;
  }
  return String(error);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  if (error instanceof HttpError) return error.retryable;
  return isTransientMessage(messageOf(error));
}

/** Response header casing is not stable across platforms — normalise before reading. */
function header(res: RequestUrlResponse, name: string): string | null {
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export class NucleusClient {
  private readonly url: string;
  private readonly key: string;
  private readonly vaultName: string;
  private readonly preferFetchForBinary: boolean;
  private readonly maxRequestUrlBinaryBytes: number;

  constructor(config: NucleusConfig) {
    // A trailing slash turns every path into a double slash, which PostgREST
    // answers with a 404 that reads like a missing table.
    this.url = (config.url ?? "").trim().replace(/\/+$/, "");
    this.key = config.key ?? "";
    this.vaultName = config.vaultName ?? "";
    this.preferFetchForBinary = config.preferFetchForBinary ?? true;
    this.maxRequestUrlBinaryBytes =
      config.maxRequestUrlBinaryBytes ?? DEFAULT_MAX_REQUESTURL_BINARY_BYTES;
  }

  // ---------------------------------------------------------------- identity

  /**
   * The one thing that must never appear in a message, a `Notice`, or the
   * console. Nothing here deliberately prints the key, but error bodies and
   * platform error strings are not ours to trust, so every outgoing string
   * passes through this.
   */
  private redact(text: string): string {
    if (this.key.length < 8) return text;
    return text.split(this.key).join("<key redacted>");
  }

  /** Host only — enough to tell "wrong URL" from "server down", with no key in it. */
  private get host(): string {
    const match = /^[a-z]+:\/\/([^/]+)/i.exec(this.url);
    return match?.[1] ?? this.url ?? "the server";
  }

  private get authHeaders(): Record<string, string> {
    // PostgREST wants the bearer; Supabase's gateway wants `apikey`. Sending
    // both is what every Supabase client does and costs nothing.
    return { apikey: this.key, Authorization: `Bearer ${this.key}` };
  }

  // ------------------------------------------------------------------ errors

  private transportError(error: unknown, label: string): Error {
    const detail = this.redact(messageOf(error));
    if (isTransientMessage(detail)) {
      return new TransportError(
        // A timeout means the server answered and the reply was too slow or
        // too large — telling someone to check the URL sends them to look at
        // exactly the wrong thing.
        new RegExp(TIMEOUT_MESSAGE).test(detail)
          ? `${label}: ${detail}.\n\nThe request went out but nothing came back. If this device is on ` +
            `Tailscale, that address routes privately rather than over the internet — and a ` +
            `half-connected Tailscale gives exactly this: the name resolves, the traffic goes ` +
            `nowhere. Reconnect Tailscale, or turn it off entirely; the same address works either ` +
            `way. Otherwise it is an ordinary connection problem and syncing again will retry.`
          : `${label}: could not reach ${this.host} — ${detail}. Check the server URL, your connection, and that Nucleus is running.`,
      );
    }
    return new Error(`${label} failed: ${detail}`);
  }

  private httpError(status: number, body: string, label: string): HttpError {
    // 5xx and 429 are the server having a moment (a gateway restart, a
    // rate-limit) rather than the request being wrong, so they get the retry
    // budget. Every 4xx is a statement about the request itself and is final.
    const retryable = status === 429 || status >= 500;
    const detail = this.redact(body.trim().slice(0, 300));

    let message: string;
    if (status === 401 || status === 403) {
      message = `your key was rejected (${status}). Check the API key in settings — it may have been rotated or may lack access to this layer.`;
    } else if (status === 404) {
      message = `${this.host} has no such endpoint (404). Check the server URL, and that this Nucleus exposes documents and the "${BUCKET}" bucket.`;
    } else if (status === 409) {
      message = `the server refused a conflicting write (409). ${detail}`;
    } else if (status === 413) {
      message = `the server rejected the upload as too large (413). Raise the server's upload limit, or leave this file out of the sync.`;
    } else if (status === 429) {
      message = `the server is rate-limiting this sync (429). Retrying shortly.`;
    } else if (status >= 500) {
      message = `${this.host} returned a server error (${status}). ${detail}`;
    } else {
      message = `the server refused the request (${status}). ${detail}`;
    }
    return new HttpError(status, `${label}: ${message}`, retryable);
  }

  // ------------------------------------------------------------------- retry

  /** Attempt N's timeout: short at first, more patient later. */
  private timeoutFor(attempt: number): number {
    return Math.min(REST_TIMEOUT_MS * attempt, REST_TIMEOUT_MAX_MS);
  }

  /** Which attempt withRetry is on, so request closures can scale their timeout. */
  private attempt = 1;

  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      this.attempt = attempt;
      try {
        return await work();
      } catch (error) {
        last = error;
        if (!isRetryable(error) || attempt === RETRY_ATTEMPTS) break;
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    throw last instanceof Error ? last : new Error(this.redact(String(last)));
  }

  private withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TransportError(`${label}: ${TIMEOUT_MESSAGE} ${Math.round(ms / 1000)}s`));
      }, ms);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  // -------------------------------------------------------------- REST calls

  /**
   * One PostgREST call over `requestUrl`.
   *
   * `throw: false` is not optional: the default is `true`, and a thrown
   * `requestUrl` rejection carries no `RequestUrlResponse` — so the PostgREST
   * error body (`{"code":"PGRST116","message":…}`), the only thing that ever
   * explains what went wrong, is gone. Check `status` here instead.
   */
  private async rest(
    path: string,
    init: { method?: string; body?: string; prefer?: string } = {},
  ): Promise<RequestUrlResponse> {
    const method = init.method ?? "GET";
    const label = `${method} ${path.split("?")[0] ?? path}`;

    return this.withRetry(async () => {
      let res: RequestUrlResponse;
      try {
        res = await this.withTimeout(
          requestUrl({
            url: `${this.url}${path}`,
            method,
            // `contentType` is a top-level field, not a header — Obsidian sets
            // `Content-Type` from it, and `host`/`content-length` must be left
            // out entirely because Obsidian computes them.
            ...(init.body === undefined ? {} : { contentType: "application/json" }),
            headers: {
              ...this.authHeaders,
              Accept: "application/json",
              "User-Agent": USER_AGENT,
              ...(init.prefer === undefined ? {} : { Prefer: init.prefer }),
            },
            body: init.body,
            throw: false,
          }),
          this.timeoutFor(this.attempt),
          label,
        );
      } catch (error) {
        throw this.transportError(error, label);
      }
      if (res.status >= 400) throw this.httpError(res.status, res.text ?? "", label);
      return res;
    });
  }

  /**
   * `res.json` throws on an empty body, and PostgREST returns 204 with no body
   * for anything sent with `return=minimal`. Check before touching it.
   */
  private rows<T>(res: RequestUrlResponse): T[] {
    if (res.status === 204 || !res.text || res.text.length === 0) return [];
    const parsed: unknown = res.json;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  private documentsQuery(select: string, offset: number): string {
    return (
      `/rest/v1/documents?select=${select}` +
      `&vault=eq.${encodeURIComponent(this.vaultName)}` +
      `&order=source_ref.asc&limit=${PAGE}&offset=${offset}`
    );
  }

  /** Walk every page of one vault's documents. Tombstones included — a row with
   *  `deleted_at` set is the layer telling us to remove a file, so dropping it
   *  from the listing would make deletions invisible. */
  private async listPaged<T>(select: string): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await this.rest(this.documentsQuery(select, offset));
      const page = this.rows<T>(res);
      all.push(...page);
      if (page.length < PAGE) break;
    }
    return all;
  }

  // ------------------------------------------------------------------ public

  /**
   * A cheap round trip whose result is meant to be shown to a human verbatim.
   * Never throws, and never contains the key: the settings tab renders whatever
   * comes back, and a stack trace pasted into a screenshot is how keys leak.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (this.url.length === 0) return { ok: false, message: "No server URL set." };
    if (this.key.length === 0) return { ok: false, message: "No API key set." };
    if (this.vaultName.length === 0) return { ok: false, message: "No vault name set." };

    try {
      const res = await this.rest(
        `/rest/v1/documents?select=id&vault=eq.${encodeURIComponent(this.vaultName)}&limit=1`,
        { prefer: "count=exact" },
      );
      // PostgREST reports the total in `content-range` as `0-0/1234`.
      const range = header(res, "content-range");
      const total = /\/(\d+)\s*$/.exec(range ?? "")?.[1];
      const count =
        total === undefined
          ? "an unknown number of documents"
          : `${total} document${total === "1" ? "" : "s"}`;
      return {
        ok: true,
        message: `Connected to ${this.host}. This layer holds ${count} for vault "${this.vaultName}".`,
      };
    } catch (error) {
      return { ok: false, message: this.redact(messageOf(error)) };
    }
  }

  /** Every row for this vault, reduced to what planning a pass needs. Slim on
   *  purpose: a full listing of a 1.4 GB vault would put every note's text in
   *  memory at once, which is exactly what an iPhone cannot afford. */
  /**
   * Which vaults this Nucleus already holds, and how big each one is.
   *
   * Deliberately NOT filtered by the configured vault name — this is what setup
   * calls *before* a vault has been chosen, so the user can pick from a list
   * instead of typing a name that has to match exactly across devices.
   * Requiring that exact string was a design mistake: invisible, easy to miss
   * by a space or a capital, and the failure mode looks like "sync does
   * nothing" rather than like a typo.
   */
  async listVaults(): Promise<{ name: string; files: number }[]> {
    const counts = new Map<string, number>();
    for (let offset = 0; ; offset += PAGE) {
      const res = await this.rest(
        `/rest/v1/documents?select=vault,deleted_at&order=vault.asc&limit=${PAGE}&offset=${offset}`,
      );
      const page = this.rows<{ vault: string; deleted_at: string | null }>(res);
      for (const row of page) {
        if (row.deleted_at) continue;
        counts.set(row.vault, (counts.get(row.vault) ?? 0) + 1);
      }
      if (page.length < PAGE) break;
    }
    return [...counts.entries()]
      .map(([name, files]) => ({ name, files }))
      .sort((a, b) => b.files - a.files);
  }

  /**
   * The newest `updated_at` in this vault, or null if it is empty.
   *
   * One row, two columns — a few hundred bytes and one round trip. This is what
   * makes near-live sync affordable: polling this every few seconds costs
   * almost nothing, and a real sync only runs when the answer actually moves.
   * Polling the document list instead would pull megabytes each time.
   */
  async latestChange(): Promise<string | null> {
    const res = await this.rest(
      `/rest/v1/documents?select=updated_at` +
        `&vault=eq.${encodeURIComponent(this.vaultName)}` +
        `&order=updated_at.desc&limit=1`,
    );
    const rows = this.rows<{ updated_at: string }>(res);
    return rows[0]?.updated_at ?? null;
  }

  async listDocumentsSlim(): Promise<DocRowSlim[]> {
    return this.listPaged<DocRowSlim>("id,source_ref,kind,content_hash,storage_path,deleted_at");
  }

  /** Full rows — body, frontmatter, raw. Only a restore needs this much. */
  /**
   * Metadata for every row — enough to decide what to do, and nothing more.
   *
   * This exists because `listDocumentsFull` turned out to be a disaster once
   * plugins were synced: `select=*` pulls every note's text AND every plugin's
   * JavaScript, which measured **70 MB** for this vault, fetched on every
   * single sync before a byte of actual content moved. On a phone it also goes
   * through Obsidian's base64 bridge, so nearer 94 MB.
   *
   * Deciding needs `content_hash`, not the content. So take the metadata, work
   * out the short list, and fetch bodies only for files that are actually going
   * to be written — see `getDocumentBodies`.
   */
  async listDocumentsMeta(): Promise<DocumentRow[]> {
    return this.listPaged<DocumentRow>(
      "id,vault,source_ref,source_app,kind,title,content_hash,byte_size,storage_path,mime_type,file_modified_at,updated_at,deleted_at",
    );
  }

  /**
   * The text of specific notes, in batches.
   *
   * Batched by id rather than fetched one at a time: 400 individual round trips
   * on a 260 ms link is nearly two minutes of latency and nothing else.
   */
  async getDocumentBodies(
    ids: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, DocumentRow>> {
    const out = new Map<string, DocumentRow>();
    const BATCH = 40;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const res = await this.rest(
        `/rest/v1/documents?select=id,raw,body,frontmatter&id=in.(${slice.join(",")})`,
      );
      for (const row of this.rows<DocumentRow>(res)) out.set(row.id, row);
      // Report as we go. This step looked frozen because it is not one request
      // but fifteen, and for this vault it moves 32 MB — 30 of which is plugin
      // JavaScript, not notes.
      onProgress?.(Math.min(i + BATCH, ids.length), ids.length);
    }
    return out;
  }

  async listDocumentsFull(): Promise<DocumentRow[]> {
    return this.listPaged<DocumentRow>("*");
  }

  async getDocument(id: string): Promise<DocumentRow | null> {
    const res = await this.rest(
      `/rest/v1/documents?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    return this.rows<DocumentRow>(res)[0] ?? null;
  }

  /**
   * Insert-or-update by primary key. PostgREST only treats a POST as an upsert
   * when it gets both `on_conflict` and `resolution=merge-duplicates`; without
   * them a re-sync of an unchanged vault fails on every existing id.
   *
   * Batched because a pass can carry thousands of rows, and one enormous body
   * means one enormous thing to redo when the connection blinks.
   */
  async upsertDocuments(rows: Partial<DocumentRow>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      if (batch.length === 0) continue;
      await this.rest("/rest/v1/documents?on_conflict=id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify(batch),
      });
    }
  }

  /** Patch one row by id — renames and tombstones. */
  async patchDocument(id: string, patch: Partial<DocumentRow>): Promise<void> {
    await this.rest(`/rest/v1/documents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify(patch),
    });
  }

  // ----------------------------------------------------------------- storage

  /** Storage paths are `<vaultName>/<sha256>`; the hash may only ever be part
   *  of a path, so `encodeURI` (not `encodeURIComponent`) keeps the slash. */
  private objectUrl(storagePath: string): string {
    return `${this.url}/storage/v1/object/${BUCKET}/${encodeURI(storagePath)}`;
  }

  /** Object metadata, or null if the object is not there. Used both to answer
   *  `hasObject` and to size a download before committing to it. */
  private async objectInfo(storagePath: string): Promise<{ size: number | null } | null> {
    const label = `stat ${storagePath}`;
    return this.withRetry(async () => {
      let res: RequestUrlResponse;
      try {
        res = await this.withTimeout(
          requestUrl({
            url: `${this.url}/storage/v1/object/info/${BUCKET}/${encodeURI(storagePath)}`,
            method: "GET",
            headers: { ...this.authHeaders, "User-Agent": USER_AGENT },
            throw: false,
          }),
          this.timeoutFor(this.attempt),
          label,
        );
      } catch (error) {
        throw this.transportError(error, label);
      }
      if (res.status === 404 || res.status === 400) return null;
      if (res.status >= 400) throw this.httpError(res.status, res.text ?? "", label);

      // Supabase has moved `size` between the top level and `metadata` across
      // versions; read both and treat "not told" as unknown rather than zero.
      const info = (res.text?.length ?? 0) > 0 ? (res.json as Record<string, unknown>) : {};
      const meta = (info.metadata ?? {}) as Record<string, unknown>;
      const raw = info.size ?? meta.size;
      return { size: typeof raw === "number" ? raw : null };
    });
  }

  async hasObject(storagePath: string): Promise<boolean> {
    return (await this.objectInfo(storagePath)) !== null;
  }

  /**
   * Download attachment bytes.
   *
   * `fetch` by default (see the file header). The `requestUrl` fallback sizes
   * the object first and refuses anything past the cap, because the alternative
   * is not a slow download — it is Obsidian being killed mid-sync with no error
   * anyone can catch or report.
   */
  /**
   * `onProgress` reports bytes as they arrive, for the files where it matters.
   *
   * At this vault's measured 1.2 MB/s a 169 MB video takes about two and a half
   * minutes, and without progress that is indistinguishable from a hang — which
   * is exactly how it was reported: "stuck on 407 of 675". The bytes are read
   * through a stream rather than in one lump so there is something to report;
   * the request-bridge path below cannot stream at all, which is one more
   * reason large files should not go that way.
   */
  async getObject(
    storagePath: string,
    onProgress?: (received: number, total: number | null) => void,
  ): Promise<ArrayBuffer> {
    const label = `download ${storagePath}`;

    if (this.preferFetchForBinary) {
      return this.withRetry(async () => {
        let res: Response;
        try {
          res = await fetch(this.objectUrl(storagePath), { headers: this.authHeaders });
        } catch (error) {
          throw this.corsAwareTransportError(error, label);
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw this.httpError(res.status, detail, label);
        }
        if (!onProgress || !res.body) return res.arrayBuffer();

        const header = res.headers.get("content-length");
        const total = header ? Number(header) : null;
        // Fill ONE buffer, sized up front, rather than collecting chunks and
        // copying them into a second one at the end.
        //
        // The first version did the latter, which meant peak memory of twice
        // the file: 98 MB for a 49 MB video, and over 340 MB for the 169 MB
        // one. On an iPhone that is not a slow download, it is a dead app —
        // and it was observed doing exactly that, fetching a 49 MB file
        // completely and then re-requesting it three minutes later.
        //
        // Ironic, since this streaming path was added to SHOW progress. It
        // reported nicely right up to the crash.
        const reader = res.body.getReader();
        let received = 0;

        if (total !== null && Number.isFinite(total) && total > 0) {
          const out = new Uint8Array(total);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            // A server that sends more than it promised would corrupt memory
            // here, so stop rather than write past the end.
            if (received + value.byteLength > total) {
              throw new Error(
                `${label}: server sent more than the ${total} bytes it declared`,
              );
            }
            out.set(value, received);
            received += value.byteLength;
            onProgress(received, total);
          }
          return received === total ? out.buffer : out.slice(0, received).buffer;
        }

        // No content-length: fall back to collecting, which is the only option
        // left, and is why the header is preferred.
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
            onProgress(received, null);
          }
        }
        const out = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return out.buffer;
      });
    }

    const info = await this.objectInfo(storagePath);
    if (info === null) throw new Error(`${label}: the layer has no object at ${storagePath}.`);
    if (info.size !== null && info.size > this.maxRequestUrlBinaryBytes) {
      throw new Error(
        `${label}: refusing to download ${mb(info.size)} through Obsidian's request bridge (limit ${mb(this.maxRequestUrlBinaryBytes)}). ` +
          `Turn on "use fetch for large files" — it needs the server to allow Obsidian's origin on /storage/v1/ — or sync this file on desktop.`,
      );
    }

    return this.withRetry(async () => {
      let res: RequestUrlResponse;
      try {
        res = await this.withTimeout(
          requestUrl({
            url: this.objectUrl(storagePath),
            method: "GET",
            headers: { ...this.authHeaders, "User-Agent": USER_AGENT },
            throw: false,
          }),
          this.timeoutFor(this.attempt),
          label,
        );
      } catch (error) {
        throw this.transportError(error, label);
      }
      if (res.status >= 400) throw this.httpError(res.status, res.text ?? "", label);
      return res.arrayBuffer;
    });
  }

  /**
   * Upload attachment bytes.
   *
   * Paths are content-addressed (`<vaultName>/<sha256>`), so an object that is
   * already there is already the right bytes — the upload is skipped, not
   * repeated. That is what makes a moved or re-synced 169 MB video free.
   *
   * `bytes` is used as given and never copied: on a phone, a second reference
   * to a 100 MB buffer is the difference between a sync and a crash.
   */
  async putObject(
    storagePath: string,
    bytes: ArrayBuffer,
    mime: string,
  ): Promise<{ skipped: boolean }> {
    if (await this.hasObject(storagePath)) return { skipped: true };

    const label = `upload ${storagePath}`;
    const contentType = mime.length > 0 ? mime : "application/octet-stream";
    // `x-upsert` only matters if two devices race on the same content hash —
    // identical bytes, so overwriting is harmless and a 409 would not be.
    const headers = { ...this.authHeaders, "x-upsert": "true" };

    if (this.preferFetchForBinary) {
      await this.withRetry(async () => {
        let res: Response;
        try {
          res = await fetch(this.objectUrl(storagePath), {
            method: "POST",
            headers: { ...headers, "Content-Type": contentType },
            body: bytes,
          });
        } catch (error) {
          throw this.corsAwareTransportError(error, label);
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw this.httpError(res.status, detail, label);
        }
      });
      return { skipped: false };
    }

    if (bytes.byteLength > this.maxRequestUrlBinaryBytes) {
      throw new Error(
        `${label}: refusing to upload ${mb(bytes.byteLength)} through Obsidian's request bridge (limit ${mb(this.maxRequestUrlBinaryBytes)}). ` +
          `That path base64-encodes the whole file across the mobile bridge and takes the app down somewhere past 20 MB. ` +
          `Turn on "use fetch for large files", or sync this file on desktop.`,
      );
    }

    await this.withRetry(async () => {
      let res: RequestUrlResponse;
      try {
        res = await this.withTimeout(
          requestUrl({
            url: this.objectUrl(storagePath),
            method: "POST",
            contentType,
            headers: { ...headers, "User-Agent": USER_AGENT },
            body: bytes,
            throw: false,
          }),
          this.timeoutFor(this.attempt),
          label,
        );
      } catch (error) {
        throw this.transportError(error, label);
      }
      if (res.status >= 400) throw this.httpError(res.status, res.text ?? "", label);
    });
    return { skipped: false };
  }

  /**
   * A failed `fetch` inside a WebView says only "Load failed" / "Failed to
   * fetch" whether the network is down or the server declined our origin — the
   * page is never told which. Say both, so the user has somewhere to look.
   */
  private corsAwareTransportError(error: unknown, label: string): Error {
    const base = this.transportError(error, label);
    if (!(base instanceof TransportError)) return base;
    return new TransportError(
      `${base.message} If the server is up, it may be refusing Obsidian's origin on /storage/v1/ — that looks identical from here. Turning off "use fetch for large files" falls back to Obsidian's own transport (small files only).`,
    );
  }

  // ------------------------------------------------------------------- state

  /**
   * The connector's own bookkeeping — `nucleus.identity`, sync watermarks —
   * kept in `app_obsidian.state`, exposed as `public.obsidian_state`. Returns
   * the stored value itself, not the row wrapping it.
   */
  async getState(key: string): Promise<unknown | null> {
    const res = await this.rest(
      `/rest/v1/obsidian_state?select=value&key=eq.${encodeURIComponent(key)}&limit=1`,
    );
    const row = this.rows<{ value?: unknown }>(res)[0];
    return row?.value ?? null;
  }

  async putState(key: string, value: unknown): Promise<void> {
    await this.rest("/rest/v1/obsidian_state?on_conflict=key", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
    });
  }
}
