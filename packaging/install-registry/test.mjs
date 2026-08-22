#!/usr/bin/env node
// Seeded check for the install registry (ADR-0052): boots the REAL server on an
// ephemeral port against a temp volume and a stub GitHub, then verifies the
// twenty-one behaviours that matter — identity refusal, the record shape,
// (ghId,surface) dedup, unknown-field refusal, the `mcp` surface being gone from
// the positive set, signing fail-closed, admin auth on the read, that the token
// never lands on the volume, the admin read reporting `truncated`, TRUST_PROXY
// honouring only the LAST forwarded hop, `firstSeen` matching the whole ledger,
// /healthz telling the truth about mintability, the two ways an unauthenticated
// caller used to be able to hurt this service (a malformed Host header, which
// killed the process, and an oversized body, which reset the connection instead
// of answering 413), and the five lockout/honesty defects a 2026-08-17
// adversarial triage found:
//
//   14  a GitHub 5xx answers a RETRYABLE 503, not "your identity is bad"
//   15  a GitHub rate limit (429, and both 403 shapes) answers 429 + Retry-After
//   16  a GitHub 403 ON THE TOKEN is still a 401
//   17  registration stays FAST against a large ledger, and rotation keeps
//       `firstSeen` exactly where it was
//   18  a TORN firstSeen index rebuilds from the ledger rather than losing it
//   19  the founder's read never reports a FAILED read as a complete table
//   20  the limiter keys on the NETWORK (/64, /24), so rotating addresses inside
//       one allocation cannot mint fresh windows
//   21  a large oversized body still gets its 413 delivered, and an upload that
//       dies mid-flight is never labelled `body_too_large`
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "muon-registry-"));
const SIGNING_SECRET = "test-signing-secret-0123456789abcdef";
const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
const GOOD_TOKEN = "gho_good_token_value";

/**
 * Tokens the stub answers with an UPSTREAM condition rather than an identity.
 *
 * The point of these is the one distinction that used to be missing: GitHub
 * being unable (or unwilling, for rate) to answer is NOT a verdict on the
 * caller's credential, and collapsing the two told honest people their sign-in
 * was bad and locked a hard-gated install out with a remedy that cannot work.
 */
const UPSTREAM_TOKENS = {
  gho_github_500: { status: 500 },
  gho_github_503: { status: 503 },
  gho_github_429: { status: 429, headers: { "retry-after": "42" } },
  // GitHub's SECONDARY limit: a 403 carrying retry-after.
  gho_secondary_403: { status: 403, headers: { "retry-after": "17" } },
  // GitHub's PRIMARY limit: a 403 with the remaining budget at zero.
  gho_primary_403: { status: 403, headers: { "x-ratelimit-remaining": "0" } },
  // A plain 403: this one IS about the token.
  gho_forbidden_403: { status: 403 },
};

// A stub GitHub: verifies exactly one token, answers the table above for the
// upstream cases, and 401s everything else — so "the SERVICE decides the
// identity" is what is under test rather than a mocked client's claim about it.
const github = createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  const token = /^Bearer\s+(\S+)$/.exec(auth)?.[1] ?? "";
  if (req.url !== "/user") {
    res.writeHead(401, { "content-type": "application/json" }).end("{}");
    return;
  }
  const upstream = UPSTREAM_TOKENS[token];
  if (upstream) {
    res
      .writeHead(upstream.status, {
        "content-type": "application/json",
        ...(upstream.headers ?? {}),
      })
      .end("{}");
    return;
  }
  if (token !== GOOD_TOKEN) {
    res.writeHead(401, { "content-type": "application/json" }).end("{}");
    return;
  }
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ id: 583231, login: "octocat", email: "leaked@example.com" }));
});
await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
const githubBase = `http://127.0.0.1:${github.address().port}`;

const children = [];
const scratchDirs = [];
function boot(env) {
  const port = 18500 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [join(here, "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      MUON_DATA_DIR: dataDir,
      REGISTRY_GITHUB_API: githubBase,
      REGISTRY_SIGNING_SECRET: "",
      REGISTRY_ADMIN_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return { child, base: `http://127.0.0.1:${port}` };
}

/** A configured service on its OWN volume, so a behaviour that seeds or breaks
 *  the ledger cannot change what the shared assertions above are reading. */
function bootOn(dir, env = {}) {
  scratchDirs.push(dir);
  return boot({
    MUON_DATA_DIR: dir,
    REGISTRY_SIGNING_SECRET: SIGNING_SECRET,
    REGISTRY_ADMIN_TOKEN: ADMIN_TOKEN,
    ...env,
  });
}

function scratchDir() {
  return mkdtempSync(join(tmpdir(), "muon-registry-scratch-"));
}

/** Waits for the boot line AND for the firstSeen index, so a behaviour that
 *  depends on the rebuilt index is not racing it. */
async function bootedAndIndexed(booted) {
  await new Promise((resolve) => {
    let seen = "";
    const onData = (chunk) => {
      seen += String(chunk);
      if (seen.includes("firstSeen index ready")) {
        booted.child.stdout.off("data", onData);
        resolve();
      }
    };
    booted.child.stdout.on("data", onData);
  });
}

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

const post = (base, body, token) =>
  fetch(`${base}/v1/installs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

try {
  // ── 1. Signing fail-closed: no secret, no grant, no record ────────────────
  //      AND /healthz says so, instead of a cheerful `ok`.
  {
    const { child, base } = boot({ REGISTRY_ADMIN_TOKEN: ADMIN_TOKEN });
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const health = await fetch(`${base}/healthz`);
    // 200 is required: Railway treats a non-200 healthcheck as a failed deploy,
    // and a rollback loop hides the misconfiguration rather than naming it.
    if (health.status !== 200) fail(`healthz ${health.status}`);
    const healthBody = await health.text();
    if (!healthBody.includes("degraded"))
      fail(`a registry that cannot mint must report degraded, got ${JSON.stringify(healthBody)}`);
    if (!healthBody.includes("REGISTRY_SIGNING_SECRET"))
      fail("the degraded body must name the variable to set");
    if (health.headers.get("x-registry-can-mint") !== "0")
      fail("degraded health must be machine-readable too");

    const res = await post(
      base,
      { surface: "cli", version: "0.4.1", platform: "darwin-arm64" },
      GOOD_TOKEN
    );
    if (res.status !== 503)
      fail(`a registry with no signing secret must fail closed, got ${res.status}`);
    child.kill();
  }

  // ── The configured service ────────────────────────────────────────────────
  const { child, base } = boot({
    REGISTRY_SIGNING_SECRET: SIGNING_SECRET,
    REGISTRY_ADMIN_TOKEN: ADMIN_TOKEN,
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));

  // ── 2. A token GitHub does not verify is refused ──────────────────────────
  {
    const res = await post(
      base,
      { surface: "cli", version: "0.4.1", platform: "darwin-arm64" },
      "gho_forged"
    );
    if (res.status !== 401) fail(`unverified token should 401, got ${res.status}`);
    const missing = await post(base, {
      surface: "cli",
      version: "0.4.1",
      platform: "darwin-arm64",
    });
    if (missing.status !== 401) fail(`no bearer should 401, got ${missing.status}`);
  }

  // ── 3. Unknown fields are REFUSED, not trimmed ────────────────────────────
  {
    const res = await post(
      base,
      {
        surface: "cli",
        version: "0.4.1",
        platform: "darwin-arm64",
        workspacePath: "/Users/someone/secret-repo",
      },
      GOOD_TOKEN
    );
    if (res.status !== 400)
      fail(`an extra field must be refused, got ${res.status}`);
    const body = await res.json();
    if (!String(body.message).includes("workspacePath"))
      fail("the refusal must name the field it refused");

    const badSurface = await post(
      base,
      { surface: "tui", version: "0.4.1", platform: "darwin-arm64" },
      GOOD_TOKEN
    );
    if (badSurface.status !== 400)
      fail(`a surface outside the positive set must be refused, got ${badSurface.status}`);

    // `mcp` is GONE from the positive set (2026-08-17 review): no MUON client
    // ever sent it, and a positive set must not carry a dead member. Pinned so
    // it cannot drift back in on one side only.
    const deadSurface = await post(
      base,
      { surface: "mcp", version: "0.4.1", platform: "darwin-arm64" },
      GOOD_TOKEN
    );
    if (deadSurface.status !== 400)
      fail(`the retired 'mcp' surface must be refused, got ${deadSurface.status}`);
  }

  // ── 4. The happy path: verified identity, signed grant, one record ────────
  {
    const res = await post(
      base,
      { surface: "cli", version: "0.4.1", platform: "darwin-arm64" },
      GOOD_TOKEN
    );
    if (res.status !== 200) fail(`registration ${res.status}`);
    const body = await res.json();
    if (body.github?.id !== 583231 || body.github?.login !== "octocat")
      fail("the response must carry the identity the SERVICE verified");
    if (body.grant?.version !== 1) fail("grant version must be 1");
    if (!/^[0-9a-f]{64}$/.test(body.grant?.token ?? ""))
      fail("grant token must be a sha256 hex HMAC");
    const expected = createHmac("sha256", SIGNING_SECRET)
      .update(`583231:cli:${body.grant.issuedAt}`)
      .digest("hex");
    if (body.grant.token !== expected)
      fail("grant HMAC must cover (ghId, surface, issuedAt)");
  }

  // ── 5. Dedup by (ghId, surface); a different surface is its own row ───────
  {
    await post(
      base,
      { surface: "cli", version: "0.4.2", platform: "darwin-arm64" },
      GOOD_TOKEN
    );
    await post(
      base,
      { surface: "desktop", version: "0.4.2", platform: "darwin-arm64" },
      GOOD_TOKEN
    );
    const res = await fetch(`${base}/v1/installs`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    if (res.status !== 200) fail(`admin read ${res.status}`);
    const { installs, count, truncated } = await res.json();
    if (count !== 2) fail(`expected 2 collapsed rows (cli, desktop), got ${count}`);
    // The admin read STATES whether it sliced. A partial table that reads as
    // whole is the one way this answer can be confidently wrong.
    if (truncated !== false)
      fail(`a small ledger must report truncated:false, got ${truncated}`);
    const cli = installs.find((row) => row.surface === "cli");
    if (!cli) fail("the cli row is missing");
    if (cli.version !== "0.4.2") fail("lastSeen row must carry the newest version");
    if (cli.firstSeen === cli.lastSeen)
      fail("firstSeen must be carried forward from the FIRST registration");
    if (Object.keys(cli).sort().join(",") !==
      "firstSeen,ghId,ghLogin,lastSeen,platform,surface,version")
      fail(`the record shape drifted: ${Object.keys(cli).sort().join(",")}`);
  }

  // ── 6. Admin auth on the read ─────────────────────────────────────────────
  {
    const anon = await fetch(`${base}/v1/installs`);
    if (anon.status !== 401) fail(`anonymous read should 401, got ${anon.status}`);
    const wrong = await fetch(`${base}/v1/installs`, {
      headers: { authorization: "Bearer nope" },
    });
    if (wrong.status !== 401) fail(`wrong admin bearer should 401, got ${wrong.status}`);
    // The GitHub token is NOT an admin credential.
    const asUser = await fetch(`${base}/v1/installs`, {
      headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    });
    if (asUser.status !== 401)
      fail(`a GitHub token must not read the table, got ${asUser.status}`);
  }

  // ── 7. Nothing but the record reaches the volume ──────────────────────────
  {
    const ledger = readFileSync(join(dataDir, "installs.jsonl"), "utf8");
    if (ledger.includes(GOOD_TOKEN))
      fail("the GitHub token must never be written to the volume");
    if (ledger.includes("leaked@example.com"))
      fail("only the decided identity fields may be recorded");
    for (const line of ledger.trim().split("\n")) {
      const keys = Object.keys(JSON.parse(line)).sort().join(",");
      if (keys !== "firstSeen,ghId,ghLogin,lastSeen,platform,surface,version")
        fail(`a stored row carries unexpected fields: ${keys}`);
    }
  }

  // ── 8. Unknown paths and methods ──────────────────────────────────────────
  {
    const nowhere = await fetch(`${base}/v1/anything`);
    if (nowhere.status !== 404) fail(`unknown path ${nowhere.status}`);
    const wrongMethod = await fetch(`${base}/v1/installs`, { method: "DELETE" });
    if (wrongMethod.status !== 405) fail(`DELETE ${wrongMethod.status}`);
  }

  // ── 9. TRUST_PROXY reads only the LAST forwarded hop ──────────────────────
  {
    // Behind Railway, `req.socket.remoteAddress` is the PROXY, so every install
    // on earth shared one bucket. Honouring X-Forwarded-For fixes that and
    // introduces a spoof: a caller who controls the header could mint a fresh
    // bucket per request. Only the last hop — the one the proxy appended — is
    // read, so the leading entries a caller supplies do not change the key.
    const proxied = boot({
      REGISTRY_SIGNING_SECRET: SIGNING_SECRET,
      REGISTRY_ADMIN_TOKEN: ADMIN_TOKEN,
      TRUST_PROXY: "1",
    });
    await new Promise((resolve) => proxied.child.stdout.once("data", resolve));

    const withChain = (chain) =>
      fetch(`${proxied.base}/v1/installs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${GOOD_TOKEN}`,
          "x-forwarded-for": chain,
        },
        body: JSON.stringify({
          surface: "cli",
          version: "0.4.3",
          platform: "darwin-arm64",
        }),
      });

    // Two requests whose SPOOFED leading hops differ but whose real (last) hop
    // is the same must land in the same bucket. Both are well under the ceiling,
    // so both succeed — what is being checked is that the key does not follow
    // the attacker-controlled prefix.
    const first = await withChain("1.2.3.4, 203.0.113.9");
    const second = await withChain("9.9.9.9, 203.0.113.9");
    if (first.status !== 200 || second.status !== 200)
      fail(`forwarded requests should register, got ${first.status}/${second.status}`);

    // A junk hop must fall back to the socket address rather than becoming a key.
    const junk = await withChain("not-an-address");
    if (junk.status !== 200)
      fail(`a junk forwarded hop must fall back, got ${junk.status}`);

    proxied.child.kill();
  }

  // ── 10. firstSeen is read from the WHOLE ledger, never a bounded tail ──────
  {
    // The drift this prevents: dedup used an 8MB tail read, so past that size
    // the earliest rows fell off the front and `firstSeen` — the one immutable
    // field on the record — silently moved forward. The full-file stream is what
    // keeps the oldest sighting reachable; here it is checked across every row
    // this run appended.
    const res = await fetch(`${base}/v1/installs`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const { installs } = await res.json();
    const ledger = readFileSync(join(dataDir, "installs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const row of installs) {
      const oldest = ledger
        .filter((entry) => entry.ghId === row.ghId && entry.surface === row.surface)
        .map((entry) => entry.firstSeen)
        .sort()[0];
      if (row.firstSeen !== oldest)
        fail(
          `firstSeen drifted for ${row.surface}: table says ${row.firstSeen}, ledger's oldest is ${oldest}`
        );
    }
  }

  // ── 11. A configured service reports plain `ok` ────────────────────────────
  {
    const health = await fetch(`${base}/healthz`);
    const body = await health.text();
    if (health.status !== 200) fail(`configured healthz ${health.status}`);
    if (body.trim() !== "ok") fail(`configured healthz body: ${JSON.stringify(body)}`);
    if (health.headers.get("x-registry-can-mint") !== "1")
      fail("a configured registry must report can-mint=1");
  }

  // ── 12. A MALFORMED HOST HEADER MUST NOT KILL THE PROCESS ─────────────────
  {
    // This was a remote, unauthenticated denial of service: the handler built a
    // URL from `http://${req.headers.host}`, an attacker-controlled value, and a
    // Host of `]not a host[` made it throw inside an async function — an
    // unhandled rejection, which on modern node exits the process. Measured on
    // 2026-08-17: one request, no bearer, no body, and the registry was down for
    // everybody. So this test asserts the SERVER IS STILL ALIVE afterwards,
    // which is the actual property; a 400 on its own would not prove it.
    const raw = await new Promise((resolve) => {
      const { port } = new URL(base);
      const socket = connect({ host: "127.0.0.1", port: Number(port) }, () => {
        socket.write(
          "GET /healthz HTTP/1.1\r\nHost: ]not a host[\r\nConnection: close\r\n\r\n"
        );
      });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (text += chunk));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
      setTimeout(() => {
        socket.destroy();
        resolve(text);
      }, 3_000);
    });
    // node itself may reject the malformed header with a 400 before our handler
    // sees it; either that or our own 400 is fine. What is NOT fine is a dead
    // process.
    if (raw && !/^HTTP\/1\.1 (400|200)/.test(raw))
      fail(`a malformed Host should answer 400 or 200, got: ${raw.slice(0, 60)}`);

    const stillUp = await fetch(`${base}/healthz`).catch(() => null);
    if (!stillUp || stillUp.status !== 200)
      fail("a malformed Host header killed the server — this is a remote DoS");
  }

  // ── 13. An oversized body gets a real 413, not a connection reset ─────────
  {
    // The 413 was documented and never delivered: the read destroyed the socket
    // the instant it overflowed, so the client saw ECONNRESET and mapped it to
    // `unreachable` — telling a person their network was down over a body this
    // service simply declined to read.
    const huge = "x".repeat(64 * 1024);
    const res = await fetch(`${base}/v1/installs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${GOOD_TOKEN}`,
      },
      body: JSON.stringify({
        surface: "cli",
        version: "0.4.1",
        platform: "darwin-arm64",
        pad: huge,
      }),
    }).catch((error) => ({ error }));
    if ("error" in res)
      fail(`an oversized body must answer 413, not reset the connection (${res.error})`);
    else {
      if (res.status !== 413) fail(`oversized body should 413, got ${res.status}`);
      const body = await res.json().catch(() => ({}));
      if (body.error !== "body_too_large")
        fail(`the 413 must carry a typed error, got ${JSON.stringify(body)}`);
    }
    // And the service survives it.
    const stillUp = await fetch(`${base}/healthz`).catch(() => null);
    if (!stillUp || stillUp.status !== 200)
      fail("an oversized body took the server down");
  }

  // ── 14. A GITHUB OUTAGE IS NOT A BAD IDENTITY ─────────────────────────────
  {
    // Every non-OK status from GitHub used to collapse into 401, which the client
    // maps to `unauthorized` → "GitHub did not verify that sign-in. Run the
    // sign-in again." So a GitHub 5xx locked a hard-gated CLI/desktop user out
    // and pointed them at the one action that cannot help. The STATUS is the
    // whole contract here: the client branches on it and never reads the body.
    for (const token of ["gho_github_500", "gho_github_503"]) {
      const res = await post(
        base,
        { surface: "cli", version: "0.4.3", platform: "darwin-arm64" },
        token
      );
      if (res.status !== 503)
        fail(`a GitHub 5xx must surface as a retryable 503, got ${res.status} (${token})`);
      const body = await res.json();
      if (body.error !== "github_unavailable")
        fail(`the 503 must be typed as an upstream failure, got ${JSON.stringify(body.error)}`);
      if (/did not verify/i.test(String(body.message)))
        fail("an upstream failure must never be worded as a rejected identity");
    }
  }

  // ── 15. A GITHUB RATE LIMIT IS RETRYABLE, IN ALL THREE SHAPES ─────────────
  {
    // GitHub signals its primary limit with `x-ratelimit-remaining: 0` and its
    // secondary limit with `retry-after`, on a 403 OR a 429 — so a first run
    // during a rush hit a 403 and was told its identity was bad. 429 is the shape
    // the client already has a typed `rate_limited` code for.
    for (const token of ["gho_github_429", "gho_secondary_403", "gho_primary_403"]) {
      const res = await post(
        base,
        { surface: "cli", version: "0.4.3", platform: "darwin-arm64" },
        token
      );
      if (res.status !== 429)
        fail(`a GitHub rate limit must surface as 429, got ${res.status} (${token})`);
      const body = await res.json();
      if (body.error !== "rate_limited")
        fail(`the 429 must carry the rate_limited code, got ${JSON.stringify(body.error)}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      if (!Number.isInteger(retryAfter) || retryAfter < 1 || retryAfter > 3_600)
        fail(`the 429 must carry a bounded Retry-After, got ${res.headers.get("retry-after")}`);
      if (/did not verify/i.test(String(body.message)))
        fail("a rate limit must never be worded as a rejected identity");
    }
  }

  // ── 16. A GITHUB 403 ON THE TOKEN IS STILL A REFUSED IDENTITY ─────────────
  {
    // The other half of the distinction: a plain 403 (no rate headers) IS about
    // the credential, and softening it would be the opposite defect — telling
    // somebody to wait when signing in again is the actual remedy.
    const res = await post(
      base,
      { surface: "cli", version: "0.4.3", platform: "darwin-arm64" },
      "gho_forbidden_403"
    );
    if (res.status !== 401)
      fail(`a plain GitHub 403 must stay a 401, got ${res.status}`);
    const body = await res.json();
    if (body.error !== "identity_unverified")
      fail(`a refused credential must stay identity_unverified, got ${JSON.stringify(body.error)}`);
  }

  // ── 17. REGISTRATION STAYS FAST AGAINST A LARGE LEDGER ────────────────────
  {
    // THE LOCKOUT THIS PREVENTS: dedup streamed the WHOLE append-only ledger on
    // EVERY POST, so registration cost grew with the file. The client's
    // registration has a 10s abort, so past some size every POST answers
    // `unreachable` and every NEW hard-gated install is locked out with no local
    // remedy at all. Measured on this file before the fix: ~120 ms/POST at 34MB,
    // ~570 ms at 170MB — linear, on a warm local disk.
    const dir = scratchDir();
    const ledger = join(dir, "installs.jsonl");
    const rows = [];
    const base0 = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 200_000; index += 1) {
      const at = new Date(base0 + index * 1_000).toISOString();
      rows.push(
        JSON.stringify({
          ghId: 100_000 + (index % 2_000),
          ghLogin: `user${100_000 + (index % 2_000)}`,
          surface: index % 2 === 0 ? "cli" : "desktop",
          version: "0.4.2",
          platform: "darwin-arm64",
          firstSeen: at,
          lastSeen: at,
        })
      );
      if (rows.length === 10_000) {
        appendFileSync(ledger, `${rows.join("\n")}\n`);
        rows.length = 0;
      }
    }
    // The install this behaviour registers as, with its EARLIEST sighting at the
    // very front of the file — the row a bounded tail read would lose.
    appendFileSync(
      ledger,
      `${JSON.stringify({
        ghId: 583231,
        ghLogin: "octocat",
        surface: "cli",
        version: "0.3.0",
        platform: "darwin-arm64",
        firstSeen: "2020-05-05T05:05:05.000Z",
        lastSeen: "2020-05-05T05:05:05.000Z",
      })}\n${rows.join("\n")}\n`
    );

    const big = bootOn(dir);
    await bootedAndIndexed(big);
    const timings = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      const res = await post(
        big.base,
        { surface: "cli", version: "0.4.4", platform: "darwin-arm64" },
        GOOD_TOKEN
      );
      timings.push(Date.now() - startedAt);
      if (res.status !== 200)
        fail(`registration against a large ledger should succeed, got ${res.status}`);
      const body = await res.json();
      if (body.github?.id !== 583231) fail("the identity must still be the verified one");
    }
    // A BUDGET, not a stopwatch: the streaming version needed ~120 ms per POST on
    // this ledger and the derived index needs ~2 ms, so 40 ms is 3x clear of both
    // the new cost and the old one. A regression to per-request streaming fails
    // here even on a slow disk.
    //
    // EVERY timing counts, including the FIRST. An earlier version of this check
    // skipped it — and the first POST is the only one that sees the large LIVE
    // segment, because it is the one that rotates. Skipping it made the whole
    // behaviour pass against a deliberately reintroduced per-request full scan.
    // The index rebuild is already awaited above, so none of these include it.
    const slowest = Math.max(...timings);
    if (slowest > 40)
      fail(
        `registration must not scale with the ledger: ${timings.join("ms, ")}ms against 34MB (budget 40ms)`
      );
    if (!existsSync(join(dir, "first-seen.jsonl")))
      fail("the derived firstSeen index must be written beside the ledger");

    // ROTATION happened (34MB > the 8MB bound) and `firstSeen` — the one
    // immutable field — is still the 2020 row from the very front of the file.
    const rotated = readdirSync(dir).filter(
      (name) => name.startsWith("installs-") && name.endsWith(".jsonl")
    );
    if (rotated.length === 0)
      fail("a ledger past the bound must rotate into a segment, not grow forever");
    const table = await fetch(`${big.base}/v1/installs`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const { installs, truncated, complete } = await table.json();
    const mine = installs.find((row) => row.ghId === 583231 && row.surface === "cli");
    if (mine?.firstSeen !== "2020-05-05T05:05:05.000Z")
      fail(`rotation moved firstSeen: ${mine?.firstSeen}`);
    if (truncated !== true)
      fail("a table that omits rotated segments must say truncated:true");
    if (complete !== true)
      fail("a read that succeeded must say complete:true");
    big.child.kill();
  }

  // ── 18. A TORN firstSeen INDEX REBUILDS FROM THE LEDGER ───────────────────
  {
    // The index is a CACHE; the ledger is the authority. A half-written sidecar,
    // or a crash between the ledger append and the sidecar append, must never
    // lose a `firstSeen` — it rebuilds, and it is rewritten so it converges.
    const dir = scratchDir();
    appendFileSync(
      join(dir, "installs.jsonl"),
      `${JSON.stringify({
        ghId: 583231,
        ghLogin: "octocat",
        surface: "cli",
        version: "0.1.0",
        platform: "darwin-arm64",
        firstSeen: "2019-01-01T00:00:00.000Z",
        lastSeen: "2019-01-01T00:00:00.000Z",
      })}\n`
    );
    // A TORN last line, exactly what a crash mid-append leaves behind.
    writeFileSync(
      join(dir, "first-seen.jsonl"),
      `{"ghId":999,"surface":"cli","firstSeen":"2026-01-01T00:00:00.000Z"}\n{"ghId":583231,"surf`
    );
    const torn = bootOn(dir);
    await bootedAndIndexed(torn);
    const res = await post(
      torn.base,
      { surface: "cli", version: "0.4.4", platform: "darwin-arm64" },
      GOOD_TOKEN
    );
    if (res.status !== 200) fail(`registration after a torn index ${res.status}`);
    const table = await fetch(`${torn.base}/v1/installs`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const { installs } = await table.json();
    const mine = installs.find((row) => row.ghId === 583231 && row.surface === "cli");
    if (mine?.firstSeen !== "2019-01-01T00:00:00.000Z")
      fail(`a torn index lost firstSeen: ${mine?.firstSeen} (the ledger says 2019-01-01)`);
    // …and the sidecar was rewritten whole, so the tear does not persist.
    const rebuilt = readFileSync(join(dir, "first-seen.jsonl"), "utf8")
      .trim()
      .split("\n");
    for (const line of rebuilt) {
      try {
        JSON.parse(line);
      } catch {
        fail(`the rebuilt index must be parseable, got ${JSON.stringify(line)}`);
      }
    }
    if (!rebuilt.some((line) => line.includes("2019-01-01T00:00:00.000Z")))
      fail("the rebuilt index must carry the firstSeen it recovered from the ledger");
    torn.child.kill();
  }

  // ── 19. A FAILED READ IS NEVER A COMPLETE TABLE ───────────────────────────
  {
    // `readLedgerTail`'s catch returned `{rows: [], truncated: false}`, so the
    // founder's own "who installed MUON" could print an EMPTY, WHOLE-LOOKING
    // table over a permission error or an I/O fault. Here the ledger path is a
    // directory: `stat` succeeds, the read cannot.
    const dir = scratchDir();
    mkdirSync(join(dir, "installs.jsonl"));
    const broken = bootOn(dir);
    await new Promise((resolve) => broken.child.stdout.once("data", resolve));
    const res = await fetch(`${broken.base}/v1/installs`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    if (res.status !== 500)
      fail(`an unreadable ledger must not answer 200, got ${res.status}`);
    const body = await res.json();
    if (body.error !== "ledger_unreadable")
      fail(`the failed read must be typed, got ${JSON.stringify(body.error)}`);
    if (body.complete !== false)
      fail("a failed read must never report complete:true");
    if (!/INCOMPLETE/i.test(String(body.message)))
      fail("the message must say the table is not the whole ledger");
    broken.child.kill();
  }

  // ── 20. THE LIMITER KEYS ON THE NETWORK, NOT THE ADDRESS ──────────────────
  {
    // With TRUST_PROXY the bucket key was the exact forwarded address, so an
    // attacker rotating the low bits of ONE IPv6 /64 — an allocation a single
    // subscriber holds — minted an unlimited number of fresh 120/min windows,
    // each one costing an outbound GitHub call. Keying the /64 (and the /24 for
    // IPv4) is the smallest block an ordinary caller cannot rotate inside.
    const limiter = bootOn(scratchDir(), { TRUST_PROXY: "1" });
    await new Promise((resolve) => limiter.child.stdout.once("data", resolve));
    // Unauthenticated GETs: the limiter runs BEFORE auth, so this measures the
    // limiter without registering anything or calling GitHub.
    const probe = (hop) =>
      fetch(`${limiter.base}/v1/installs`, { headers: { "x-forwarded-for": hop } });

    let limitedAt = 0;
    for (let index = 0; index < 130 && limitedAt === 0; index += 1) {
      // A DIFFERENT address every time, all inside 2001:db8:dead:beef::/64.
      const res = await probe(`2001:db8:dead:beef::${(index + 1).toString(16)}`);
      if (res.status === 429) limitedAt = index + 1;
      else if (res.status !== 401)
        fail(`an unauthenticated read should 401 until limited, got ${res.status}`);
    }
    if (limitedAt === 0)
      fail("rotating addresses inside one IPv6 /64 must NOT mint fresh rate windows");
    if (limitedAt < 121)
      fail(`the ceiling is 120/min per network, limited at ${limitedAt}`);

    // A DIFFERENT /64 is a different subscriber and must not be caught by it.
    const neighbour = await probe("2001:db8:dead:f00d::1");
    if (neighbour.status === 429)
      fail("a different /64 must have its own window — this is the global-bucket bug");

    // IPv4 is keyed on the /24, and one /24 is one bucket.
    let v4LimitedAt = 0;
    for (let index = 0; index < 130 && v4LimitedAt === 0; index += 1) {
      const res = await probe(`198.51.100.${index % 254}`);
      if (res.status === 429) v4LimitedAt = index + 1;
    }
    if (v4LimitedAt === 0)
      fail("rotating addresses inside one IPv4 /24 must NOT mint fresh rate windows");
    const v4Neighbour = await probe("203.0.113.7");
    if (v4Neighbour.status === 429)
      fail("a different /24 must have its own window");
    limiter.child.kill();
  }

  // ── 21. THE 413 IS DELIVERED, AND NOTHING ELSE IS LABELLED AS IT ──────────
  {
    // Behaviour 13 covers a body that arrives in one piece. This is the case that
    // used to lose the response: a body far bigger than the cap, still streaming
    // when the refusal is written. Destroying the socket on `finish` leaves unread
    // bytes in the receive buffer, which makes the kernel send an RST — and an RST
    // lets the peer discard the 413 it has not read yet. The refusal is written,
    // the rest of the upload is DRAINED, and only then does the connection close.
    // THE READER IS DELIBERATELY LATE. A client that reads the instant the bytes
    // land wins the race even against the broken version, which is why the
    // existing 64KB check passed while the defect was live. Holding the socket
    // paused for 700 ms is the honest shape: an RST arriving before the
    // application has read discards the receive buffer, and `fetch` reports that
    // as a failed request — "the registry could not be reached" — over a body
    // this service simply declined to read.
    const port = Number(new URL(base).port);
    const oversized = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        const payload = `{"surface":"cli","version":"0.4.1","platform":"darwin-arm64","pad":"${"x".repeat(512 * 1024)}"}`;
        socket.write(
          `POST /v1/installs HTTP/1.1\r\nHost: registry.test\r\nAuthorization: Bearer ${GOOD_TOKEN}\r\n` +
            `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n`
        );
        socket.write(payload);
        socket.pause();
      });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("error", (error) => resolve({ text, reset: error.code }));
      socket.on("close", () => resolve({ text, reset: null }));
      setTimeout(() => {
        socket.on("data", (chunk) => (text += chunk));
        socket.resume();
      }, 700);
      setTimeout(() => {
        socket.destroy();
        resolve({ text, reset: "timeout" });
      }, 5_000);
    });
    if (!/^HTTP\/1\.1 413/.test(oversized.text))
      fail(
        `a 512KB body must still be answered 413, got: ${JSON.stringify(oversized.text.slice(0, 80))}`
      );
    if (!oversized.text.includes("body_too_large"))
      fail("the delivered 413 must carry its typed error");
    if (oversized.reset)
      fail(
        `the refused upload must close cleanly, not by reset (${oversized.reset}) — a reset is what the client reports as "could not be reached"`
      );

    // An upload that DIES mid-flight is a different fact, and it used to be
    // reported as `body_too_large` by one untyped catch — telling a person their
    // request was too big over a network that dropped. Nothing about a dead
    // connection may produce a 413.
    const aborted = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write(
          `POST /v1/installs HTTP/1.1\r\nHost: registry.test\r\nAuthorization: Bearer ${GOOD_TOKEN}\r\n` +
            "Content-Type: application/json\r\nContent-Length: 900\r\n\r\n" +
            '{"surface":"cli"'
        );
        setTimeout(() => socket.destroy(), 50);
      });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (text += chunk));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
      setTimeout(() => {
        socket.destroy();
        resolve(text);
      }, 3_000);
    });
    if (/413/.test(aborted) || /body_too_large/.test(aborted))
      fail(`a dead upload must not be labelled body_too_large: ${JSON.stringify(aborted.slice(0, 80))}`);
    const stillUp = await fetch(`${base}/healthz`).catch(() => null);
    if (!stillUp || stillUp.status !== 200)
      fail("an aborted upload took the server down");
  }

  if (!failed) {
    console.log("ok: install-registry seeded check passed (21 behaviours)");
  }
} finally {
  for (const child of children) child.kill();
  github.close();
  rmSync(dataDir, { recursive: true, force: true });
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
