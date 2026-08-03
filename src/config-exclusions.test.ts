/**
 * The config-directory exclusions.
 *
 * Two of these protect against real damage rather than untidiness:
 *
 *  - `data.json` for THIS plugin holds the API key and this device's sync
 *    record. The record must differ per device — it is the only thing that lets
 *    each one tell "changed here" from "changed there" — so copying it between
 *    devices would break conflict detection everywhere at once, and would post
 *    the key into the layer as a note.
 *
 *  - The same check has to run on the way DOWN. A row written by an older build
 *    (before these rules existed) is still sitting in the layer, and pulling it
 *    would deliver another device's key and record straight into this vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mayWriteConfigPath, OWN_DATA_FILE } from "./core/config-paths";

const app = ".obsidian";

const on = { enabled: true, includeWorkspace: false };
const withWorkspace = { enabled: true, includeWorkspace: true };
const off = { enabled: false, includeWorkspace: false };

test("our own data.json is never written, even on the way down", () => {
  assert.equal(mayWriteConfigPath(app, `.obsidian/${OWN_DATA_FILE}`, on), false);
  assert.equal(mayWriteConfigPath(app, `.obsidian/${OWN_DATA_FILE}`, withWorkspace), false);
});

test("another plugin's data.json IS synced — only ours is special", () => {
  assert.equal(mayWriteConfigPath(app, ".obsidian/plugins/dataview/data.json", on), true);
});

test("plugin code, themes and snippets are synced", () => {
  assert.equal(mayWriteConfigPath(app, ".obsidian/plugins/dataview/main.js", on), true);
  assert.equal(mayWriteConfigPath(app, ".obsidian/plugins/calendar/manifest.json", on), true);
  assert.equal(mayWriteConfigPath(app, ".obsidian/snippets/mine.css", on), true);
  assert.equal(mayWriteConfigPath(app, ".obsidian/themes/Minimal/theme.css", on), true);
  assert.equal(mayWriteConfigPath(app, ".obsidian/hotkeys.json", on), true);
});

test("workspace layout is excluded unless asked for", () => {
  assert.equal(mayWriteConfigPath(app, ".obsidian/workspace.json", on), false);
  assert.equal(mayWriteConfigPath(app, ".obsidian/workspace-mobile.json", on), false);
  assert.equal(mayWriteConfigPath(app, ".obsidian/workspace.json", withWorkspace), true);
});

test("regenerable plugin caches are skipped", () => {
  assert.equal(mayWriteConfigPath(app, ".obsidian/plugins/smart-connections/.smart-env/x.ajson", on), false);
});

test("nothing under the config dir is written when the feature is off", () => {
  assert.equal(mayWriteConfigPath(app, ".obsidian/hotkeys.json", off), false);
});

test("a path outside the config dir is not this module's business", () => {
  assert.equal(mayWriteConfigPath(app, "Notes/Thing.md", on), false);
});

test("a path merely STARTING with the config dir name is not inside it", () => {
  // ".obsidian-backup/..." must not be mistaken for ".obsidian/..."
  assert.equal(mayWriteConfigPath(app, ".obsidian-backup/hotkeys.json", on), false);
});
