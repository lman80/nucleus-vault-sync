# SPEC-API.md — Obsidian Plugin API, verified for the Nucleus vault-sync plugin

**Purpose.** Implementation spec for an Obsidian plugin that syncs a vault against a self-hosted
PostgREST + Supabase-storage HTTP API, and must run on **iOS/iPadOS as well as desktop**.
This document is API reference and constraints only — no plugin source code.

**Verified on (checked 2026-08-03):**

| Thing | Version / source |
| --- | --- |
| `obsidian.d.ts` (typings, `master`) | **1.13.2** — https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts |
| `obsidian` on npm (`latest`) | **1.13.1** — https://registry.npmjs.org/obsidian |
| Obsidian desktop latest / minimum | **1.13.4** / `minimumVersion` **1.1.9** — https://github.com/obsidianmd/obsidian-releases/blob/master/desktop-releases.json |
| Official sample plugin | https://github.com/obsidianmd/obsidian-sample-plugin (`master`) |
| Remotely Save | v0.5.25, `isDesktopOnly: false` — https://github.com/remotely-save/remotely-save |
| Self-hosted LiveSync | v1.0.2, `minAppVersion` 1.7.2, `isDesktopOnly: false` — https://github.com/vrtmrz/obsidian-livesync |

All type signatures below are quoted **verbatim** from `obsidian.d.ts` at the version above
(comments stripped). Where I could not verify something, it is marked **UNVERIFIED**.

---

## 1. HTTP on mobile — `requestUrl` is mandatory in practice

### 1.1 Does `fetch` work?

`fetch` **exists** on every platform (Electron renderer on desktop, WKWebView on iOS, Android
WebView) — but it is **subject to CORS**, and the page origin differs per platform:

| Platform | Origin the server sees |
| --- | --- |
| Desktop (Electron) | `app://obsidian.md` |
| iOS / iPadOS (Capacitor / WKWebView) | `capacitor://localhost` |
| Android | `http://localhost` |

> "Obsidian running on an iPad sends the Origin header `capacitor://localhost` in fetch requests,
> while the Windows version sends `app://obsidian.md`."
> — https://forum.obsidian.md/t/is-it-possible-to-change-origin-header-sent-within-http-request-from-mobile-app/68970

`Access-Control-Allow-Origin` can only carry **one** value, so a server must echo the request
Origin (or use `*`) to satisfy both. `*` is incompatible with credentialed requests, and PostgREST
sends `Authorization`, which triggers a **preflight** `OPTIONS` on every call.

`requestUrl` is the official escape hatch. From the typings:

> "Similar to `fetch()`, request a URL using HTTP/HTTPS, **without any CORS restrictions**."

**Decision for this plugin:** use `requestUrl` as the default transport for all PostgREST calls and
all small/medium storage objects. Keep a `fetch` code path *only* as an opt-in fallback for large
binary transfers on mobile (see §1.5), and only if the Nucleus server is configured to allow the
two mobile origins.

### 1.2 Exact signatures (verbatim, `obsidian.d.ts` 1.13.2)

```ts
/**
 * Similar to `fetch()`, request a URL using HTTP/HTTPS, without any CORS restrictions.
 * Returns the text value of the response.
 * @public
 * @since 0.12.11
 */
export function request(request: RequestUrlParam | string): Promise<string>;

/**
 * Similar to `fetch()`, request a URL using HTTP/HTTPS, without any CORS restrictions.
 * @public
 */
export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise;

/** @public */
export interface RequestUrlParam {
    /** @public */
    url: string;
    /** @public */
    method?: string;
    /** @public */
    contentType?: string;
    /** @public */
    body?: string | ArrayBuffer;
    /** @public */
    headers?: Record<string, string>;
    /**
     * Whether to throw an error when the status code is 400+
     * Defaults to true
     * @public
     */
    throw?: boolean;
}

/** @public */
export interface RequestUrlResponse {
    /** @public */
    status: number;
    /** @public */
    headers: Record<string, string>;
    /** @public */
    arrayBuffer: ArrayBuffer;
    /** @public */
    json: any;
    /** @public */
    text: string;
}

/** @public */
export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
    /** @public */
    arrayBuffer: Promise<ArrayBuffer>;
    /** @public */
    json: Promise<any>;
    /** @public */
    text: Promise<string>;
}
```

Note `RequestUrlResponsePromise` — you may write `await requestUrl(p).json` or
`await requestUrl(p).arrayBuffer` and skip the intermediate response object.

### 1.3 Headers, JSON body, and the PostgREST shape

```ts
import { requestUrl, type RequestUrlParam } from 'obsidian';

const p: RequestUrlParam = {
  url: `${baseUrl}/rest/v1/vault_files?select=path,sha256,mtime`,
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${settings.apiKey}`,
    'apikey': settings.apiKey,          // Supabase/PostgREST convention
    'Accept': 'application/json',
    'Accept-Profile': 'app_daily_stream', // PostgREST schema selector, if used
  },
  throw: false,                          // see §1.4 — always do this
};
const res = await requestUrl(p);
```

- `headers` is a flat `Record<string, string>`. There is **no** `Headers` object, no multi-value
  headers, and no cookie jar.
- `contentType` is a **separate top-level field**, not a header. Obsidian sets `Content-Type` from
  it. Setting both `contentType` and a `Content-Type` header is redundant; real plugins set
  `contentType` and strip `content-type` from the header map to avoid duplication.
- **Strip `host` and `content-length` from your header map.** Obsidian computes them; passing them
  through breaks requests. This is what Remotely Save does in both its S3 and WebDAV adapters
  (`src/fsS3.ts`, `src/fsWebdav.ts`).
- **Lowercase response header keys before reading them.** Casing is not guaranteed to be stable
  across platforms; Remotely Save normalises with an `objKeyToLower` helper in both adapters.

### 1.4 How errors and status codes surface

- `throw` defaults to **`true`**: any status **≥ 400 rejects the promise**, and the rejection does
  **not** give you a usable `RequestUrlResponse` — you lose the PostgREST error body
  (`{"code":"PGRST116","message":...}`), which is exactly the thing you need to debug a sync.
- **Always pass `throw: false`** and branch on `res.status` yourself. Remotely Save's WebDAV patcher
  does exactly this (`throw: false`, then inspects `r.status`).
- Network-level failures (DNS, TLS, connection refused) **reject regardless of `throw`**. Wrap every
  call in try/catch *and* check `res.status`.
- `res.json` **throws when the body is not JSON**. PostgREST `204 No Content` (e.g. `DELETE`,
  or `POST` without `Prefer: return=representation`) has an empty body — check `res.status` and
  `res.text.length` before touching `res.json`.
- There is **no `AbortSignal` / no cancellation / no timeout parameter**. Implement your own timeout
  by racing the promise (Remotely Save's `ObsHttpHandler` races `requestUrl(param)` against a
  `requestTimeout(ms)` promise). A timed-out request keeps running in the background.
- There is **no streaming and no progress callback**. The whole body is buffered.
  Open feature request: https://forum.obsidian.md/t/support-streaming-the-request-and-requesturl-response-body/87381
- `request()` (singular) returns only the response text. Do not use it — you cannot see the status.

### 1.5 Binary bodies — the single biggest mobile constraint

**Sending binary:** set `body` to a real `ArrayBuffer`.

```ts
const bytes: ArrayBuffer = await this.app.vault.readBinary(file);
const res = await requestUrl({
  url: `${baseUrl}/storage/v1/object/${bucket}/${encodeURI(objectPath)}`,
  method: 'POST',
  headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'x-upsert': 'true' },
  contentType: 'application/octet-stream',
  body: bytes,
  throw: false,
});
```

**A `Uint8Array` is not an `ArrayBuffer`.** If you hold a typed-array view, convert it first —
Remotely Save does this explicitly before every request:

```ts
// src/fsS3.ts
let transformedBody: any = body;
if (ArrayBuffer.isView(body)) {
  transformedBody = bufferToArrayBuffer(body);   // view.buffer.slice(byteOffset, byteOffset + byteLength)
}
```

**Receiving binary:** `res.arrayBuffer` (already an `ArrayBuffer`, no `await` on a method).

**The hard limit on mobile.** `requestUrl` on iOS/Android marshals the body across the JS↔native
bridge **as base64**, because the bridge cannot pass byte arrays. Obsidian devs confirmed this:

> "the data is sent to the backend via base64 because our app to native interface can't pass byte
> arrays" — and, on the fix: "Unfortunately this won't be fixed anytime soon" (Oct 2024).
> — https://forum.obsidian.md/t/bug-mobile-requesturl-has-performance-issue/84177

Reported symptom: **uploads/downloads of roughly ≥20–50 MB crash the mobile app (OOM)**, while a
native `fetch` of the same 100 MB buffer succeeds on the same iPhone. Base64 alone inflates the
payload ~33%, and both the encoded string and the decoded buffer are resident simultaneously.

**Consequences for this plugin (mandatory):**

1. Set a configurable **`maxMobileBinaryBytes`, default ~8 MB**, well under the danger zone. Skip
   (and surface in a sync report) any attachment above it on `Platform.isMobileApp`.
2. Prefer **PostgREST/JSON + text notes** on mobile; treat large attachments as desktop-only work.
3. If large mobile binaries are actually required, use **Supabase Storage resumable/TUS uploads in
   chunks** so no single `requestUrl` body is large — **UNVERIFIED** that TUS works cleanly through
   `requestUrl`; needs a device test.
4. Alternative: configure the Nucleus server's CORS to allow `capacitor://localhost` and
   `http://localhost` and use plain `fetch` for large binaries only. This is the documented
   workaround from the thread above.
5. Never hold two copies of a large buffer. Read → upload → drop the reference; do not build
   arrays of file contents.

---

## 2. Vault file access

### 2.1 `vault` vs `vault.adapter` — pick correctly

Official guidance (https://docs.obsidian.md/Plugins/Vault, and the Plugin guidelines):

> "The Vault API has two main advantages over the adapter. **Performance**: The Vault API has a
> caching layer… **[Serialization]**: The Vault API performs file operations serially to avoid any
> race conditions, for example when reading a file that is being written to at the same time."

> "The Vault API only allows access to the files visible inside the app; files included in **hidden
> folders can only be accessed using the Adapter API**."

**Rule for this plugin:**

- Use **`vault.*`** for everything under normal vault paths (notes, attachments). You get caching,
  serialised writes, and correct `TFile`/`TFolder` bookkeeping and events.
- Use **`vault.adapter.*`** only for: (a) `exists()`, `stat()`, `list()`, `mkdir()` — which have no
  `vault` equivalent; (b) anything inside `.obsidian/` or another dot-folder (e.g. your own sync
  state/cursor file at `${vault.configDir}/plugins/<id>/sync-state.json`); (c) writing a file whose
  `TFile` you don't have and don't want to create-vs-modify branch on.
- Never touch `.obsidian` through `vault.*` — it is invisible to the Vault layer.
- `vault.configDir` (`string`) gives you the config folder name (`.obsidian`, or a custom one).
  Do **not** hardcode `.obsidian`.

### 2.2 `Vault` — verbatim signatures

```ts
export class Vault extends Events {
    adapter: DataAdapter;
    configDir: string;
    getName(): string;
    getFileByPath(path: string): TFile | null;
    getFolderByPath(path: string): TFolder | null;
    getAbstractFileByPath(path: string): TAbstractFile | null;
    getRoot(): TFolder;
    create(path: string, data: string, options?: DataWriteOptions): Promise<TFile>;
    createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<TFile>;
    createFolder(path: string): Promise<TFolder>;
    read(file: TFile): Promise<string>;
    cachedRead(file: TFile): Promise<string>;
    readBinary(file: TFile): Promise<ArrayBuffer>;
    getResourcePath(file: TFile): string;
    delete(file: TAbstractFile, force?: boolean): Promise<void>;
    trash(file: TAbstractFile, system: boolean): Promise<void>;
    rename(file: TAbstractFile, newPath: string): Promise<void>;
    modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void>;
    modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
    append(file: TFile, data: string, options?: DataWriteOptions): Promise<void>;
    appendBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
    process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
    copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T>;
    getAllLoadedFiles(): TAbstractFile[];
    getAllFolders(includeRoot?: boolean): TFolder[];
    static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any): void;
    getMarkdownFiles(): TFile[];
    getFiles(): TFile[];
    on(name: 'create', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
    on(name: 'modify', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
    on(name: 'delete', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
    on(name: 'rename', callback: (file: TAbstractFile, oldPath: string) => any, ctx?: any): EventRef;
}

export interface DataWriteOptions {
    ctime?: number;   // unix ms
    mtime?: number;   // unix ms
}
```

### 2.3 Listing files

- **`vault.getFiles(): TFile[]`** — every file in the vault (notes *and* attachments: PDFs, images,
  audio). **This is what a sync plugin wants.**
- **`vault.getMarkdownFiles(): TFile[]`** — `.md` only. Use only if the plugin is notes-only.
- `vault.getAllLoadedFiles(): TAbstractFile[]` — files *and* folders; Remotely Save uses this to
  enumerate the local tree (`src/fsLocal.ts:44`) because it needs folders too.
- `vault.getAllFolders(includeRoot?)` — folders only.
- **Do not** walk `getFiles()` looking for a path. Use `getFileByPath` / `getFolderByPath` /
  `getAbstractFileByPath` — the Plugin guidelines call the linear scan out explicitly as an
  anti-pattern.
- Neither list includes anything under `.obsidian/`. For that, `vault.adapter.list(path)`.

`TFile` carries what you need for change detection:

```ts
file.path        // 'folder/note.md', vault-relative, '/'-separated, no leading slash
file.name        // 'note.md'
file.basename    // 'note'
file.extension   // 'md'
file.stat.mtime  // unix ms
file.stat.ctime  // unix ms
file.stat.size   // bytes
```

`TFile.stat.mtime` is Obsidian's cached view. For an authoritative value use
`vault.adapter.stat(path)`. Remotely Save wraps that in a `statFix()` helper because `ctime`/`mtime`
can come back `undefined`/`NaN`, and folder `size` can be missing (`src/misc.ts:422`) — **do the
same defensive normalisation**, especially on mobile.

### 2.4 Reading

- **`vault.read(file)`** — fresh read from disk. Use this when you are about to **write back**.
- **`vault.cachedRead(file)`** — reads a cached copy. Docs: use it "if you only want to display the
  content to the user."
  > "The only difference between `cachedRead()` and `read()` is when the file was modified outside
  > of Obsidian just before the plugin reads it."
- **For a sync plugin: use `vault.read()`** when the content is about to be hashed and pushed as the
  authoritative version, and `cachedRead()` only for cheap read-only passes (e.g. building a preview
  or a diff summary). Anything else risks uploading stale bytes right after an external Obsidian
  Sync/iCloud write.
- **`vault.readBinary(file): Promise<ArrayBuffer>`** for attachments. Note there is no
  `cachedReadBinary`.

For read-modify-write on a note, the guidelines are explicit:

> "Always prefer `Vault.process()` over `Vault.read()`/`Vault.modify()` to avoid unintentional loss
> of data."

`process(file, fn)` takes a **synchronous** `(data: string) => string`. If your transform is async
(it will be — you're calling the server), do `cachedRead()` → compute → `process()` and **re-verify
inside the callback that the data still matches what you computed from**; if it changed, bail and
re-run. This is the documented pattern and it is the only race-safe one.

### 2.5 Creating text and binary files, including missing nested folders

**`vault.create` / `vault.createBinary` throw if the file already exists**, and they do **not**
create missing parent folders. `vault.createFolder(path)` **throws if the folder already exists**
(typings: `@throws Error if folder already exists`, `@since 1.4.0`).

**UNVERIFIED:** whether `vault.createFolder('a/b/c')` creates intermediate `a` and `a/b`. Do not
rely on it. The pattern every production sync plugin uses is an explicit level-by-level `mkdir -p`
via the adapter (Remotely Save `src/misc.ts:49–82`):

```ts
// "a/b/c/d/e.txt" => ["a", "a/b", "a/b/c", "a/b/c/d"]
export const getFolderLevels = (x: string, addEndingSlash = false) => { /* split on '/' */ };

export const mkdirpInVault = async (thePath: string, vault: Vault) => {
  const foldersToBuild = getFolderLevels(thePath);
  for (const folder of foldersToBuild) {
    const r = await vault.adapter.exists(folder);
    if (!r) {
      await vault.adapter.mkdir(folder);
    }
  }
};
```

**Prescribed write helper for this plugin:**

```
normalizePath(path)
ensure parent folders via mkdirpInVault()
const existing = vault.getFileByPath(path)
if (existing)  await vault.modifyBinary(existing, buf, { mtime })   // or modify() for text
else           await vault.createBinary(path, buf, { mtime })       // or create()
```

Set `{ mtime, ctime }` from the server row so the next sync pass compares like with like. Both
`create*` and `modify*` accept `DataWriteOptions`.

`normalizePath(path: string): string` (exported from `obsidian`) — run **every** server-supplied
path through it before use. It normalises slashes/Unicode. Paths are vault-relative, `/`-separated,
**no leading slash** (`'notes/2026/a.md'`, not `'/notes/2026/a.md'`).

### 2.6 Modifying

- `vault.modify(file, data, options?)` — replace text content.
- `vault.modifyBinary(file, data, options?)` — replace binary content.
- `vault.process(file, fn, options?)` — race-safe text transform (preferred, see §2.4).
- `vault.append` / `vault.appendBinary` — append without a full read.
- Adapter equivalents (`adapter.write`, `adapter.writeBinary`) are **upserts**: they create or
  overwrite in one call and don't need a `TFile`. Remotely Save writes local files exclusively this
  way (`this.vault.adapter.writeBinary(key, content, { mtime, ctime })`, `src/fsLocal.ts:159`) — a
  legitimate simplification for a sync engine, at the cost of skipping the Vault cache layer.

### 2.7 Renaming — use `fileManager.renameFile`, not `vault.rename`

```ts
export class FileManager {
    getNewFileParent(sourcePath: string, newFilePath?: string): TFolder;
    renameFile(file: TAbstractFile, newPath: string): Promise<void>;
    promptForDeletion(file: TAbstractFile): Promise<boolean>;
    trashFile(file: TAbstractFile): Promise<void>;   // @since 1.6.6
    generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string;
    processFrontMatter(file: TFile, fn: (frontmatter: any) => void, options?: DataWriteOptions): Promise<void>;
    getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string>;
}
```

- **`app.fileManager.renameFile(file, newPath)`** — moves/renames **and updates every wikilink and
  markdown link in the vault** that pointed at it. This is what the user expects.
- `vault.rename(file, newPath)` — raw move, **links are left dangling**. Only use it when you are
  deliberately replaying a rename that already happened remotely and links were rewritten remotely
  too.
- `app.fileManager.processFrontMatter(file, fn)` is the correct way to stamp sync metadata
  (`nucleus_id`, `synced_at`) into YAML frontmatter without hand-rolling a parser.

### 2.8 Deleting — three options, pick `fileManager.trashFile`

```ts
delete(file: TAbstractFile, force?: boolean): Promise<void>;   // "Deletes the file completely."
trash(file: TAbstractFile, system: boolean): Promise<void>;    // system trash, else local .trash
trashFile(file: TAbstractFile): Promise<void>;                 // FileManager, @since 1.6.6
```

- **`app.fileManager.trashFile(file)`** — typings: "Remove a file or a folder from the vault
  according **the user's preferred 'trash' options** (either moving the file to `.trash/` or the OS
  trash bin)." **This is the right call for sync-driven deletions.** Requires `minAppVersion` ≥
  `1.6.6`.
- `vault.trash(file, system)` — you choose the mechanism. On iOS there is no OS trash; system trash
  falls back to local. Remotely Save codes the fallback by hand:
  `if (!(await adapter.trashSystem(key))) await adapter.trashLocal(key);` (`src/fsLocal.ts:176–181`).
- `vault.delete(file, force?)` — **irreversible**. Never use it for a remote-driven delete. A bad
  sync decision then destroys user data with no undo. Reserve it (if at all) for the plugin's own
  temp files, behind an explicit setting.

### 2.9 `DataAdapter` — verbatim

```ts
export interface DataAdapter {
    getName(): string;
    exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
    stat(normalizedPath: string): Promise<Stat | null>;
    list(normalizedPath: string): Promise<ListedFiles>;
    read(normalizedPath: string): Promise<string>;
    readBinary(normalizedPath: string): Promise<ArrayBuffer>;
    write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
    writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
    append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
    appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
    process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
    getResourcePath(normalizedPath: string): string;
    mkdir(normalizedPath: string): Promise<void>;
    trashSystem(normalizedPath: string): Promise<boolean>;
    trashLocal(normalizedPath: string): Promise<void>;
    rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
    remove(normalizedPath: string): Promise<void>;
    rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
    copy(normalizedPath: string, normalizedNewPath: string): Promise<void>;
}

export interface Stat {
    type: 'file' | 'folder';
    ctime: number;   // unix
    mtime: number;   // unix
    size: number;    // bytes
}

export interface ListedFiles { files: string[]; folders: string[]; }
```

**`FileSystemAdapter` is desktop-only.** It adds `getBasePath()`, `getFullPath()`, `getFilePath()`,
`static readLocalFile()`. On mobile the adapter is a Capacitor-backed implementation and is **not**
an instance of `FileSystemAdapter`. Guard every use:

```ts
import { FileSystemAdapter } from 'obsidian';
const a = this.app.vault.adapter;
if (a instanceof FileSystemAdapter) { const abs = a.getBasePath(); /* desktop only */ }
```

There is **no way to get an absolute filesystem path on iOS**, and no reason to want one.

### 2.10 Method-location summary

| Operation | Call | Where |
| --- | --- | --- |
| list all files | `getFiles()` | `vault` |
| list markdown only | `getMarkdownFiles()` | `vault` |
| list files + folders | `getAllLoadedFiles()` | `vault` |
| list a dot-folder (`.obsidian`) | `list(path)` | **`vault.adapter`** |
| look up by path | `getFileByPath` / `getFolderByPath` / `getAbstractFileByPath` | `vault` |
| read text (about to write back) | `read(file)` | `vault` |
| read text (display only) | `cachedRead(file)` | `vault` |
| read binary | `readBinary(file)` | `vault` |
| read from `.obsidian` | `read` / `readBinary(path)` | **`vault.adapter`** |
| create text / binary | `create` / `createBinary` | `vault` |
| modify text / binary | `modify` / `modifyBinary` / `process` | `vault` |
| upsert by path (no `TFile`) | `write` / `writeBinary` | **`vault.adapter`** |
| create one folder | `createFolder(path)` | `vault` |
| `mkdir -p` | `exists` + `mkdir` per level | **`vault.adapter`** |
| does path exist | `exists(path)` | **`vault.adapter`** |
| authoritative mtime/size | `stat(path)` | **`vault.adapter`** |
| rename/move + fix links | `renameFile(file, newPath)` | **`app.fileManager`** |
| rename/move raw | `rename(file, newPath)` | `vault` |
| delete respecting user prefs | `trashFile(file)` | **`app.fileManager`** |
| delete to trash, explicit | `trash(file, system)` | `vault` |
| delete permanently | `delete(file, force?)` | `vault` — **avoid** |
| edit YAML frontmatter | `processFrontMatter(file, fn)` | **`app.fileManager`** |

---

## 3. `manifest.json`

`PluginManifest` (verbatim), showing which fields are optional:

```ts
export interface PluginManifest {
    dir?: string;              // set by Obsidian at runtime, not authored
    id: string;
    name: string;
    author: string;
    version: string;
    minAppVersion: string;
    description: string;
    authorUrl?: string;
    isDesktopOnly?: boolean;
}
```

Official sample plugin `manifest.json` (verbatim), which is the canonical field set for 2026:

```json
{
	"id": "sample-plugin",
	"name": "Sample Plugin",
	"version": "1.0.0",
	"minAppVersion": "1.0.0",
	"description": "Demonstrates some of the capabilities of the Obsidian API.",
	"author": "Obsidian",
	"authorUrl": "https://obsidian.md",
	"fundingUrl": "https://obsidian.md/pricing",
	"isDesktopOnly": false
}
```

Rules, from the official `AGENTS.md` in that repo:

- Required: `id`, `name`, `version` (SemVer `x.y.z`), `minAppVersion`, `description`,
  `isDesktopOnly`. Optional: `author`, `authorUrl`, `fundingUrl` (string **or** map).
- "Never change `id` after release. Treat it as stable API." For local dev the `id` **must match the
  folder name** under `.obsidian/plugins/`.
- "Keep `minAppVersion` accurate when using newer APIs."
- Canonical validation rules live in
  https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml
- `description` should be a single sentence; the community-list validator rejects descriptions that
  begin with "This plugin…" / "A plugin that…" and ones over ~250 chars.
- `fundingUrl` is **not** in the `PluginManifest` typing but **is** in the official sample manifest
  and accepted by the validator. Harmless to include; not required.

**Proposed manifest for this plugin:**

```json
{
	"id": "nucleus-vault-sync",
	"name": "Nucleus Vault Sync",
	"version": "0.1.0",
	"minAppVersion": "1.6.6",
	"description": "Syncs this vault with a self-hosted Nucleus PostgREST API.",
	"author": "Ashton Miller",
	"isDesktopOnly": false
}
```

**`minAppVersion` conventions (2026).** Set it to the lowest version that has every API you call —
not "latest", and not `1.0.0` by default. For this plugin:

| API used | Introduced |
| --- | --- |
| `requestUrl` | 0.13.26 desktop / iOS 1.1.1 / Android 1.2.1 (per Remotely Save's `baseTypesObs.ts`) |
| `Workspace.onLayoutReady` | 0.11.0 |
| `registerInterval` | 0.13.8 |
| `Vault.createFolder` | 1.4.0 |
| **`FileManager.trashFile`** | **1.6.6** ← the binding constraint |
| `Vault.process` / `getFileByPath` | 1.x (present well before 1.6.6) |

So **`"minAppVersion": "1.6.6"`**. Bump it if you adopt anything newer. Obsidian's current minimum
supported app version is 1.1.9, so 1.6.6 is a mild but reasonable floor. For comparison: Remotely
Save ships `0.13.21`; LiveSync ships `1.7.2`.

`versions.json` maps *plugin version → minimum app version* so older Obsidian installs can fetch an
older plugin build:

```json
{ "0.1.0": "1.6.6" }
```

`npm version patch|minor|major` runs `version-bump.mjs`, which updates `manifest.json` and
`versions.json` automatically.

---

## 4. Build setup — current official standard

The 2026 sample plugin has moved to **`src/main.ts`** as the entry point (it used to be `main.ts` at
the repo root), ESM config files (`"type": "module"`), and flat-config ESLint with
`eslint-plugin-obsidianmd`.

Repo layout of the official sample:

```
.editorconfig  .github/  .gitignore  .npmrc  AGENTS.md  LICENSE  README.md
esbuild.config.mjs  eslint.config.mts  manifest.json  package.json
package-lock.json  src/  styles.css  tsconfig.json  version-bump.mjs  versions.json
```

### 4.1 `esbuild.config.mjs` — verbatim from the official sample plugin

```js
import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...builtinModules,
	],
	format: 'cjs',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
```

Key points: output is **CommonJS** (`format: 'cjs'`) to a single `main.js`; `obsidian`, `electron`,
CodeMirror/Lezer, and all Node builtins are **external** (Obsidian provides them, or they don't
exist on mobile); `target: 'es2021'`.

> **Mobile-critical:** `...builtinModules` being external means that if any dependency you add
> `require`s `crypto`/`fs`/`buffer`, the bundle will contain a live `require('crypto')` that
> **throws at runtime on iOS**. See §7.

### 4.2 `package.json` — verbatim

```json
{
	"name": "obsidian-sample-plugin",
	"version": "1.0.0",
	"description": "This is a sample plugin for Obsidian (https://obsidian.md)",
	"main": "main.js",
	"type": "module",
	"scripts": {
		"dev": "node esbuild.config.mjs",
		"build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
		"version": "node version-bump.mjs && git add manifest.json versions.json",
		"lint": "eslint ."
	},
	"keywords": [],
	"license": "0-BSD",
	"devDependencies": {
		"@eslint/js": "^9.39.4",
		"@types/node": "^22.15.17",
		"esbuild": "0.25.5",
		"eslint": "^9.39.4",
		"eslint-plugin-obsidianmd": "^0.4.0",
		"globals": "^17.6.0",
		"jiti": "^2.6.1",
		"obsidian": "latest",
		"typescript": "^5.8.3",
		"typescript-eslint": "^8.59.1"
	}
}
```

### 4.3 `tsconfig.json` — verbatim

```json
{
	"compilerOptions": {
		"inlineSourceMap": true,
		"inlineSources": true,
		"module": "ESNext",
		"target": "ES2021",
		"strict": true,
		"noImplicitReturns": true,
		"noFallthroughCasesInSwitch": true,
		"noUncheckedIndexedAccess": true,
		"moduleResolution": "node",
		"isolatedModules": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"allowSyntheticDefaultImports": true,
		"lib": ["ES2021", "DOM"]
	},
	"include": ["src/**/*.ts"]
}
```

Note `"lib": ["ES2021", "DOM"]` — **no `"node"` types in `lib`**, which is what stops you writing
Node-only code by accident. (`@types/node` is still a devDependency, for the build scripts.)

### 4.4 `eslint.config.mts` — verbatim

```ts
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules', 'dist', 'esbuild.config.mjs', 'version-bump.mjs',
		'versions.json', 'main.js', 'package.json', 'package-lock.json', 'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: { allowDefaultProject: ['eslint.config.mts', 'manifest.json'] },
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
);
```

`eslint-plugin-obsidianmd` encodes the Obsidian-specific rules (no `innerHTML`, no global `app`, use
`getFileByPath` instead of scanning, use `register*` helpers, etc.). **Run it** — it catches most of
the review-blocking mistakes for free.

### 4.5 `version-bump.mjs`, `.npmrc`, `.gitignore` — verbatim

```js
// version-bump.mjs
import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
```

`.npmrc`: `tag-version-prefix=""` (release tags are `1.0.0`, **not** `v1.0.0`).

`.gitignore` notably ignores **`main.js`**, `*.map`, and **`data.json`** — never commit built output
or your settings file (which contains the API key, see §5.3).

### 4.6 Build hygiene from the official `AGENTS.md`

- "Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages."
- "Bundle everything into `main.js` (no unbundled runtime deps)."
- "Avoid Node/Electron APIs if you want mobile compatibility."
- Split code into modules; keep `main.ts` to lifecycle only; ~200–300 lines per file.
- Release artifacts must be at the top level of the plugin folder: `main.js`, `manifest.json`,
  `styles.css`.

---

## 5. Settings

### 5.1 Types (verbatim)

```ts
export abstract class Plugin extends Component {
    app: App;
    manifest: PluginManifest;
    settings?: unknown;
    loadData(): Promise<any>;
    saveData(data: any): Promise<void>;
    addSettingTab(settingTab: PluginSettingTab): void;
    onExternalSettingsChange?(): any;
    // …addCommand, addRibbonIcon, registerEvent, registerInterval, registerDomEvent, …
}

export abstract class PluginSettingTab extends SettingTab {
    constructor(app: App, plugin: Plugin);
    // @since 1.13.0 — declarative settings, optional:
    getSettingDefinitions(): SettingDefinitionItem[];
    getControlValue(key: string): unknown;
    setControlValue(key: string, value: unknown): void | Promise<void>;
}

export abstract class SettingTab {
    app: App;
    containerEl: HTMLElement;
    display(): void;
    hide(): void;
}
```

`Setting` builder (verbatim, abridged to the useful members):

```ts
export class Setting {
    constructor(containerEl: HTMLElement);
    setName(name: string | DocumentFragment): this;
    setDesc(desc: string | DocumentFragment): this;
    setHeading(): this;
    setClass(cls: string): this;
    setDisabled(disabled: boolean): this;
    setTooltip(tooltip: string, options?: TooltipOptions): this;
    setErrorMessage(message: string | null): this;
    addText(cb: (component: TextComponent) => any): this;
    addTextArea(cb: (component: TextAreaComponent) => any): this;
    addToggle(cb: (component: ToggleComponent) => any): this;
    addDropdown(cb: (component: DropdownComponent) => any): this;
    addSlider(cb: (component: SliderComponent) => any): this;
    addButton(cb: (component: ButtonComponent) => any): this;
    addExtraButton(cb: (component: ExtraButtonComponent) => any): this;
    addSearch(cb: (component: SearchComponent) => any): this;
    addProgressBar(cb: (component: ProgressBarComponent) => any): this;
    // …addColorPicker, addMomentFormat, addDisplayValue, addComponent, clear, then
}
```

### 5.2 Canonical pattern — verbatim from `obsidian-sample-plugin/src/settings.ts`

```ts
import { App, PluginSettingTab, Setting } from 'obsidian';
import MyPlugin from './main';

export interface MyPluginSettings {
	mySetting: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Settings #1')
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder('Enter your secret')
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
```

And in `main.ts`:

```ts
async loadSettings() {
	this.settings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		(await this.loadData()) as Partial<MyPluginSettings>,
	);
}

async saveSettings() {
	await this.saveData(this.settings);
}
```

Notes:

- `display()` must call `containerEl.empty()` first — it is re-invoked every time the tab opens.
- `Object.assign({}, DEFAULT_SETTINGS, await this.loadData())` is the required merge: `loadData()`
  returns `null` for a fresh install, and returns whatever shape the *previous* plugin version wrote.
  New fields must always have a default here. (Same class of bug as the Codable/`decodeIfPresent`
  fragility in the Murmur iOS app — an old `data.json` must never break the new build.)
- `onChange` fires per keystroke. For the API key / base URL, **debounce the save** or save on blur;
  do not fire a validation request per character.
- `onExternalSettingsChange?()` is called when `data.json` is changed **by another device** (e.g.
  Obsidian Sync). Implement it to re-read settings — otherwise iPhone and Mac will fight over
  `data.json`.

### 5.3 Storing the API key — security caveats (important)

**`loadData()`/`saveData()` write plaintext JSON to
`<Vault>/${vault.configDir}/plugins/<plugin-id>/data.json`.** There is **no** secure/keychain
storage in the Obsidian plugin API. Concretely:

- The key is readable by **every other plugin** installed in the vault, and by anything that can read
  the vault directory.
- If the vault is in iCloud Drive / Dropbox / Git / Obsidian Sync, `data.json` **goes with it**.
  Obsidian Sync can be configured to sync plugin settings — that would replicate the key to every
  device and to Obsidian's servers.
- Backups and vault archives will contain it.
- Obfuscation (base64, XOR, an AES key embedded in `main.js`) is **theatre** — the key is in the
  bundle. Do not pretend otherwise in the UI.

**Requirements for this plugin:**

1. Store the token in `data.json` via `saveData()` — there is no alternative — but say so plainly in
   the settings UI: *"Stored unencrypted in `.obsidian/plugins/nucleus-vault-sync/data.json` inside
   this vault."*
2. Use a **scoped, revocable** token (a PostgREST role/JWT limited to the sync schema), never the
   Supabase `service_role` key. Assume the token is compromised the moment the vault leaves the
   device.
3. Render the field with `inputEl.type = 'password'` so it isn't shoulder-surfed, and never
   `console.log` it. Remotely Save redacts `authorization` before logging — do the same:
   `retractedHeaders['authorization'] = '<retracted>'`.
4. Add `.obsidian/plugins/*/data.json` to the vault's `.gitignore` if the vault is a git repo, and
   document it.
5. Support an expiry/rotation flow: a settings button that clears the stored token.
6. Per the official `AGENTS.md`: "Clearly disclose any external services used, data sent, and risks"
   in `README.md` and in settings. This plugin ships the vault's contents to a server — say so.

### 5.4 Declarative settings (Obsidian ≥ 1.13)

`PluginSettingTab.getSettingDefinitions()` / `getControlValue()` / `setControlValue()` are new in
**1.13.0** and let Obsidian render settings itself (and expose them to search/other surfaces).
**Do not use them** if `minAppVersion` is 1.6.6 — they don't exist on older builds. Revisit only if
you raise `minAppVersion` to 1.13.0. Guard with `requireApiVersion('1.13.0')` if you ever want both.

---

## 6. Background work and reacting to changes

### 6.1 `onload` should be cheap; defer to `onLayoutReady`

```ts
onLayoutReady(callback: () => any): void;   // Workspace, @since 0.11.0
```

Typings: "Runs the callback function right away if layout is already ready, or push it to a queue to
be called later when layout is ready."

```ts
async onload() {
  await this.loadSettings();
  this.addSettingTab(new NucleusSettingTab(this.app, this));
  this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.engine.syncOnce() });

  this.app.workspace.onLayoutReady(() => {
    this.registerVaultEvents();      // see §6.3 — must be here, not in onload
    void this.engine.syncOnce();     // first sync after the vault is indexed
    this.registerInterval(window.setInterval(() => void this.engine.syncOnce(), intervalMs));
  });
}
```

Official guidance ("Performance", `AGENTS.md`): "Keep startup light… Avoid long-running tasks during
`onload`; use lazy initialization… Batch disk access and avoid excessive vault scans."

### 6.2 `registerInterval`

```ts
registerInterval(id: number): number;   // Component, @since 0.13.8
```

Typings: "Registers an interval (from `setInterval`) to be cancelled when unloading. Use
`window.setInterval` instead of `setInterval` to avoid TypeScript confusing between NodeJS vs
Browser API."

```ts
this.registerInterval(window.setInterval(() => { void this.engine.syncOnce(); }, 5 * 60 * 1000));
```

- **Must be `window.setInterval`** — the return type differs (`number` vs `NodeJS.Timeout`) and the
  NodeJS typing will not compile against `registerInterval(id: number)`.
- The interval fires whether or not the previous run finished. **Guard with an `isSyncing` flag** and
  make `syncOnce()` re-entrancy-safe; never let two sync passes overlap.
- Everything registered via `register*` is torn down on plugin disable/unload. Use
  `this.registerEvent(...)` for every `EventRef` and `this.registerDomEvent(...)` for DOM listeners,
  or you leak listeners across plugin reloads (very visible during `npm run dev`).

### 6.3 Reacting to file changes

```ts
vault.on('create', (file: TAbstractFile) => any): EventRef;
vault.on('modify', (file: TAbstractFile) => any): EventRef;
vault.on('delete', (file: TAbstractFile) => any): EventRef;
vault.on('rename', (file: TAbstractFile, oldPath: string) => any): EventRef;
```

```ts
this.registerEvent(this.app.vault.on('modify', (f) => this.queue.markDirty(f.path)));
this.registerEvent(this.app.vault.on('create', (f) => this.queue.markDirty(f.path)));
this.registerEvent(this.app.vault.on('delete', (f) => this.queue.markDeleted(f.path)));
this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.queue.markRenamed(oldPath, f.path)));
```

**The `create` trap** — straight from the typings:

> "Called when a file is created. **This is also called when the vault is first loaded for each
> existing file.** If you do not wish to receive create events on vault load, register your event
> handler inside `Workspace.onLayoutReady`."

Registering vault events inside `onload` on a 5,000-note vault fires 5,000 `create` events at
startup. **Register them inside `onLayoutReady`.**

Other rules:

- Callbacks are **synchronous-fire**. Never do network I/O in the handler — enqueue a dirty path and
  let a debounced worker do the work.
- `modify` fires on **every** autosave keystroke burst. Debounce with the exported
  `debounce<T, V>(cb, timeout?, resetTimer?)` from `obsidian` (use `resetTimer: true`), 2–5 s.
- **Your own writes fire these events too.** Maintain a set of paths the sync engine is currently
  writing and ignore events for them, or you get an infinite download→modify→upload loop. This is
  the single most common bug in home-grown sync plugins.
- Events do **not** fire for `.obsidian/` — dot-folders are outside the Vault layer. If you ever sync
  config, you must poll `adapter.stat()`.
- `rename` also fires for folder renames (the argument is a `TFolder`); handle the subtree.

### 6.4 Mobile lifecycle — **no background execution on iOS**

**A plugin does not keep running when Obsidian is backgrounded on iOS.** Obsidian mobile is a
Capacitor app; when iOS suspends it, the WebView's JS execution halts. Timers do not fire, in-flight
`requestUrl` calls do not complete.

> "Obsidian stops syncing the moment you exit the app" — and Obsidian's own explanation is that,
> being Capacitor-based, "Apple currently disallows those frameworks from running in the background."
> — https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906

Design consequences (mandatory):

1. **Sync must be resumable and idempotent.** Assume every sync pass can be killed mid-flight. Commit
   progress incrementally (per file), never "all or nothing".
2. **Persist a cursor/watermark** (last-seen server change id, last local scan time) to disk after
   each batch, not at the end.
3. **Sync on foreground.** Kick a pass from `onLayoutReady` and re-kick on
   `this.registerEvent(this.app.workspace.on('active-leaf-change', …))` or a visibility listener —
   **UNVERIFIED** which of `document.visibilitychange` / Obsidian's own resume signal is most
   reliable on iOS; test on device. A plain `registerInterval` is *not* sufficient on mobile.
4. Keep each pass **short**. iOS gives a suspended app on the order of seconds, not minutes; a long
   pass will simply be cut off.
5. Show progress via a `Notice` or status bar so the user knows to keep the app open —
   **`addStatusBarItem()` does nothing on mobile** (the sample plugin comments: "Does not work on
   mobile apps"). Remotely Save gates its status bar behind `Platform.isMobile` +
   an `enableMobileStatusBar` setting.

---

## 7. Mobile gotchas

### 7.1 Node and Electron APIs do not exist

Official: https://docs.obsidian.md/Plugins/Getting+started/Mobile+development

> "The Node.js API, and the Electron API aren't available on mobile devices."

So: **no `fs`, no `path`, no `os`, no `child_process`, no `node:crypto`, no `Buffer`, no
`electron`.** Because the esbuild config marks all `builtinModules` external, a dependency that
requires one of them compiles fine and **throws at runtime on the phone only**. This is the classic
"works on my Mac" failure.

Detection and mitigation:

- Grep the built `main.js` for `require("crypto")`, `require("fs")`, `Buffer`, `process.` before
  every release.
- If a dependency insists, do what Remotely Save does — map Node builtins to browser shims at bundle
  time via `package.json#browser`:
  ```json
  "browser": {
    "path": "path-browserify", "process": "process/browser", "stream": "stream-browserify",
    "crypto": "crypto-browserify", "url": "url/", "fs": false, "vm": false
  }
  ```
  (Remotely Save uses webpack for its main build partly for this reason.) **Better: don't add the
  dependency.** For a PostgREST client you need none of this.
- Use `activeDocument` / `activeWindow` (Obsidian globals) rather than `document` / `window` when
  attaching DOM listeners, so pop-out windows work. The sample plugin uses `activeDocument`.

### 7.2 SHA-256 without `node:crypto` — Web Crypto **is** available on iOS

**Verified by real-world use:** Remotely Save (`isDesktopOnly: false`, fully supported on iOS)
calls Web Crypto directly on all platforms:

```ts
// remotely-save/src/misc.ts:735
export const getSha1 = async (x: ArrayBuffer, stringify: 'base64' | 'hex') => {
  const y = await window.crypto.subtle.digest('SHA-1', x);
  …
};
```

and uses `window.crypto.subtle.importKey / deriveBits / encrypt / decrypt` (PBKDF2 + AES) in
`src/encryptOpenSSL.ts`, again on both desktop and mobile. So `crypto.subtle` is present and
functional inside Obsidian's iOS WebView — Obsidian's page counts as a secure context.

Use for content hashing:

```ts
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256HexOfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer);
}
```

Caveats:

- `crypto.subtle.digest` requires the **whole buffer in memory** — there is no streaming digest in
  Web Crypto. For a large attachment you must hold the full `ArrayBuffer`. Combine with the size cap
  in §1.5, or hash `{size, mtime, path}` instead of content for oversized files.
- `crypto.randomUUID()` and `crypto.getRandomValues()` are available; use them instead of a `uuid`
  dependency.
- `TextEncoder`/`TextDecoder`, `atob`/`btoa` are available. **`Buffer` is not** — write your own
  base64 ↔ `ArrayBuffer` helpers (`btoa(String.fromCharCode(...))` in chunks, or a manual encoder;
  the spread form blows the stack past ~100 kB, so chunk it).
- **UNVERIFIED:** whether the JS realm reports `isSecureContext === true` on iOS. It behaves as
  though it does (Web Crypto works), but don't gate code on that flag — feature-detect
  `typeof crypto?.subtle?.digest === 'function'` instead.

### 7.3 Memory

Official `AGENTS.md`, Mobile section: "Avoid large in-memory structures; be mindful of memory and
storage constraints." Practically, on an iPhone:

- The WebView is killed by iOS on memory pressure with no warning and no error you can catch.
- Never build an in-memory map of file **contents**. Build a manifest of `{path, mtime, size, hash}`
  only.
- Process files **one at a time** on mobile (concurrency 1–2); a higher concurrency multiplies peak
  memory by the number of in-flight buffers. Remotely Save uses `p-queue` for exactly this.
- Recall the `requestUrl` base64 bridge (§1.5): a 10 MB upload transiently costs ~10 MB buffer +
  ~13 MB base64 string + whatever the native side holds.
- Chunk large vault scans; `getFiles()` on a 20k-file vault is fine (metadata only), but a
  `Promise.all` over it that reads every file is not.

### 7.4 Are large binary uploads viable on iOS?

**Short answer: not through `requestUrl`, above ~20 MB.** See §1.5 for the confirmed crash threshold
and the official "won't be fixed anytime soon". Viable strategies, best first:

1. Cap mobile binary sync at a conservative size (default 8 MB) and defer larger items to desktop.
   Report skipped files to the user.
2. Chunked/resumable upload (Supabase Storage TUS) so no single body is large — **UNVERIFIED**
   through `requestUrl`; must be device-tested.
3. Plain `fetch` on mobile with server CORS allowing `capacitor://localhost` (iOS) and
   `http://localhost` (Android). Confirmed to handle 100 MB in the forum thread. Requires the
   Nucleus server to echo the Origin and to answer the preflight `OPTIONS` for `Authorization`,
   `apikey`, `x-upsert`, `content-type`.
4. Desktop-only "full sync" command; mobile does notes + small attachments.

### 7.5 Misc mobile behaviours

- `Platform` (verbatim):
  ```ts
  export const Platform: {
      isDesktop: boolean; isMobile: boolean;
      isDesktopApp: boolean; isMobileApp: boolean;
      isIosApp: boolean; isAndroidApp: boolean;
      isPhone: boolean; isTablet: boolean;
      isMacOS: boolean; isWin: boolean; isLinux: boolean;
      isSafari: boolean; resourcePathPrefix: string;
  };
  ```
  Note **`Platform.isMobile` is true when desktop is *emulating* mobile**; use `isMobileApp` /
  `isIosApp` when you mean the real device.
- `requireApiVersion(version: string): boolean` — gate newer APIs. Remotely Save's pattern:
  ```ts
  export const VALID_REQURL =
    (!Platform.isAndroidApp && requireApiVersion('0.13.26')) ||
    (Platform.isAndroidApp && requireApiVersion('0.14.6'));
  ```
- **Emulate mobile on desktop for testing:** in the developer console run
  `this.app.emulateMobile(true)` (toggle with `this.app.emulateMobile(!this.app.isMobile)`).
  This catches layout and `isMobile` bugs but **does not** reproduce the Node-API absence, the
  `requestUrl` base64 bridge, or the memory ceiling. **You must test on a real iPhone.**
- **Lookbehind in regular expressions** is called out in the mobile docs as a historical mobile
  incompatibility (old iOS JavaScriptCore). Modern iOS supports it, but avoid `(?<=…)` /
  `(?<!…)` in anything shipped; there is no upside.
- Non-ASCII response header values can break interop. Remotely Save `encodeURIComponent`s any
  response header value that isn't pure ASCII before handing it to `Response`
  (`src/fsWebdav.ts`) — relevant if the server returns filenames in `Content-Disposition`.
- Servers behave differently under iOS: Remotely Save carries a documented iOS-only workaround where
  a WebDAV `PROPFIND` returns 401 instead of 404 on iOS unless the URL ends in `/`
  (`Platform.isIosApp` branch, `src/fsWebdav.ts:77`). Expect to need at least one such quirk;
  keep the transport layer isolated so quirks are easy to add.
- Filename constraints: avoid `* " < > : | ? \` and control chars in any path you create from server
  data, plus Windows reserved names — otherwise the vault becomes non-portable. Remotely Save ships
  a `checkValidName()` for this.
- `addStatusBarItem()` is a no-op on mobile (see §6.4).

---

## 8. Installing an unlisted plugin for personal use

### 8.1 What Obsidian actually loads

A plugin is a **folder** inside the vault's config directory:

```
<Vault>/.obsidian/plugins/<plugin-id>/
    manifest.json      (required — its "id" must equal the folder name)
    main.js            (required — the bundled CommonJS output)
    styles.css         (optional)
    data.json          (created by saveData(); do not ship it)
```

Official `AGENTS.md`: "Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if
any) to `<Vault>/.obsidian/plugins/<plugin-id>/`. Reload Obsidian and enable the plugin in
**Settings → Community plugins**."

If the config dir is customised, use `app.vault.configDir` instead of `.obsidian`.

### 8.2 Desktop (macOS) — the development loop

1. `npm run build` (or `npm run dev` for watch mode).
2. Copy `manifest.json`, `main.js`, `styles.css` into
   `<Vault>/.obsidian/plugins/nucleus-vault-sync/`.
   For dev, the sample README suggests **cloning the repo directly into**
   `<Vault>/.obsidian/plugins/nucleus-vault-sync/` so `npm run dev` writes `main.js` in place.
3. **Settings → Community plugins** → turn off **Restricted mode** (formerly "Safe mode") →
   **Reload plugins** → enable *Nucleus Vault Sync*.
4. After each rebuild, either toggle the plugin off/on or run the **Reload app without saving**
   command. Obsidian does not hot-reload plugin code. (The community **Hot Reload** plugin by
   pjeby automates this during development.)

Note `.obsidian` is a dot-folder: in macOS Finder press **⇧⌘.** to show hidden files.

### 8.3 iOS / iPadOS — there is no Finder

**The iOS Files app does not show dot-folders**, so you cannot simply drop the plugin folder into
`.obsidian/plugins/` from the phone. Options, best first for this user:

1. **Sync the folder from the Mac (simplest).** If the vault lives in iCloud Drive (Obsidian's
   default "iCloud" vault location on iOS), create
   `.obsidian/plugins/nucleus-vault-sync/` on the Mac and drop `manifest.json` + `main.js` in.
   iCloud replicates it to the iPhone; reload Obsidian on the phone and enable the plugin.
   The same works with Obsidian Sync if **"Installed community plugins"** is enabled in the Sync
   settings for the vault.
2. **BRAT — Beta Reviewers Auto-update Tool** (`obsidian42-brat`, in the community catalog).
   Push the plugin to a GitHub repo, cut a release whose tag exactly matches `manifest.json`'s
   `version` (no `v` prefix) with `manifest.json` + `main.js` (+ `styles.css`) attached as
   **individual binary assets** — *not* a zip — then in Obsidian: **BRAT → Add beta plugin** and
   paste the repo URL. BRAT downloads and installs it, and can auto-update on launch. It is a normal
   plugin and runs on iOS, so this works entirely on-device.
   https://github.com/TfTHacker/obsidian42-brat
   **UNVERIFIED:** BRAT can install from a *private* GitHub repo on mobile. If the Nucleus plugin
   repo must stay private, prefer option 1 or use a public repo containing only the built artifacts.
3. **Working Copy** (iOS git client) — it can access hidden files and folders in configured
   repositories, so you can clone/pull the plugin's release artifacts directly into
   `.obsidian/plugins/…` on the device.
   https://www.macstories.net/club/manually-install-obsidian-plugins-on-ios-and-ipados-via-working-copy-and-its-new-version-control-for-files/
4. **iSH Shell** (iOS) — mount the vault folder and copy files from a shell. Fiddly; last resort.
5. Third-party file managers that expose dot-files (e.g. Textastic) can also see `.obsidian`.

Then on the phone: **Settings → Community plugins → Restricted mode off → Reload plugins → enable**.

### 8.4 Release checklist (if you ever publish)

From the sample README / `AGENTS.md`:

- Bump `version` in `manifest.json` (SemVer) and add the entry to `versions.json`
  (`"plugin-version": "min-obsidian-version"`). `npm version patch` does both.
- GitHub release tag == `manifest.json` `version`, **no leading `v`** (`.npmrc` sets
  `tag-version-prefix=""`).
- Attach `manifest.json`, `main.js`, `styles.css` as **individual** assets. `manifest.json` must
  exist both at the repo root **and** in the release.
- Community listing = PR to https://github.com/obsidianmd/obsidian-releases. Not needed for personal
  use; BRAT covers unlisted distribution.

---

## 9. Things that will bite you

1. **`throw: true` is the `requestUrl` default** — a 4xx rejects and you never see PostgREST's error
   body. Always `throw: false`, then branch on `res.status`.
2. **`res.json` throws on an empty body.** PostgREST returns `204 No Content` for `DELETE` and for
   `POST`/`PATCH` without `Prefer: return=representation`. Check `status`/`text.length` first.
3. **`requestUrl` on mobile base64-bridges the body and OOMs the app at ~20–50 MB.** Officially not
   getting fixed. Cap mobile binary sizes; test on a real device.
4. **A `Uint8Array` is not an `ArrayBuffer`.** Convert with `view.buffer.slice(byteOffset, …)` before
   putting it in `body`, or you'll ship `"[object Object]"`.
5. **Strip `host` and `content-length` from outgoing headers; lowercase incoming ones.** Both are
   real workarounds in shipped sync plugins.
6. **No `AbortSignal`, no timeout, no streaming, no progress on `requestUrl`.** Race your own
   timeout; a "timed-out" request still runs.
7. **`vault.on('create')` fires for every existing file at vault load.** Register vault events inside
   `workspace.onLayoutReady`, not `onload`.
8. **Your own writes fire `modify`/`create`.** Without an "I'm writing this path" guard you get an
   infinite sync loop. This is the #1 bug in DIY sync plugins.
9. **`vault.create` throws if the file exists, and does not create parent folders;
   `vault.createFolder` throws if the folder exists.** Implement `mkdirp` level-by-level with
   `adapter.exists` + `adapter.mkdir`.
10. **`vault.rename` silently breaks every link to the file.** Use
    `app.fileManager.renameFile` unless you have a very specific reason.
11. **`vault.delete` is permanent.** Use `app.fileManager.trashFile` (needs `minAppVersion` ≥ 1.6.6)
    for anything the server told you to remove.
12. **`cachedRead` before an upload can ship stale bytes** if iCloud/Obsidian Sync just wrote the
    file. Use `read` on the write/upload path.
13. **`.obsidian/` is invisible to the Vault API and emits no events.** Adapter only, and poll if you
    care.
14. **Node builtins are external in the esbuild config** — a dependency that `require`s `crypto` or
    `fs` builds cleanly and dies only on the phone. Grep the bundle before shipping.
15. **`Buffer` does not exist on mobile.** Use `ArrayBuffer`/`Uint8Array`/`TextEncoder`, and chunk
    your base64 helpers (`String.fromCharCode(...arr)` overflows the stack past ~100 kB).
16. **`setInterval` must be `window.setInterval`** for `registerInterval(id: number)` to typecheck,
    and it fires whether or not the last sync finished — add an `isSyncing` guard.
17. **iOS suspends the app; nothing runs in the background.** Sync must be resumable, incremental,
    and foreground-triggered. A pure interval-driven design will not work on mobile.
18. **`addStatusBarItem()` is a no-op on mobile.** Use `Notice` for mobile feedback.
19. **`data.json` is plaintext in the vault** — the API key travels with any vault sync/backup and is
    readable by every other plugin. Use a scoped, revocable token; disclose it in the UI.
20. **`Object.assign({}, DEFAULT_SETTINGS, await this.loadData())` is mandatory** — `loadData()`
    returns `null` on first run and old shapes after upgrades.
21. **`onExternalSettingsChange()`** — without it, two devices syncing `data.json` will clobber each
    other's settings.
22. **`Platform.isMobile` is true under desktop mobile emulation.** Use `isMobileApp`/`isIosApp` for
    real-device branches, and don't trust `emulateMobile(true)` to catch Node-API or memory bugs.
23. **Path hygiene:** run every server-supplied path through `normalizePath()`, reject
    `* " < > : | ? \` and control characters, and never emit a leading slash.
24. **Entry point moved to `src/main.ts`** in the current sample plugin. Copying an older
    `esbuild.config.mjs` that points at `main.ts` will silently build nothing useful.
25. **On iOS you cannot see `.obsidian` in the Files app.** Plan the install path (iCloud from the
    Mac, or BRAT) before you need it.

---

## Sources

- [obsidian-api `obsidian.d.ts` (master, 1.13.2)](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) — `esbuild.config.mjs`, `package.json`, `tsconfig.json`, `eslint.config.mts`, `manifest.json`, `src/main.ts`, `src/settings.ts`, `version-bump.mjs`, `README.md`, `AGENTS.md`
- [Vault — Obsidian Developer Docs](https://docs.obsidian.md/Plugins/Vault)
- [Mobile development — Obsidian Developer Docs](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- [Plugin guidelines — Obsidian Developer Docs](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [requestUrl — Obsidian Developer Docs](https://docs.obsidian.md/Reference/TypeScript+API/requestUrl)
- [obsidian-releases `desktop-releases.json`](https://github.com/obsidianmd/obsidian-releases/blob/master/desktop-releases.json) and [`validate-plugin-entry.yml`](https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml)
- [Bug: mobile `requestUrl` has performance issue — Obsidian Forum](https://forum.obsidian.md/t/bug-mobile-requesturl-has-performance-issue/84177)
- [Support streaming the `request()`/`requestUrl()` response body — Obsidian Forum](https://forum.obsidian.md/t/support-streaming-the-request-and-requesturl-response-body/87381)
- [Is it possible to change "Origin" header sent within HTTP request from mobile app? — Obsidian Forum](https://forum.obsidian.md/t/is-it-possible-to-change-origin-header-sent-within-http-request-from-mobile-app/68970)
- [Make Obsidian Sync work in background (on Mobile) — Obsidian Forum](https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906)
- [Make HTTP requests from plugins — Obsidian Forum](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461)
- [How to show invisible folders in Obsidian vault on iPhone — Obsidian Forum](https://forum.obsidian.md/t/how-to-show-invisible-folders-in-obsidian-vault-on-iphone/41009)
- [[Mobile] iOS: App to work with hidden folder — Obsidian Forum](https://forum.obsidian.md/t/mobile-ios-app-to-work-with-hidden-folder/25741)
- [Manually Install Obsidian Plugins on iOS and iPadOS via Working Copy — Club MacStories](https://www.macstories.net/club/manually-install-obsidian-plugins-on-ios-and-ipados-via-working-copy-and-its-new-version-control-for-files/)
- [Remotely Save](https://github.com/remotely-save/remotely-save) — `src/fsS3.ts`, `src/fsWebdav.ts`, `src/fsLocal.ts`, `src/misc.ts`, `src/baseTypesObs.ts`, `src/encryptOpenSSL.ts`, `manifest.json`, `package.json`
- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) — `manifest.json`
- [BRAT — Beta Reviewers Auto-update Tool](https://github.com/TfTHacker/obsidian42-brat)
