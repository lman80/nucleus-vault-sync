import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isManagedRemoteDocument,
  isManagedRemotePath,
  mayTombstoneRemoteDocument,
  deletionsAllowedAfterPull,
} from "./sync-scope";

const on = { enabled: true, includeCaches: false, includeWorkspace: false };
const off = { enabled: false, includeCaches: false, includeWorkspace: false };

test("ordinary vault files remain managed", () => {
  assert.equal(isManagedRemotePath(".obsidian", "Notes/Today.md", on), true);
});

test("turning config sync off does not turn remote config files into deletions", () => {
  assert.equal(isManagedRemotePath(".obsidian", ".obsidian/hotkeys.json", off), false);
  assert.equal(
    isManagedRemotePath(".obsidian", ".obsidian/plugins/dataview/main.js", off),
    false,
  );
});

test("excluded config cache rows are left alone rather than tombstoned", () => {
  assert.equal(
    isManagedRemotePath(
      ".obsidian",
      ".obsidian/plugins/smart-connections/.smart-env/cache.ajson",
      on,
    ),
    false,
  );
});

test("enabled config files are managed, except this plugin's private state", () => {
  assert.equal(isManagedRemotePath(".obsidian", ".obsidian/hotkeys.json", on), true);
  assert.equal(
    isManagedRemotePath(".obsidian", ".obsidian/plugins/nucleus-vault-sync/data.json", on),
    false,
  );
});

test("trash, caches, and repositories are never inferred as deletions", () => {
  assert.equal(isManagedRemotePath(".obsidian", ".trash/Old.md", on), false);
  assert.equal(isManagedRemotePath(".obsidian", ".git/objects/abc", on), false);
  assert.equal(isManagedRemotePath(".obsidian", ".claude/cache.json", on), false);
});

test("unsafe server paths are never read, written, or inferred as deletions", () => {
  assert.equal(isManagedRemotePath(".obsidian", "../Outside.md", on), false);
  assert.equal(isManagedRemotePath(".obsidian", "Notes/../../Outside.md", on), false);
  assert.equal(isManagedRemotePath(".obsidian", "/absolute.md", on), false);
});

test("a notes-only device never owns absent shared attachments", () => {
  assert.equal(
    isManagedRemoteDocument(
      ".obsidian",
      { source_ref: "Media/movie.mp4", kind: "attachment", byte_size: 100_000_000 },
      { config: on, attachments: "none", attachmentLimitBytes: 25_000_000 },
    ),
    false,
  );
});

test("a size-limited device owns only attachments inside its limit", () => {
  const scope = { config: on, attachments: "under-limit" as const, attachmentLimitBytes: 10 };
  assert.equal(
    isManagedRemoteDocument(
      ".obsidian",
      { source_ref: "small.png", kind: "attachment", byte_size: 10 },
      scope,
    ),
    true,
  );
  assert.equal(
    isManagedRemoteDocument(
      ".obsidian",
      { source_ref: "large.png", kind: "attachment", byte_size: 11 },
      scope,
    ),
    false,
  );
});

test("binary plugin files stay managed even on a notes-only device", () => {
  assert.equal(
    isManagedRemoteDocument(
      ".obsidian",
      { source_ref: ".obsidian/plugins/example/module.wasm", kind: "attachment", byte_size: 50_000_000 },
      { config: on, attachments: "none", attachmentLimitBytes: 0 },
    ),
    true,
  );
});

test("a remote file first seen after pull can never be mistaken for a local deletion", () => {
  const row = { source_ref: "Phone note.md", kind: "note", content_hash: "phone" };
  const scope = { config: on, attachments: "all" as const, attachmentLimitBytes: Infinity };
  assert.equal(
    mayTombstoneRemoteDocument(".obsidian", row, undefined, false, scope, true),
    false,
  );
});

test("a missing local file is deleted remotely only after exact prior agreement", () => {
  const row = { source_ref: "Old note.md", kind: "note", content_hash: "agreed" };
  const scope = { config: on, attachments: "all" as const, attachmentLimitBytes: Infinity };
  assert.equal(
    mayTombstoneRemoteDocument(
      ".obsidian",
      row,
      { layerHash: "agreed", diskHash: "agreed" },
      false,
      scope,
      true,
    ),
    true,
  );
  assert.equal(
    mayTombstoneRemoteDocument(
      ".obsidian",
      row,
      { layerHash: "older", diskHash: "older" },
      false,
      scope,
      true,
    ),
    false,
  );
  assert.equal(
    mayTombstoneRemoteDocument(
      ".obsidian",
      { ...row, content_hash: null },
      { layerHash: null, diskHash: "previous-bytes" },
      false,
      scope,
      true,
    ),
    false,
  );
});

test("one failed download disables every remote deletion in that pass", () => {
  assert.equal(deletionsAllowedAfterPull(true, 0), true);
  assert.equal(deletionsAllowedAfterPull(true, 1), false);
  assert.equal(deletionsAllowedAfterPull(false, 0), false);
});
