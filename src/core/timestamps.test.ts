import { test } from "node:test";
import assert from "node:assert/strict";

import { localTimesMatch, remoteTimesPresent, timesFor, timesKey } from "./timestamps";

const row = {
  file_created_at: "2020-01-02T03:04:05.000Z",
  file_modified_at: "2021-02-03T04:05:06.000Z",
};

test("server creation and modification dates convert to Obsidian milliseconds", () => {
  assert.deepEqual(timesFor(row), {
    ctime: Date.parse(row.file_created_at),
    mtime: Date.parse(row.file_modified_at),
  });
});

test("date repair tolerates filesystem rounding but detects the phone download date", () => {
  const wanted = timesFor(row);
  assert.equal(localTimesMatch({ ctime: wanted.ctime! + 500, mtime: wanted.mtime! - 500 }, wanted), true);
  assert.equal(localTimesMatch({ ctime: Date.now(), mtime: wanted.mtime! }, wanted), false);
});

test("the desired pair has a stable per-device repair key", () => {
  assert.equal(timesKey(row), `${row.file_created_at}|${row.file_modified_at}`);
});

test("valid server dates stay authoritative over a phone's local ctime", () => {
  assert.equal(remoteTimesPresent(row), true);
  assert.equal(remoteTimesPresent({ ...row, file_created_at: null }), false);
});
