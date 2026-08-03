/**
 * The retry classifier.
 *
 * This exists because rewording a message broke it silently: the list matched
 * "timed out", the timeout text became "took longer than", and timeouts — the
 * failure most likely to succeed on a second attempt — stopped being retried
 * altogether. Nothing failed loudly; syncs just gave up early.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isTransientMessage, TIMEOUT_MESSAGE } from "./core/transient";

test("the timeout message this client actually emits is retryable", () => {
  // The real string, built the way the client builds it — not a copy that can
  // drift away from it.
  assert.ok(isTransientMessage(`GET /rest/v1/documents: ${TIMEOUT_MESSAGE} 12s`));
});

test("ordinary network faults are retryable", () => {
  for (const m of ["fetch failed", "ECONNRESET", "Load failed", "socket hang up", "net::ERR_FAILED"]) {
    assert.ok(isTransientMessage(m), m);
  }
});

test("a rejected key is NOT retried — it would only waste the user's time", () => {
  assert.equal(isTransientMessage("your key was rejected (401)"), false);
  assert.equal(isTransientMessage("the layer has no object at vault/abc"), false);
});
