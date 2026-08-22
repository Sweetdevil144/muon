/**
 * ADR-0052 — WHAT MAY BE BAKED INTO A PUBLIC ARTIFACT AS THE CLIENT ID.
 *
 * `bundle-release.mjs` writes `process.env.MUON_GITHUB_CLIENT_ID` into
 * `release/package.json`, which is published to npm and shipped in a tarball. A
 * GitHub App **client id** is a public identifier and belongs there. A client
 * **secret**, a personal access token, or an installation token does NOT — and
 * the two are one shell variable apart. `MUON_GITHUB_CLIENT_SECRET` and
 * `MUON_GITHUB_CLIENT_ID` differ by seven characters in a release script nobody
 * reads twice at 2am, and there was no check at all: whatever was in the
 * variable went into a world-readable manifest, permanently, in a published
 * version that cannot be unpublished after 72 hours.
 *
 * So this refuses by SHAPE. It lives in its own module rather than inside
 * `bundle-release.mjs` for a plain reason: that script `rm -rf`s the operator's
 * `release/` directory at import time, so nothing can import it to test it — and
 * a guard against leaking a credential is exactly the code that must be tested
 * behaviourally rather than by grepping its own source.
 *
 * TWO BUNDLERS IMPORT IT, and that is why the messages below name no particular
 * file. `apps/desktop/scripts/write-build-config.mjs` bakes the same variable
 * into `staged/build-config.json`, which electron-builder lands inside the
 * `.dmg` — a wider-reaching public artifact than the npm tarball. It had NO
 * check at all while the CLI had this one, so the hole the CLI closed was still
 * open in the app anybody can download and unpack. One guard, both bundlers,
 * each naming its own artifact in the sentence it wraps around the reason.
 *
 * The policy, in order:
 *  1. Empty is FINE. A release with no client id degrades UNGATED and says so
 *     (Decision 2); refusing here would make an unrelated build fail.
 *  2. Whitespace, control characters, or a length outside 8–64 are REFUSED. Real
 *     client ids are ~20 characters; a 40-char blob or a value with a newline is
 *     a paste accident.
 *  3. Known SECRET shapes are REFUSED by name — the `gh*_` token families, fine-
 *     grained PATs, and the 40-hex GitHub App client secret.
 *  4. Known CLIENT ID shapes are ACCEPTED silently.
 *  5. Anything else that is at least character-safe is ACCEPTED WITH A WARNING.
 *     GitHub has changed this format twice; a hard refusal on an unrecognised
 *     but plausible id would block a legitimate release over a format change,
 *     which is the wrong failure. The warning is loud and names the shape.
 */

/** Token families GitHub itself documents. Any of these is a credential. */
const SECRET_PREFIXES = [
  "ghp_", // classic personal access token
  "gho_", // OAuth access token (this is what the device flow returns)
  "ghu_", // GitHub App user-to-server
  "ghs_", // GitHub App server-to-server / installation
  "ghr_", // refresh token
  "github_pat_", // fine-grained PAT
];

/** A GitHub App client SECRET is 40 lowercase hex characters. A client ID never
 *  is — the classic OAuth app id is 20. Refusing this shape is the single most
 *  valuable rule here, because it is the exact wrong-variable mistake. */
const APP_CLIENT_SECRET = /^[0-9a-f]{40}$/;

/**
 * The formats GitHub has actually issued as client ids.
 *
 * RANGES, NOT EXACT LENGTHS, for the `v23li` generation. `Iv23li` was pinned at
 * exactly 16 trailing characters and real ids of that generation are 14 (20
 * total) — so the guard warned "does not match any GitHub client-id shape this
 * guard knows" about the correct client id of the App this gate is built on. That
 * is the harmful direction of a false alarm: a warning an operator sees on every
 * correct release is a warning they have learned to scroll past the day it fires
 * on a real client SECRET.
 *
 * The sibling `Ov23li` entry already carried the tolerance and is mirrored here
 * rather than swapping one exact length for another. Nothing about SAFETY rests
 * on this list: the refusals above it (token prefixes, the 40-hex App secret,
 * whitespace, control characters, charset, length bounds) are what block a
 * credential, and this list only decides whether a passing value is silent or
 * loud.
 */
const KNOWN_CLIENT_IDS = [
  /^Iv1\.[0-9a-f]{16}$/, // GitHub App
  /^Iv23li[0-9A-Za-z]{14,22}$/, // GitHub App (newer)
  /^Ov23li[0-9A-Za-z]{14,22}$/, // OAuth app (newer)
  /^[0-9a-f]{20}$/, // OAuth app (classic)
];

/** Conservative: what a public identifier may be built from at all. */
const SAFE_CHARSET = /^[A-Za-z0-9._-]+$/;

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

/**
 * @param {string | undefined} raw the value of MUON_GITHUB_CLIENT_ID
 * @returns {{ ok: true, clientId: string, warning?: string }
 *          | { ok: false, reason: string }}
 */
export function checkBakedClientId(raw) {
  const value = raw ?? "";
  // 1 — absent is a valid (ungated) release.
  if (value.trim() === "") return { ok: true, clientId: "" };

  // 2a — whitespace is checked against the RAW value, not the trimmed one: a
  // trailing newline from `$(cat file)` is the accident, and silently trimming
  // it would bake a value the operator never verified.
  if (/\s/.test(value)) {
    return {
      ok: false,
      reason:
        "MUON_GITHUB_CLIENT_ID contains whitespace (or a trailing newline). A GitHub client id has none — this looks like a paste or a `$(cat …)` accident, and the value would be baked into a PUBLIC artifact.",
    };
  }
  // ESCAPED, not literal. Written as raw bytes this class made the whole file
  // BINARY to git and grep: `git diff` printed "Bin 6417 bytes" instead of the
  // change, and `grep` skipped the file entirely — on the one module whose job
  // is to stop a credential reaching a public artifact.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return {
      ok: false,
      reason:
        "MUON_GITHUB_CLIENT_ID contains control characters, so it is not a GitHub client id.",
    };
  }

  // 3 — a credential, named as one. Checked BEFORE length, so the message says
  // what it actually is rather than "too long".
  const lower = value.toLowerCase();
  const prefix = SECRET_PREFIXES.find((candidate) => lower.startsWith(candidate));
  if (prefix) {
    return {
      ok: false,
      reason:
        `MUON_GITHUB_CLIENT_ID starts with '${prefix}', which is a GitHub ACCESS TOKEN prefix, not a client id. ` +
        "This value would be published inside the artifact this build produces — the npm manifest and tarball, or the desktop app bundle. Revoke it and set the App's client id instead.",
    };
  }
  if (APP_CLIENT_SECRET.test(value)) {
    return {
      ok: false,
      reason:
        "MUON_GITHUB_CLIENT_ID is 40 hex characters, which is the shape of a GitHub App client SECRET (a client id is ~20). " +
        "This is the wrong variable — it would be published inside the artifact this build produces. Revoke the secret and set the client id.",
    };
  }

  // 2b — length.
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) {
    return {
      ok: false,
      reason:
        `MUON_GITHUB_CLIENT_ID is ${value.length} characters; a GitHub client id is between ${MIN_LENGTH} and ${MAX_LENGTH}. ` +
        "Refusing rather than baking an unrecognised value into a public artifact.",
    };
  }
  if (!SAFE_CHARSET.test(value)) {
    return {
      ok: false,
      reason:
        "MUON_GITHUB_CLIENT_ID contains characters no GitHub client id uses (allowed: letters, digits, '.', '_', '-').",
    };
  }

  // 4 — a shape we recognise.
  if (KNOWN_CLIENT_IDS.some((pattern) => pattern.test(value))) {
    return { ok: true, clientId: value };
  }

  // 5 — plausible, unrecognised. Published with a loud warning rather than a
  // refusal: GitHub has changed this format twice, and blocking a release over a
  // format change is the worse failure.
  return {
    ok: true,
    clientId: value,
    warning:
      `MUON_GITHUB_CLIENT_ID (${value.length} chars) does not match any GitHub client-id shape this guard knows ` +
      "(Iv1.<16 hex>, Iv23li…, Ov23li…, or 20 hex). It passes the safety checks and WILL be baked into the published manifest — " +
      "confirm by hand that it is the App's client id and not a secret.",
  };
}
