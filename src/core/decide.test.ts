/**
 * Tests for the decision table in decide.ts.
 *
 * This is the code that can delete or overwrite a note in a real vault, so
 * every branch is pinned here — including the ones that must do NOTHING, which
 * are the ones that matter most.
 *
 * Run: npx tsx --test src/core/decide.test.ts   (any TS-aware runner works;
 * the imports are extensionless so the bundler resolves them the same way the
 * plugin's own build does).
 *
 * `node:test` is a Node API and this file uses it deliberately: tests never
 * ship inside the plugin, so the iOS constraint that governs decide.ts and
 * parse.ts does not reach here. The modules under test import nothing from
 * "node:*" — that is what these tests are checking is still true.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, renderNote } from "./decide";

const H_OLD = "aaaa";
const H_NEW = "bbbb";
const H_OTHER = "cccc";

const row = (hash: string, deleted = false) => ({
  content_hash: hash,
  deleted_at: deleted ? "2026-08-03T00:00:00Z" : null,
});

test("nothing changed anywhere → do nothing", () => {
  const d = decide({
    row: row(H_OLD),
    onDisk: H_OLD,
    record: { layerHash: H_OLD, diskHash: H_OLD },
  });
  assert.equal(d.action, "none");
});

test("layer moved, vault did not → write the layer's version", () => {
  const d = decide({
    row: row(H_NEW),
    onDisk: H_OLD,
    record: { layerHash: H_OLD, diskHash: H_OLD },
  });
  assert.equal(d.action, "write");
});

test("vault moved, layer did not → do nothing (push will carry it up)", () => {
  const d = decide({
    row: row(H_OLD),
    onDisk: H_NEW,
    record: { layerHash: H_OLD, diskHash: H_OLD },
  });
  assert.equal(d.action, "none");
});

test("BOTH moved to different content → conflict, never overwrite", () => {
  const d = decide({
    row: row(H_NEW),
    onDisk: H_OTHER,
    record: { layerHash: H_OLD, diskHash: H_OLD },
  });
  assert.equal(d.action, "conflict");
});

test("both moved to the SAME content → nothing to reconcile", () => {
  const d = decide({
    row: row(H_NEW),
    onDisk: H_NEW,
    record: { layerHash: H_OLD, diskHash: H_OLD },
  });
  assert.equal(d.action, "none");
});

test("new in layer, absent on disk → write it", () => {
  const d = decide({ row: row(H_NEW), onDisk: null, record: undefined });
  assert.equal(d.action, "write");
});

test("tombstoned in layer, untouched on disk → delete", () => {
  const d = decide({
    row: row(H_OLD, true),
    onDisk: H_OLD,
    record: { layerHash: H_OLD, diskHash: H_OLD },
  });
  assert.equal(d.action, "delete");
});

test("tombstoned in layer but EDITED here → keep the file", () => {
  const d = decide({
    row: row(H_OLD, true),
    onDisk: H_NEW,
    record: { layerHash: H_OLD, diskHash: H_OLD },
  });
  assert.equal(d.action, "none");
});

test("no sync record at all and a file already on disk → conflict, not overwrite", () => {
  // The dangerous case: first ever pull, a file exists locally, the layer has
  // one too. With no record of them ever agreeing, assume nothing.
  const d = decide({ row: row(H_NEW), onDisk: H_OTHER, record: undefined });
  assert.equal(d.action, "conflict");
});

test("no record, disk matches layer exactly → nothing", () => {
  const d = decide({ row: row(H_NEW), onDisk: H_NEW, record: undefined });
  assert.equal(d.action, "none");
});

test("tombstoned in layer, already gone from disk → nothing", () => {
  const d = decide({ row: row(H_OLD, true), onDisk: null, record: undefined });
  assert.equal(d.action, "none");
});

test("renderNote: no frontmatter is the body verbatim", () => {
  assert.equal(renderNote({ body: "hello\nworld", frontmatter: null }), "hello\nworld");
});

test("renderNote: frontmatter round-trips in Obsidian's shape", () => {
  const out = renderNote({
    body: "text here",
    frontmatter: { title: "A Note", tags: ["one", "two"] },
  });
  assert.equal(out, "---\ntitle: A Note\ntags:\n  - one\n  - two\n---\ntext here");
});

test("renderNote: an empty frontmatter object emits no block", () => {
  assert.equal(renderNote({ body: "x", frontmatter: {} }), "x");
});

test("renderNote: an exact empty raw file wins over stale derived content", () => {
  assert.equal(renderNote({ raw: "", body: "old text" }), "");
});
