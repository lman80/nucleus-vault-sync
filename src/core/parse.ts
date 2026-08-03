/**
 * parse — turn a file's text into the fields a `core.documents` row holds.
 *
 * Ported from the Node connector's `src/vault.js`, minus everything that
 * touched the filesystem. These functions take text in and return data out:
 * the plugin reads bytes through Obsidian's own vault API and hands them here.
 *
 * Nothing in this file reads, writes, moves, renames or deletes anything.
 *
 * ## Why there is a hand-rolled SHA-1 below
 *
 * This code runs inside Obsidian on iOS as well as desktop, so `node:crypto`
 * does not exist. The browser replacement, `crypto.subtle.digest`, is async
 * *and* is not guaranteed to offer SHA-1 in every context (it is unavailable
 * in some hardened/mobile WebViews, and unavailable entirely outside a secure
 * context). `uuidV5` is called once per file while parsing a vault that has
 * thousands of them, from code paths that are otherwise synchronous.
 *
 * Given the choice between making `uuidV5` async — which would turn every
 * caller and every caller's caller into an async function for the sake of an
 * id — and vendoring ~50 lines of SHA-1, the SHA-1 wins. It is a *naming*
 * hash, not a security one: RFC 4122 v5 uses SHA-1 by definition, the input is
 * a vault name and a path, and nothing about the sync's safety depends on it
 * being collision-proof. Content hashing, where the choice actually matters,
 * uses SHA-256 through `crypto.subtle` (see `sha256` at the bottom) and is
 * async, because those call sites already are.
 */

// Named import, not `import yaml from "js-yaml"`: js-yaml's ESM build has no
// default export from v5 on, and a named import is what every bundler
// (including Obsidian's esbuild) can tree-shake and interop cleanly.
import { load as loadYaml } from "js-yaml";

import type { Frontmatter } from "./types";

/**
 * Namespace for deterministic first-insert ids. Fixed forever: changing it
 * would make every note in the vault look new.
 */
export const UUID_NAMESPACE = "6f3d1c94-8a25-4b0e-9d47-2c1a5e8b7f30";

const utf8 = new TextEncoder();

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** SHA-1 of a byte string, returned as 20 bytes. Straight from RFC 3174. */
function sha1(data: Uint8Array): Uint8Array {
  // Message padding: a 0x80 byte, zeroes, then the bit length as a 64-bit
  // big-endian integer, rounded up to a whole number of 64-byte blocks.
  const bitLength = data.length * 8;
  const total = (((data.length + 8) >> 6) + 1) << 6;
  const block = new Uint8Array(total);
  block.set(data);
  block[data.length] = 0x80;

  const view = new DataView(block.buffer);
  // Split across two 32-bit writes: a JS number cannot hold a 64-bit integer
  // exactly, and `>>> 0` is ToUint32, i.e. the low word.
  view.setUint32(total - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(total - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      // Every term is coerced unsigned first: bitwise ops in JS produce signed
      // int32, and the sum must be modulo 2^32, not modulo a negative.
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      // The register shift, in FIPS 180-1's order: b takes the old a, and c
      // takes the old b *rotated* — not the other way round. Getting these two
      // the wrong way about still produces a plausible-looking digest, which is
      // why the known-answer vectors below the tests exist.
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** The 16 bytes of a canonical UUID string, dashes ignored. */
function uuidBytes(uuid: string): Uint8Array {
  const clean = uuid.replace(/-/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * uuid v5 (SHA-1, name-based) without pulling in a dependency for fifteen
 * lines. Used only to pick a *first* id for a note; after that the row owns
 * its identity and a rename keeps it.
 *
 * Synchronous, by the reasoning in this file's header.
 */
export function uuidV5(name: string, namespace: string = UUID_NAMESPACE): string {
  const ns = uuidBytes(namespace);
  const nameBytes = utf8.encode(name);

  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);

  const bytes = sha1(input).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Split YAML frontmatter from the body. Obsidian's rule: the file must *begin*
 * with `---` on its own line, and the block ends at the next `---` line.
 * Anything malformed is treated as "no frontmatter" rather than throwing — a
 * broken block in one note must never stop the sync.
 */
export function splitFrontmatter(raw: string): { frontmatter: Frontmatter | null; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: null, body: raw };
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim() !== "---") return { frontmatter: null, body: raw };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return { frontmatter: null, body: raw };

  const block = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  try {
    const parsed = loadYaml(block);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Frontmatter, body };
    }
    return { frontmatter: null, body };
  } catch {
    return { frontmatter: null, body };
  }
}

/** Tags from frontmatter (array or comma/space string) plus inline #tags. */
export function extractTags(frontmatter: Frontmatter | null | undefined, body: string): string[] {
  const tags = new Set<string>();

  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const cleaned = value.trim().replace(/^#/, "");
    if (cleaned) tags.add(cleaned);
  };

  const raw = frontmatter?.tags ?? frontmatter?.tag;
  if (Array.isArray(raw)) raw.forEach(add);
  else if (typeof raw === "string") raw.split(/[,\s]+/).forEach(add);

  // Inline #tags, ignoring anything inside fenced code blocks and ignoring
  // markdown headings (`# Heading` is not a tag).
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const match of withoutCode.matchAll(/(^|[\s(])#([A-Za-z0-9_/-]+)/g)) {
    add(match[2]);
  }

  return [...tags];
}

/**
 * [[wikilink]] targets, in order of first appearance, without aliases or anchors.
 *
 * Frontmatter is scanned as well as the body: vaults use a
 * `Related Notes: ["[[Some Note]]"]` property, and those are real links to real
 * notes — missing them silently loses a chunk of the graph.
 *
 * A bare `[[#Heading]]` is deliberately NOT a link: it points at a heading
 * inside the same note, so it says nothing about how notes connect. (It falls
 * out of the rule below — everything before `#` is the target, and here that
 * is the empty string.)
 *
 * Backticked and fenced text is stripped first: a wikilink shown inside code is
 * an example of syntax, not an edge in the graph.
 */
export function extractLinks(frontmatter: Frontmatter | null | undefined, body: string): string[] {
  const seen = new Set<string>();
  const scan = (text: string | null | undefined): void => {
    if (!text) return;
    const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    for (const match of withoutCode.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1].split("|")[0].split("#")[0].trim();
      if (target) seen.add(target);
    }
  };
  if (frontmatter) scan(JSON.stringify(frontmatter));
  scan(body);
  return [...seen];
}

/**
 * Obsidian's own convention: the filename is the title. A frontmatter `title:`
 * overrides it, because a note that states one means it.
 *
 * `sourceRef` is the vault-relative path — the `.md` and the folders come off
 * here so callers can pass the path they already have.
 */
export function titleFor(sourceRef: string, frontmatter?: Frontmatter | null): string {
  const filename = (sourceRef.split("/").pop() ?? sourceRef).replace(/\.md$/i, "");
  const stated = frontmatter?.title;
  return (typeof stated === "string" && stated.trim()) || filename;
}

/** A frontmatter date, if it parses; otherwise null. Never throws. */
export function parseDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Enough of a mime table for what actually turns up in a vault. */
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".canvas": "application/json",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

/**
 * The extension, lowercased, with its dot — `node:path`'s `extname` rules by
 * hand. A leading dot is not an extension (`.gitignore` has none), and only
 * the last dot counts.
 */
export function extname(path: string): string {
  const filename = path.split("/").pop() ?? path;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return "";
  return filename.slice(dot).toLowerCase();
}

/** Best guess at a file's mime type from its name. Never throws. */
export function mimeFor(path: string): string {
  return MIME[extname(path)] ?? "application/octet-stream";
}

/**
 * SHA-256 as lowercase hex — the content hash the whole sync turns on.
 *
 * Async because `crypto.subtle.digest` is, and unlike `uuidV5` that costs
 * nothing: every call site here is already awaiting a file read. SHA-256 is
 * available in every context that has WebCrypto at all, so unlike SHA-1 there
 * is no reason to hand-roll it.
 */
export async function sha256(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return hex(new Uint8Array(digest));
}
