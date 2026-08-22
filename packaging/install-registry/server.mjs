#!/usr/bin/env node
// MUON install registry — registry.getmuon.com  (ADR-0052)
//
// A dependency-free node http service, built the same way the download host is
// (Railway service + mounted volume, /healthz, no framework). It does exactly
// one job: when a DISTRIBUTED MUON install verifies a GitHub identity, this
// service confirms that identity against GitHub itself, appends one record, and
// answers with a signed install grant the client caches.
//
// WHAT IT ACCEPTS AND STORES, exhaustively (ADR-0052 Decision 4):
//   ghId, ghLogin  — read from GitHub's /user by THIS service. A claimed login
//                    is never trusted; the client sends no identity at all.
//   surface        — desktop | cli | mcp. A positive set (ADR-0022).
//   version        — the MUON version that registered.
//   platform       — "<platform>-<arch>".
//   firstSeen / lastSeen — this service's clock, deduped by (ghId, surface).
//
// NOTHING ELSE. No workspace paths, no repo names, no code, no usage counters,
// no IP addresses, no request bodies. A request carrying any field outside the
// three accepted ones is REFUSED rather than trimmed, so a client that starts
// over-sharing fails loudly here instead of quietly succeeding. Usage telemetry
// is ADR-0031's consent-gated channel and does not come through this door.
//
// The GitHub access token is used ONCE, in memory, to call /user. It is never
// written to the volume and never logged.
//
// Env:
//   PORT                     — injected by Railway (default 8080)
//   MUON_DATA_DIR            — record directory (default /data, the volume)
//   REGISTRY_SIGNING_SECRET  — HMAC key for install grants. REQUIRED to mint;
//                              absent, POST fails closed with 503.
//   REGISTRY_ADMIN_TOKEN     — bearer for the founder's read. REQUIRED for GET;
//                              absent, GET fails closed with 503.
//   REGISTRY_GITHUB_API      — GitHub API base (default https://api.github.com)
import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.MUON_DATA_DIR || "/data";
const GITHUB_API = (
  process.env.REGISTRY_GITHUB_API || "https://api.github.com"
).replace(/\/$/, "");
const RECORD_FILE = join(DATA_DIR, "installs.jsonl");
/**
 * The DERIVED `(ghId,surface) → firstSeen` index — one line per install, never
 * per registration.
 *
 * Dedup used to stream the WHOLE ledger on every POST, which made registration
 * cost grow with the ledger: the client's registration has a 10 s abort, so past
 * some ledger size every POST would exceed it, answer `unreachable`, and every
 * NEW hard-gated install would be locked out with no local remedy. The ledger is
 * still the append-only audit record; this file is a cache of the one field the
 * write path actually needs to read.
 *
 * It is a CACHE, never the authority: it is rebuilt from the ledger segments on
 * boot whenever it is torn or behind, and a failed write to it is logged rather
 * than failing a registration.
 */
const FIRST_SEEN_FILE = join(DATA_DIR, "first-seen.jsonl");
/** Rotated ledger segments: `installs-<ISO>.jsonl`, sorting chronologically. */
const SEGMENT_PREFIX = "installs-";
const SEGMENT_SUFFIX = ".jsonl";

/**
 * Positive set — a surface absent from this list is refused, never recorded.
 *
 * `mcp` was here and is gone (2026-08-17 review). Nothing ever sent it:
 * `muon-mcp` ships inside the CLI tarball and is opened by `muon login`, which
 * files `cli`. A positive set carrying a member no client produces only widens
 * what this endpoint accepts from something that is not MUON. Kept in step with
 * `INSTALL_SURFACES` in packages/client/src/github-identity-gate.ts.
 */
const SURFACES = new Set(["desktop", "cli"]);
/** Exactly the fields a client may send. Extra OR missing is a 400. */
const BODY_FIELDS = ["surface", "version", "platform"];
const GRANT_VERSION = 1;

const MAX_BODY_BYTES = 4_096;
const MAX_TOKEN_CHARS = 4_096;
const GITHUB_TIMEOUT_MS = 10_000;
/** Bounded read of the ledger, for the founder's GET: an unbounded read is how a
 *  public endpoint turns a volume into a memory limit. Enforced on the READ
 *  (a byte offset), not on a string already in memory — see `readLedgerTail`. */
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
/**
 * RETENTION, stated as a number rather than left to the volume.
 *
 * The live segment is rotated once it passes `MAX_LEDGER_BYTES` and at most
 * `LEDGER_SEGMENTS_KEPT` rotated segments are kept, so the audit record is a
 * bounded set of append-only files rather than one unbounded one:
 * 7 × 8MB ≈ 56MB, ≈ 350k registration rows at the record's ~160 bytes.
 *
 * Rotation never costs a `firstSeen`: that field lives in `FIRST_SEEN_FILE`,
 * which holds one line per install and is never rotated.
 */
const LEDGER_SEGMENTS_KEPT = 6;

// A fixed-window limiter, per client address. This endpoint calls GitHub on the
// caller's behalf, so leaving it unbounded would make MUON a free token-probing
// proxy. Deliberately in-memory: it resets on deploy, which is the right trade
// for a founder-scale service with no dependencies.
//
// 120/min, raised from 30. Behind Railway's proxy `req.socket.remoteAddress` is
// the PROXY, so the bucket was effectively GLOBAL: 30 registrations a minute for
// every MUON install on earth, which turns a launch-day rush into a wall of
// `rate_limited` for people who did nothing wrong. Both halves are fixed — the
// key can now be the real client (TRUST_PROXY below) and the ceiling is a number
// that only an abuser reaches.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
/**
 * A HARD CAP on the number of buckets, not just a sweep.
 *
 * The sweep ran on every fresh key past 10 000 and deleted only EXPIRED buckets,
 * so once that many were live each new key paid a full linear pass and the map
 * still grew — an attacker with addresses to spend got both the memory and the
 * CPU. Pruning now evicts down to a target below the cap, so one expensive pass
 * is followed by thousands of cheap inserts (amortised O(1)) and the map has a
 * ceiling. Eviction is oldest-window-first, and it fails OPEN for whoever is
 * evicted — the same trade the in-memory limiter already makes by resetting on
 * deploy, and the reason the KEY below is a network rather than an address.
 */
const RATE_MAX_KEYS = 20_000;
const RATE_KEYS_TARGET = 16_000;
const buckets = new Map();

/**
 * OPT-IN, and it trusts exactly ONE hop.
 *
 * `X-Forwarded-For` is caller-controlled, so honouring it by default would let
 * anyone spoof a fresh bucket per request and delete the limiter. Set
 * `TRUST_PROXY=1` only when this service sits behind a proxy that APPENDS the
 * real client (Railway does), and then only the LAST hop is read — the entries
 * before it are whatever the caller sent.
 */
const TRUST_PROXY = /^(1|true|on|yes)$/i.test(
  (process.env.TRUST_PROXY || "").trim()
);

/** All eight groups of an IPv6 address, `::` expanded, or null if it is not one. */
function expandIpv6(address) {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [
          ...head,
          ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"),
          ...tail,
        ]
      : head;
  if (groups.length !== 8) return null;
  const normalized = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    normalized.push(parseInt(group, 16).toString(16));
  }
  return normalized;
}

/**
 * THE CLIENT'S NETWORK, NOT ITS ADDRESS. Null when it is neither.
 *
 * An exact address is not a rate-limit identity: a single residential IPv6
 * allocation is a /64, so an attacker rotating the low 64 bits minted an
 * unlimited number of fresh 120/min windows — each one costing an outbound
 * GitHub call, which is the exact abuse this limiter exists to stop. /64 for
 * IPv6 and /24 for IPv4 are the smallest blocks that are handed out as a unit,
 * so they are the smallest thing an ordinary caller cannot rotate inside.
 *
 * `::ffff:1.2.3.4` is an IPv4 network: that is what node reports for an IPv4
 * peer on a dual-stack socket, and keying it as v6 would put every IPv4 client
 * in one bucket.
 */
function networkKey(address) {
  const clean = String(address ?? "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  if (!clean) return null;
  const mapped = /^(?:0*:)+(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/i.exec(clean);
  const v4 = mapped?.[1] ?? clean;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(v4)) {
    const octets = v4.split(".");
    if (octets.some((octet) => Number(octet) > 255)) return null;
    return `v4:${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (!clean.includes(":")) return null;
  const groups = expandIpv6(clean);
  return groups ? `v6:${groups.slice(0, 4).join(":")}::/64` : null;
}

function clientKey(req) {
  const direct = networkKey(req.socket.remoteAddress) ?? "unknown";
  if (!TRUST_PROXY) return direct;
  const header = req.headers["x-forwarded-for"];
  const chain = Array.isArray(header) ? header.join(",") : header || "";
  // LAST, not first: the proxy appends, so the final entry is the only one it
  // vouches for. Taking `[0]` is the spoofable read.
  const hop = chain.split(",").pop()?.trim() || "";
  if (!/^[0-9a-fA-F.:]{3,45}$/.test(hop)) return direct;
  // A hop that passes the shape check but is not an address (`1.2`, `::::`)
  // falls back to the socket rather than becoming a key of its own.
  return networkKey(hop) ?? direct;
}

/** Expired buckets first, then oldest-window-first down to the target. */
function pruneBuckets(now) {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
  if (buckets.size <= RATE_KEYS_TARGET) return;
  // Map iteration is insertion order and every bucket is (re)inserted at the
  // start of its window, so the front of the map is the oldest window.
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (buckets.size <= RATE_KEYS_TARGET) break;
  }
}

function rateLimited(key) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket && now < bucket.resetAt) {
    bucket.count += 1;
    return bucket.count > RATE_MAX;
  }
  // Deleted before re-inserting so insertion order stays window-start order,
  // which is what makes the eviction above oldest-first.
  if (bucket) buckets.delete(key);
  if (buckets.size >= RATE_MAX_KEYS) pruneBuckets(now);
  buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
  return false;
}

/** Seconds until this key's window resets, for a `Retry-After` a client or a
 *  human can act on rather than "try again in a minute" prose alone. */
function rateResetSeconds(key) {
  const bucket = buckets.get(key);
  const remaining = bucket ? bucket.resetAt - Date.now() : RATE_WINDOW_MS;
  return Math.max(1, Math.ceil(remaining / 1_000));
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      ...headers,
    })
    .end(payload);
}

function bearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  const token = match?.[1] ?? "";
  return token.length <= MAX_TOKEN_CHARS ? token : "";
}

/**
 * Constant-time comparison over SHA-256 DIGESTS, not over the secrets.
 *
 * The `a.length === b.length` short-circuit leaked the admin token's length to
 * anyone who could time the endpoint — `timingSafeEqual` requires equal lengths,
 * so the guard was necessary and the leak came with it. Hashing first makes both
 * operands 32 bytes for every input, so the length check is always true and the
 * comparison is the only thing that varies. A wrong-length guess and a
 * wrong-value guess now cost the same.
 */
function secretsMatch(presented, expected) {
  const a = createHash("sha256").update(String(presented)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/**
 * THE REQUEST PATH, from `req.url` and NOTHING ELSE.
 *
 * This used to be `new URL(req.url, `http://${req.headers.host}`)`, and the Host
 * header is attacker-controlled: `Host: ]not a host[` made the base URL throw
 * inside an async handler, which is an unhandled rejection, which on modern node
 * KILLS THE PROCESS. One unauthenticated request, no body, no bearer, and the
 * registry is down for everybody — measured on 2026-08-17, the process died.
 *
 * The fix is not a try/catch around a value this service never needed. Nothing
 * here reads the host, the scheme, or a query parameter, so the base is a FIXED
 * unresolvable placeholder and the header is out of the parse entirely. `null`
 * for a `req.url` node somehow accepted but `URL` will not.
 */
function requestPath(rawUrl) {
  try {
    return new URL(rawUrl || "/", "http://registry.invalid").pathname;
  } catch {
    return null;
  }
}

/**
 * Whether this service can do the job it exists for.
 *
 * Split out because `/healthz` has to answer with it: a deploy missing
 * `REGISTRY_SIGNING_SECRET` used to report a cheerful `ok` while failing every
 * single registration closed with 503 — green dashboard, locked-out users, and
 * nothing anywhere connecting the two.
 */
function mintability() {
  const signing = (process.env.REGISTRY_SIGNING_SECRET || "").trim();
  const admin = (process.env.REGISTRY_ADMIN_TOKEN || "").trim();
  return {
    canMintGrants: signing.length >= 16,
    canServeAdminRead: admin.length > 0,
  };
}

/**
 * A TAGGED RESULT, never a throw. Two failures live here and they are not the
 * same fact:
 *
 *   `too_large`   — this service declined to read the body (413).
 *   `unreadable`  — the connection failed MID-UPLOAD (a reset, a client that
 *                   went away). Nothing was declined; the bytes never arrived.
 *
 * They used to share one rejection and one untyped `catch`, so a mid-upload read
 * error was reported to the caller as `body_too_large` — a person told their
 * request was too big over a network that dropped. The shape is a result rather
 * than a rejection precisely so a future caller cannot re-collapse them by
 * writing one `catch`.
 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        // PAUSE, do not destroy. Destroying here reset the connection before the
        // 413 could be written, so the documented "Body is too large" response
        // was never delivered once — every oversized request looked to the client
        // like `unreachable`, i.e. "your network is down". `refuseOversizedBody`
        // writes the 413 and only then drains and closes.
        req.pause();
        resolve({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflowed) resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (error) => {
      resolve({
        ok: false,
        reason: "unreadable",
        detail: error?.code ?? error?.message ?? "read error",
      });
    });
  });
}

/**
 * How long, and how many bytes, an already-refused upload is drained for.
 *
 * Generous on purpose: the drain is what stops the RST that eats the 413, so it
 * has to outlast an ordinary over-sized body (a client bug sending a few hundred
 * KB) rather than only a marginal one. Nothing is buffered — the bytes are
 * discarded as they arrive — and the 1s timer bounds an abuser who keeps
 * streaming.
 */
const BODY_DRAIN_MS = 1_000;
const MAX_BODY_DRAIN_BYTES = 1024 * 1024;

/**
 * DELIVER THE 413, THEN STOP READING — in that order, and without racing them.
 *
 * Writing the response and destroying the socket on `finish` was still a race
 * the client could lose: `finish` means the bytes left this process, and unread
 * bytes sitting in the receive buffer at close time make the kernel send an RST
 * instead of a FIN — an RST the peer is allowed to answer by discarding
 * everything it has not read yet, INCLUDING the 413. So the request is DRAINED
 * (bounded) so there is nothing unread to force an RST, `Connection: close` lets
 * node close the socket itself once the response has flushed, and the destroy is
 * only the backstop for a caller still streaming after the grace.
 */
function refuseOversizedBody(req, res) {
  json(
    res,
    413,
    {
      error: "body_too_large",
      message: `Body is too large; this registry accepts at most ${MAX_BODY_BYTES} bytes.`,
    },
    { connection: "close" }
  );
  let drained = 0;
  const stop = () => {
    clearTimeout(timer);
    req.destroy();
  };
  const timer = setTimeout(stop, BODY_DRAIN_MS);
  timer.unref?.();
  req.on("data", (chunk) => {
    drained += chunk.length;
    // A caller still streaming megabytes after being refused gets the abrupt
    // close; the honest client whose body was slightly too big does not.
    if (drained > MAX_BODY_DRAIN_BYTES) stop();
  });
  req.once("end", () => clearTimeout(timer));
  req.resume();
}

/** Strict validation. Unknown fields are a refusal, not a strip. */
function parseInstallBody(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Body must be JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const keys = Object.keys(parsed);
  const unknown = keys.filter((key) => !BODY_FIELDS.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `This registry accepts only ${BODY_FIELDS.join(", ")}; refused unknown field(s): ${unknown.join(", ")}.`,
    };
  }
  for (const field of BODY_FIELDS) {
    if (typeof parsed[field] !== "string") {
      return { ok: false, message: `Field '${field}' must be a string.` };
    }
  }
  if (!SURFACES.has(parsed.surface)) {
    return {
      ok: false,
      message: `Field 'surface' must be one of ${[...SURFACES].join(", ")}.`,
    };
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(parsed.version)) {
    return { ok: false, message: "Field 'version' is not a version string." };
  }
  if (!/^[a-z0-9]{1,32}-[a-z0-9_]{1,32}$/.test(parsed.platform)) {
    return {
      ok: false,
      message: "Field 'platform' must look like '<platform>-<arch>'.",
    };
  }
  return {
    ok: true,
    value: {
      surface: parsed.surface,
      version: parsed.version,
      platform: parsed.platform,
    },
  };
}

/**
 * Is this GitHub answer a RATE LIMIT rather than a verdict on the credential?
 *
 * GitHub signals both of its limits with a status this service must not read as
 * "that identity is bad": the primary limit is a 403 or 429 with
 * `x-ratelimit-remaining: 0`, and the secondary (abuse) limit is a 403 or 429
 * carrying `retry-after`. Both are about MUON's own call volume.
 */
function upstreamRateLimited(response) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  );
}

/** GitHub's `Retry-After`, bounded — echoed as a number this service vouches for
 *  rather than a header value passed straight through. */
function retryAfterSeconds(response, fallback) {
  const raw = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(3_600, Math.ceil(raw));
}

/**
 * Ask GitHub who this token belongs to.
 *
 * AN UPSTREAM FAILURE IS NOT A REJECTED IDENTITY, and collapsing the two locked
 * honest people out. Every non-OK status used to answer 401, which the client
 * maps to `unauthorized` → "GitHub did not verify that sign-in. Run the sign-in
 * again." So a GitHub 5xx, or a 403 secondary rate limit during a launch-day
 * rush, told a hard-gated CLI/desktop user that their identity was bad and sent
 * them to re-run the one thing that cannot help.
 *
 * The status is the whole contract here — the client branches on it and never
 * reads this body — so each case gets the status that carries the right remedy:
 *
 *   401  the token IS rejected (401/403 on the credential). "Sign in again."
 *   429  GitHub is rate limiting MUON's verification call. Retryable, and the
 *        client already has a typed `rate_limited` code for exactly this.
 *   503  GitHub could not answer (5xx, timeout, DNS). Retryable.
 *   502  GitHub answered something this service cannot read as an identity.
 */
async function verifyGitHubIdentity(token) {
  let response;
  try {
    response = await fetch(`${GITHUB_API}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "muon-install-registry",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      status: 503,
      error: "github_unavailable",
      message:
        "GitHub could not be reached to verify that sign-in. Nothing about the sign-in is wrong — try again shortly.",
    };
  }
  if (response.status >= 500) {
    return {
      ok: false,
      status: 503,
      error: "github_unavailable",
      message: `GitHub answered ${response.status} when this registry asked it to verify that sign-in. Nothing about the sign-in is wrong — try again shortly.`,
    };
  }
  // BEFORE the 401/403 branch: a rate-limited 403 is a 403, and reading it as a
  // rejected credential is the lockout this ordering exists to prevent.
  if (upstreamRateLimited(response)) {
    return {
      ok: false,
      status: 429,
      error: "rate_limited",
      retryAfter: retryAfterSeconds(response, 60),
      message:
        "GitHub is rate limiting this registry's verification calls right now. Try again in a minute; nothing about this sign-in is wrong.",
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: 401,
      error: "identity_unverified",
      message: "GitHub did not verify that credential.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "github_unreadable",
      message: `GitHub answered ${response.status} when this registry asked who that credential belongs to, which is not a verdict on the sign-in.`,
    };
  }
  let user;
  try {
    user = await response.json();
  } catch {
    return {
      ok: false,
      status: 502,
      error: "github_unreadable",
      message: "GitHub returned an unreadable identity.",
    };
  }
  if (
    user === null ||
    typeof user !== "object" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    typeof user.login !== "string" ||
    user.login.length < 1 ||
    user.login.length > 100
  ) {
    return {
      ok: false,
      status: 502,
      error: "github_unreadable",
      message: "GitHub returned an unreadable identity.",
    };
  }
  return { ok: true, id: user.id, login: user.login };
}

/**
 * One JSONL file, streamed a line at a time in O(1) memory.
 *
 * `ok: false` means the file could not be read TO THE END — which is never the
 * same fact as "there was nothing in it". An ABSENT file is `ok: true`: nothing
 * to read is not a failure to read. `torn: true` means a line would not parse (a
 * partial write), which is skipped rather than fatal but is worth acting on.
 */
async function streamJsonl(filePath, onRow) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let torn = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        torn = true;
        continue;
      }
      onRow(row);
    }
    return { ok: true, torn };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, torn };
    return { ok: false, torn };
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The rotated segments on the volume, oldest first. `null` = could not tell,
 *  which is never reported as "there are none". */
async function ledgerSegments() {
  try {
    const names = await readdir(DATA_DIR);
    return names
      .filter(
        (name) => name.startsWith(SEGMENT_PREFIX) && name.endsWith(SEGMENT_SUFFIX)
      )
      .sort();
  } catch (error) {
    return error?.code === "ENOENT" ? [] : null;
  }
}

/** `streamJsonl`'s sibling for the bounded read: raw lines from a byte offset, so
 *  the caller decides what a first partial line means. */
async function streamLinesFrom(filePath, start, onLine) {
  const stream = createReadStream(filePath, { encoding: "utf8", start });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      onLine(line);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error?.code ?? error?.message ?? "read error" };
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * The BOUNDED read, for the founder's GET only.
 *
 * TWO FLAGS, and they are different facts:
 *   `truncated` — this table is not the whole ledger (a byte-bounded tail, or
 *                 rotated segments exist that it does not include).
 *   `complete`  — the read DID WHAT IT SET OUT TO DO. It used to be missing
 *                 entirely: the catch answered `{rows: [], truncated: false}`,
 *                 so a permission error or an I/O fault printed "nobody has
 *                 installed MUON" as a complete table.
 *
 * The bound is now enforced on the READ, at a byte offset, rather than on a
 * string already in memory — `readFile` then `.slice()` bounded nothing at all,
 * which is precisely the disk-into-a-memory-limit this constant exists to stop.
 */
async function readLedgerTail() {
  const segments = await ledgerSegments();
  let truncated = segments === null || segments.length > 0;
  const complete = segments !== null;
  const detail =
    segments === null
      ? "the data directory could not be listed, so this table may omit rotated ledger segments"
      : "";
  let size = 0;
  try {
    ({ size } = await stat(RECORD_FILE));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        rows: [],
        truncated: true,
        complete: false,
        detail: `the ledger could not be opened (${error?.code ?? "read error"})`,
      };
    }
    // An absent live segment is a real answer: nobody has registered here.
    return { rows: [], truncated, complete, detail };
  }
  const start = Math.max(0, size - MAX_LEDGER_BYTES);
  if (start > 0) truncated = true;
  const rows = [];
  let first = true;
  const result = await streamLinesFrom(RECORD_FILE, start, (line) => {
    // An offset read can land mid-line, so the first line is DROPPED rather than
    // parsed: a fragment that happened to parse would be a row this service
    // invented.
    if (first) {
      first = false;
      if (start > 0) return;
    }
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partial write is skipped rather than failing the read.
    }
  });
  if (!result.ok) {
    return {
      rows,
      truncated: true,
      complete: false,
      detail: `the ledger read failed part-way through (${result.detail})`,
    };
  }
  return { rows, truncated, complete, detail };
}

// ── The derived firstSeen index ─────────────────────────────────────────────
//
// `firstSeen` is the one immutable field on the record, and deriving it used to
// mean streaming the WHOLE ledger on EVERY POST. That is an O(ledger) write path
// on a client with a 10s abort: past some size every registration answers
// `unreachable` and every NEW hard-gated install is locked out with no local
// remedy. The ledger stays append-only — it is the audit record — and the write
// path reads this in-memory map instead.

/** key `<ghId>:<surface>` → `{ ghId, surface, firstSeen }`. */
const firstSeenIndex = new Map();
/**
 * False when the boot rebuild could not read every source to the end.
 *
 * A partial index may hold a LATER first sighting than the truth, so while it is
 * untrusted nothing is written to the sidecar — an in-memory guess must not
 * become the durable record. Registrations continue: refusing them would be the
 * lockout this whole change exists to remove, and the ledger still carries every
 * row, so the next boot re-derives the correct value.
 */
let firstSeenTrusted = true;
let firstSeenLoad = null;

function firstSeenKeyFor(ghId, surface) {
  return `${ghId}:${surface}`;
}

/** Fold one ledger/sidecar row in, earliest wins. True when it CHANGED the map,
 *  which is how the sidecar learns it was behind. */
function adoptFirstSeen(row) {
  const ghId = row?.ghId;
  const surface = row?.surface;
  const firstSeen = row?.firstSeen;
  if (
    typeof ghId !== "number" ||
    typeof surface !== "string" ||
    typeof firstSeen !== "string"
  ) {
    return false;
  }
  const key = firstSeenKeyFor(ghId, surface);
  const known = firstSeenIndex.get(key);
  // Lexicographic on ISO-8601 IS chronological.
  if (known !== undefined && known.firstSeen <= firstSeen) return false;
  firstSeenIndex.set(key, { ghId, surface, firstSeen });
  return true;
}

/** Rewritten via a temp file and a rename: a crash leaves the OLD index intact
 *  rather than half of a new one. */
async function rewriteFirstSeenIndex() {
  const body = [...firstSeenIndex.values()]
    .map((entry) => `${JSON.stringify(entry)}\n`)
    .join("");
  const tmp = `${FIRST_SEEN_FILE}.${process.pid}.tmp`;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(tmp, body, "utf8");
    await rename(tmp, FIRST_SEEN_FILE);
  } catch (error) {
    // Derived data. The ledger already carries every firstSeen, so a failure
    // here costs a rebuild next boot and nothing else.
    console.warn(
      `[install-registry] could not rewrite the firstSeen index: ${error?.message ?? error}`
    );
  }
}

/**
 * REBUILD ON BOOT, FROM THE LEDGER, ALWAYS.
 *
 * The sidecar is read first because it survives rotation, and then every
 * retained ledger segment is folded in — so a TORN sidecar, or a crash between
 * the ledger append and the sidecar append, cannot silently lose a `firstSeen`.
 * Whenever the ledger knew something the sidecar did not, the sidecar is
 * rewritten and converges.
 *
 * Paid ONCE per process and bounded by retention (`LEDGER_SEGMENTS_KEPT`), which
 * is the trade: a slower boot in exchange for a write path that does not stream
 * the ledger per request.
 */
async function loadFirstSeenIndex() {
  const sidecar = await streamJsonl(FIRST_SEEN_FILE, (row) => {
    adoptFirstSeen(row);
  });
  let readable = sidecar.ok;
  let behind = false;
  const segments = await ledgerSegments();
  if (segments === null) readable = false;
  // Oldest segment first, live segment last, so the earliest sighting wins by
  // arrival as well as by comparison.
  for (const file of [
    ...(segments ?? []).map((name) => join(DATA_DIR, name)),
    RECORD_FILE,
  ]) {
    const result = await streamJsonl(file, (row) => {
      if (adoptFirstSeen(row)) behind = true;
    });
    if (!result.ok) readable = false;
  }
  firstSeenTrusted = readable;
  if (!readable) {
    console.error(
      "[install-registry] the firstSeen index could not be fully rebuilt from the ledger. " +
        "Registrations continue and NOTHING is dropped, but firstSeen may move forward once for an install whose earliest row was unreadable, " +
        "and the index file is left untouched until a boot can read it."
    );
  } else if (behind || sidecar.torn) {
    await rewriteFirstSeenIndex();
  }
  return firstSeenIndex;
}

/**
 * Built once, and NEVER a rejected promise: this is awaited by the write path, so
 * a rejection cached here would refuse every registration for the life of the
 * process — a service-wide lockout in the name of a derived cache. A rebuild that
 * fails degrades to whatever it managed to read, says so, and stops writing the
 * sidecar.
 */
function ensureFirstSeenIndex() {
  firstSeenLoad ??= loadFirstSeenIndex().catch((error) => {
    firstSeenTrusted = false;
    console.error(
      `[install-registry] the firstSeen index rebuild threw (${error?.message ?? error}); ` +
        "registrations continue against a partial index and the index file is left untouched."
    );
    return firstSeenIndex;
  });
  return firstSeenLoad;
}

/**
 * ROTATION, so the append-only ledger is a bounded SET of append-only files.
 *
 * Never on the read path and never rewriting a row: the live segment is renamed
 * and a fresh one starts. `firstSeen` survives it in the sidecar, which is why
 * dropping the oldest segments costs history and never the record's immutable
 * field.
 */
async function rotateLedgerIfNeeded() {
  let size;
  try {
    ({ size } = await stat(RECORD_FILE));
  } catch {
    return; // nothing to rotate
  }
  if (size < MAX_LEDGER_BYTES) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(
      RECORD_FILE,
      join(DATA_DIR, `${SEGMENT_PREFIX}${stamp}${SEGMENT_SUFFIX}`)
    );
    const segments = (await ledgerSegments()) ?? [];
    for (const name of segments.slice(
      0,
      Math.max(0, segments.length - LEDGER_SEGMENTS_KEPT)
    )) {
      await rm(join(DATA_DIR, name), { force: true });
    }
  } catch (error) {
    // A rotation that cannot happen must not refuse a registration: the append
    // below still lands, on a file that is one segment too big.
    console.warn(
      `[install-registry] ledger rotation failed: ${error?.message ?? error}`
    );
  }
}

/**
 * SERIALISED, so two concurrent registrations cannot interleave a rotation with
 * an append and leave a renamed file underneath a write.
 */
let ledgerWrites = Promise.resolve();
function serializeLedgerWrite(task) {
  const run = ledgerWrites.then(task, task);
  ledgerWrites = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * APPEND-ONLY, with dedup derived from the index above.
 *
 * Every registration appends a row; `firstSeen` is carried forward from the
 * earliest sighting of the same (ghId, surface). Nothing is ever rewritten, so
 * the file stays a ledger — and "who installed MUON" is the collapse of it, not
 * a mutable table somebody could quietly correct.
 */
async function recordInstall(identity, body, at) {
  return serializeLedgerWrite(async () => {
    await ensureFirstSeenIndex();
    const key = firstSeenKeyFor(identity.id, body.surface);
    const known = firstSeenIndex.get(key);
    const firstSeen = known?.firstSeen ?? at;
    const record = {
      ghId: identity.id,
      ghLogin: identity.login,
      surface: body.surface,
      version: body.version,
      platform: body.platform,
      firstSeen,
      lastSeen: at,
    };
    await mkdir(DATA_DIR, { recursive: true });
    await rotateLedgerIfNeeded();
    // THE LEDGER FIRST: it is the audit record and the authority for `firstSeen`.
    // A crash between these two writes costs nothing — the boot rebuild folds
    // the ledger back into the index.
    await appendFile(RECORD_FILE, `${JSON.stringify(record)}\n`, "utf8");
    if (!known) {
      const entry = { ghId: identity.id, surface: body.surface, firstSeen };
      firstSeenIndex.set(key, entry);
      if (firstSeenTrusted) {
        try {
          await appendFile(
            FIRST_SEEN_FILE,
            `${JSON.stringify(entry)}\n`,
            "utf8"
          );
        } catch (error) {
          console.warn(
            `[install-registry] could not append to the firstSeen index: ${error?.message ?? error}`
          );
        }
      }
    }
    return record;
  });
}

function mintGrant(identity, surface, issuedAt, secret) {
  return {
    token: createHmac("sha256", secret)
      .update(`${identity.id}:${surface}:${issuedAt}`)
      .digest("hex"),
    issuedAt,
    version: GRANT_VERSION,
  };
}

/** The founder's read: one row per (ghId, surface), latest wins. */
function collapseLedger(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (typeof row?.ghId !== "number" || typeof row?.surface !== "string") continue;
    const key = `${row.ghId}:${row.surface}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      ghId: row.ghId,
      ghLogin: row.ghLogin,
      surface: row.surface,
      version: row.version,
      platform: row.platform,
      firstSeen: existing?.firstSeen ?? row.firstSeen,
      lastSeen: row.lastSeen,
    });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      String(right.lastSeen).localeCompare(String(left.lastSeen)) ||
      left.ghId - right.ghId
  );
}

async function handle(req, res) {
  const pathname = requestPath(req.url);
  if (pathname === null) {
    json(res, 400, { error: "bad_request", message: "Unparseable request URL." });
    return;
  }

  if (pathname === "/healthz") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    // 200 EITHER WAY, deliberately: Railway's healthcheckPath treats a non-200
    // as a failed deploy, and refusing to come up is worse than coming up
    // degraded — a rollback loop hides the misconfiguration instead of naming it.
    // So the STATUS stays 200 and the BODY tells the truth, which is what the
    // founder curls and what the boot log already shouted.
    const { canMintGrants, canServeAdminRead } = mintability();
    const body = canMintGrants
      ? "ok"
      : "degraded: cannot mint grants (REGISTRY_SIGNING_SECRET is unset or under 16 chars) — every new install will be refused with 503";
    res
      .writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        // Machine-readable beside the prose, so an uptime check can alert on the
        // degraded case without string-matching the copy.
        "x-registry-can-mint": canMintGrants ? "1" : "0",
        "x-registry-can-read": canServeAdminRead ? "1" : "0",
      })
      .end(req.method === "HEAD" ? undefined : `${body}\n`);
    return;
  }

  if (pathname !== "/v1/installs") {
    json(res, 404, { error: "not_found", message: "No such endpoint." });
    return;
  }

  const client = clientKey(req);
  if (rateLimited(client)) {
    json(
      res,
      429,
      {
        error: "rate_limited",
        message: "Too many registration attempts. Try again in a minute.",
      },
      { "retry-after": String(rateResetSeconds(client)) }
    );
    return;
  }

  // ── The founder's read ────────────────────────────────────────────────────
  if (req.method === "GET") {
    const admin = process.env.REGISTRY_ADMIN_TOKEN?.trim() || "";
    if (!admin) {
      json(res, 503, {
        error: "admin_not_configured",
        message: "REGISTRY_ADMIN_TOKEN is not configured on this service.",
      });
      return;
    }
    const presented = bearer(req);
    if (!presented || !secretsMatch(presented, admin)) {
      json(res, 401, { error: "unauthorized", message: "Admin bearer required." });
      return;
    }
    const { rows, truncated, complete, detail } = await readLedgerTail();
    const installs = collapseLedger(rows);
    if (!complete) {
      // A READ THAT FAILED IS NOT AN EMPTY TABLE. This used to answer 200 with
      // `{installs: [], truncated: false}` on any read error, so the founder's own
      // "who installed MUON" could print "nobody" over a permission error or an
      // I/O fault. Whatever WAS read is still handed over — it is real — but the
      // status and the flags say it is not the whole answer.
      json(res, 500, {
        error: "ledger_unreadable",
        message: `This table is INCOMPLETE: ${detail}. Do not read it as the whole ledger.`,
        installs,
        count: installs.length,
        truncated: true,
        complete: false,
      });
      return;
    }
    // `truncated` is stated rather than implied: a partial table that reads as
    // whole is the one way this answer can be confidently wrong.
    json(res, 200, { installs, count: installs.length, truncated, complete: true });
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  // ── Registration ──────────────────────────────────────────────────────────
  const secret = process.env.REGISTRY_SIGNING_SECRET?.trim() || "";
  if (secret.length < 16) {
    // FAIL CLOSED: a service that cannot sign must not hand out an unsigned
    // grant, and must not record an install it cannot answer for.
    json(res, 503, {
      error: "signing_not_configured",
      message: "This registry cannot issue install grants right now.",
    });
    return;
  }

  const token = bearer(req);
  if (!token) {
    json(res, 401, {
      error: "unauthorized",
      message: "A GitHub bearer token is required.",
    });
    return;
  }

  const read = await readBody(req);
  if (!read.ok) {
    if (read.reason === "too_large") {
      // The 413 has to REACH THE WIRE, so it is written before anything is torn
      // down — otherwise the client sees a connection reset and reports "the
      // registry could not be reached", which sends a person to check their
      // network over a body this service simply declined to read.
      refuseOversizedBody(req, res);
      return;
    }
    // NOT a 413. The connection failed mid-upload, and reporting that as
    // `body_too_large` told a person their request was too big over a network
    // that dropped.
    json(res, 400, {
      error: "body_unreadable",
      message: `The request body could not be read to the end (${read.detail}). Nothing was recorded; try again.`,
    });
    return;
  }
  const body = parseInstallBody(read.raw);
  if (!body.ok) {
    json(res, 400, { error: "invalid_body", message: body.message });
    return;
  }

  const identity = await verifyGitHubIdentity(token);
  if (!identity.ok) {
    // The STATUS is the contract (the client branches on it and never reads this
    // body), and the typed `error` is per case rather than one blanket
    // `identity_unverified` — an upstream failure is not a rejected identity.
    json(
      res,
      identity.status,
      { error: identity.error, message: identity.message },
      identity.retryAfter ? { "retry-after": String(identity.retryAfter) } : {}
    );
    return;
  }

  const issuedAt = new Date().toISOString();
  let record;
  try {
    record = await recordInstall(identity, body.value, issuedAt);
  } catch (error) {
    json(res, 500, {
      error: "record_failed",
      message: "The registry could not record this install. Try again.",
    });
    console.error(`[install-registry] record failed: ${error?.message ?? error}`);
    return;
  }

  // Log the RECORD, never the token. This line is the founder's live signal
  // that an install happened.
  console.log(
    `[install-registry] ${record.surface} ${record.version} ${record.platform} — ${record.ghLogin} (${record.ghId})`
  );
  json(res, 200, {
    github: { id: identity.id, login: identity.login },
    grant: mintGrant(identity, body.value.surface, issuedAt, secret),
  });
}

/**
 * THE LAST GUARD, and the reason it exists is worth naming.
 *
 * An `async` request handler that throws produces an unhandled rejection, and on
 * modern node an unhandled rejection EXITS THE PROCESS. One malformed Host header
 * from an unauthenticated caller took the whole registry down. `requestPath`
 * removes that specific throw; this removes the CLASS of it, so the next line
 * somebody adds inside the handler cannot turn a bad request into an outage.
 *
 * 500 with no detail: the caller learns the request failed, and the operator
 * learns why from the log.
 */
const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(
      `[install-registry] unhandled request error: ${error?.stack ?? error}`
    );
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, 500, {
      error: "internal_error",
      message: "The registry could not handle that request.",
    });
  });
});

server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.maxHeadersCount = 64;

server.listen(PORT, () => {
  console.log(`[install-registry] recording to ${RECORD_FILE} on :${PORT}`);
  // STARTED HERE so the first registration does not pay for it. The rebuild is
  // the one O(ledger) read left in this service, and it happens once per process
  // instead of once per POST — which is the whole point of the index. Never
  // awaited: `/healthz` must answer while it runs, or Railway calls the deploy
  // failed and rolls back over a slow volume read.
  ensureFirstSeenIndex().then((index) =>
    console.log(
      `[install-registry] firstSeen index ready: ${index.size} install(s)${
        firstSeenTrusted ? "" : " — PARTIAL, see the error above"
      }`
    )
  );
  // LOUD AT BOOT. A service that cannot sign refuses every registration with a
  // 503 while /healthz used to answer a cheerful `ok` — the misconfiguration was
  // invisible from every surface a founder actually looks at.
  const { canMintGrants, canServeAdminRead } = mintability();
  if (!canMintGrants) {
    console.error(
      "[install-registry] MISCONFIGURED: REGISTRY_SIGNING_SECRET is unset or under 16 chars. " +
        "This service is UP and will refuse EVERY registration with 503, so no new install can open its gate. " +
        "/healthz reports `degraded` until this is set."
    );
  }
  if (!canServeAdminRead) {
    console.warn(
      "[install-registry] REGISTRY_ADMIN_TOKEN is unset — the who-installed read (GET /v1/installs) fails closed with 503."
    );
  }
});
