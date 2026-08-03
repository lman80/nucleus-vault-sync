/**
 * Which failures are worth another attempt.
 *
 * Pure, and in `core/` with no Obsidian import, for the same reason the config
 * path rules live here: it decides real behaviour and has to be testable
 * without the app. It was not, and it broke silently — the list matched
 * "timed out", the timeout message was later reworded to "took longer than",
 * and timeouts stopped being retried. The one failure most likely to succeed on
 * a second attempt gave up after twelve seconds, and nothing said so.
 *
 * The wording now has exactly one definition, below, referenced by both the
 * thrower and the matcher, so they cannot drift apart again.
 */

/** The one place the timeout wording is defined. */
export const TIMEOUT_MESSAGE = "took longer than";

const TRANSIENT =
  new RegExp(
    [
      "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
      "terminated", "socket hang up", "network", "fetch failed", "failed to fetch",
      "load failed", "timed out", "connection appears to be offline", "net::ERR",
      TIMEOUT_MESSAGE,
    ].join("|"),
    "i",
  );

/**
 * True when the fault looks like the connection rather than the request.
 *
 * A rejected key or a missing object is NOT transient: retrying only makes the
 * user wait longer for the same answer.
 */
export function isTransientMessage(text: string): boolean {
  return TRANSIENT.test(text);
}
