# MUON install registry — `registry.getmuon.com`

A dependency-free node http service, run as a Railway service with a volume,
built the same way the [download host](../download-server/README.md) is. It
implements [ADR-0052](../../docs/adr/0052-distributed-surfaces-gate-on-github-identity.md):
a DISTRIBUTED MUON install verifies a GitHub identity before it will work, and
this service is where that install is recorded.

Clients reach it through `@muon/client`'s `registerInstall()`
(`packages/client/src/github-identity-gate.ts`) — default
`https://registry.getmuon.com`, overridable with `MUON_INSTALL_REGISTRY`.

## The record, exhaustively

| Field | Source |
|---|---|
| `ghId`, `ghLogin` | **this service**, from GitHub's `/user` |
| `surface` | client — `desktop` \| `cli` (positive set) |
| `version` | client — the MUON version registering |
| `platform` | client — `<platform>-<arch>` |
| `firstSeen`, `lastSeen` | this service's clock, deduped by `(ghId, surface)` |

`mcp` was in the surface set and is gone (2026-08-17 review): no MUON client ever
sent it. `muon-mcp` ships inside the CLI tarball and is opened by `muon login`,
which files `cli`. A positive set must not carry a member no client produces —
kept in step with `INSTALL_SURFACES` in
`packages/client/src/github-identity-gate.ts`.

`firstSeen` is derived from a **sidecar index** (`<volume>/first-seen.jsonl`),
one line per install, rebuilt from the ledger on boot and appended to on the
first sighting of a `(ghId, surface)`. It used to be derived by streaming the
whole ledger **on every POST**, which made registration cost grow with the file:
the client's registration has a 10s abort, so past some ledger size every POST
answers `unreachable` and every NEW hard-gated install is locked out with no
local remedy. Measured on this repo's seeded harness: ~120 ms/POST at a 34MB
ledger and ~570 ms at 170MB before, ~2 ms after, flat.

The sidecar is a **cache, never the authority**. On boot the index is read, then
every retained ledger segment is folded in, so a torn sidecar — or a crash
between the ledger append and the sidecar append — rebuilds rather than losing a
`firstSeen`; whenever the ledger knew something the sidecar did not, the sidecar
is rewritten (temp file + rename) and converges. A boot that cannot read one of
its sources says so loudly, keeps serving registrations, and stops writing to the
sidecar until a boot can read it — an in-memory guess must not become durable.

### Retention

The live segment rotates to `installs-<ISO>.jsonl` once it passes
`MAX_LEDGER_BYTES` (8MB) and **the six most recent rotated segments are kept** —
≈56MB, ≈350k registration rows. Rotation never costs a `firstSeen`: that field
lives in the sidecar, which is never rotated. The admin read covers the live
segment only, and reports `truncated: true` whenever rotated segments exist.

Nothing else is accepted or stored: no workspace paths, no repo names, no code,
no usage counters, no IP addresses, no request bodies. A body carrying any field
outside `surface`/`version`/`platform` is **refused with 400**, not trimmed — a
client that starts over-sharing must fail loudly here rather than quietly
succeed. Usage telemetry remains ADR-0031's separate consent-gated channel.

The GitHub access token is presented as a bearer, used **once, in memory**, to
call `/user`, and is never written to the volume and never logged. The client
never sends an identity; a claimed login is never trusted.

## Endpoints

| Method | Path | Auth | Answers |
|---|---|---|---|
| `POST` | `/v1/installs` | `Bearer <github token>` | `{ github: { id, login }, grant: { token, issuedAt, version } }` |
| `GET` | `/v1/installs` | `Bearer $REGISTRY_ADMIN_TOKEN` | `{ installs: [...], count, truncated, complete }` — the who-installed table |
| `GET` | `/healthz` | none | `ok`, or `degraded: cannot mint grants …` |

**Two flags on the read, and they are different facts.** `truncated: true` means
the table is not the whole ledger — the read hit its 8MB bound, or rotated
segments exist that it does not include. `complete: false` (always with HTTP
**500** and `error: "ledger_unreadable"`) means the read itself FAILED: whatever
rows came back are real, and the table is not an answer to "who installed MUON".
That case used to answer `200 {installs: [], truncated: false}` — a permission
error or an I/O fault printed as "nobody has installed MUON", complete and
confident. A partial table that reads as whole is the one way this answer can be
confidently wrong, so both flags are stated rather than implied.

### A POST's status, and what each one means

The client branches on the **status** and never reads the error body, so the
status carries the remedy:

| Status | `error` | What actually happened |
|---|---|---|
| `200` | — | registered; the grant is in the body |
| `400` | `invalid_body` / `body_unreadable` | the body was refused, or the connection died mid-upload |
| `401` | `unauthorized` / `identity_unverified` | no bearer, or **GitHub refused the token** (401, or a plain 403) |
| `413` | `body_too_large` | over `MAX_BODY_BYTES`; delivered, then the upload is drained and the connection closed |
| `429` | `rate_limited` | this network's window, **or GitHub rate-limiting this service's verification call**; carries `Retry-After` |
| `500` | `record_failed` | the record could not be written |
| `502` | `github_unreadable` | GitHub answered something that is not an identity |
| `503` | `signing_not_configured` / `github_unavailable` | this service cannot mint, or **GitHub could not answer** (5xx, timeout) |

**An upstream failure is not a rejected identity**, and collapsing the two locked
honest people out. Every non-OK GitHub status used to answer `401`, which the
client maps to `unauthorized` → *"GitHub did not verify that sign-in. Run the
sign-in again."* So a GitHub 5xx, or a 403 secondary rate limit during a
launch-day rush, told a hard-gated CLI/desktop user their identity was bad and
sent them to re-run the one thing that cannot help. GitHub signals its primary
limit with `x-ratelimit-remaining: 0` and its secondary limit with `retry-after`,
on a **403 or a 429** — both are read as rate, and only a 403 with neither is
read as a verdict on the credential.

> **The client half that is still missing.** `@muon/client`'s `registerInstall`
> maps `429` to its typed `rate_limited` code (correct copy, retryable), but maps
> **`503` to `refused`** — *"The MUON install registry refused the registration
> (HTTP 503)"* — which reads as a verdict on this registration rather than "retry,
> nothing is wrong". `github_unavailable` and `signing_not_configured` both land
> there. Until `InstallRegistryErrorCode` gains a retryable upstream code (and
> `installRegistryOrigin`-style copy to match), a GitHub outage still shows a
> misleading sentence — it is no longer the *wrong remedy* ("sign in again"), but
> it is not yet the right one.

**`/healthz` reports mintability, not just liveness.** It used to answer `ok`
while `REGISTRY_SIGNING_SECRET` was unset — a green dashboard over a service that
refused every single registration with a 503, with nothing anywhere connecting the
two. It now returns:

| Body | Header | Meaning |
|---|---|---|
| `ok` | `x-registry-can-mint: 1` | grants can be issued |
| `degraded: cannot mint grants …` | `x-registry-can-mint: 0` | the service is UP and **every new install will be refused** |

The status stays **200 in both cases on purpose**: Railway treats a non-200
healthcheck as a failed deploy, and a rollback loop hides the misconfiguration
instead of naming it. The body is what a founder curls; the boot log shouts the
same thing.

The grant is `HMAC-SHA256(REGISTRY_SIGNING_SECRET, "<ghId>:<surface>:<issuedAt>")`
as hex. The client caches it and treats **credential + grant** as the open gate,
so the first run needs reachability and every later run does not.

### What the grant actually proves (corrected 2026-08-17)

Be precise about this, because the first version of this README was not.

**The client never verifies the HMAC.** It holds no signing secret, and it should
not — a client able to verify the signature would be a client able to mint one.
What the client validates is: the grant's **shape** (a 64-char lowercase hex
token, an ISO `issuedAt`, an integer `version`), that the version is one this
build **accepts**, and that `issuedAt` is not in the future beyond a 5-minute
skew. So:

- A **forged grant shape** re-gates. A forged grant of the right shape does not.
- **Rotating `REGISTRY_SIGNING_SECRET` re-gates nobody.** Nothing on any client
  checks the signature, so old cached grants keep opening the gate. Rotate it to
  stop *this service* from honouring old grants it re-derives; do not rotate it
  expecting to lock anyone out.
- **Real revocation is the `version` bump** ADR-0052's Non-goals reserve: raise
  `GRANT_VERSION` here and drop the old number from `ACCEPTED_GRANT_VERSIONS` in
  `@muon/client`, and every older grant re-gates on the next run. That is a
  client-side release, not a server-side switch.
- The shape that would make rotation meaningful is **asymmetric** signing (the
  service signs with a private key, clients verify a baked public key).
  Deliberately not built.

Storage is **append-only JSONL** (`<volume>/installs.jsonl`) with dedup derived
on read, so the file stays a ledger rather than a table somebody could quietly
correct.

## Env

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | injected by Railway |
| `MUON_DATA_DIR` | `/data` | the volume mount |
| `REGISTRY_SIGNING_SECRET` | — | **required to mint**; absent or under 16 chars, `POST` fails closed with `503` |
| `REGISTRY_ADMIN_TOKEN` | — | **required for the read**; absent, `GET` fails closed with `503` |
| `REGISTRY_GITHUB_API` | `https://api.github.com` | overridable so the seeded check can point at a local stub |
| `TRUST_PROXY` | unset | set to `1` **only** behind a proxy that appends the real client to `X-Forwarded-For` (Railway does) |

Registration is rate limited to **120 requests/minute per client NETWORK** — a
`/64` for IPv6, a `/24` for IPv4, not an exact address: the endpoint calls GitHub
on the caller's behalf, and unbounded that would make MUON a free token-probing
proxy. Keying the exact address was the same thing as no limiter at all behind
`TRUST_PROXY`, because a single IPv6 subscriber holds a whole /64 and rotating
the low bits minted an unlimited number of fresh windows. The bucket map has a
**hard cap** (20 000 keys, pruned to 16 000) rather than only an expiry sweep, so
an attacker with addresses to spend cannot buy unbounded memory or a linear scan
per request. The limiter is in memory and resets on deploy.

**`TRUST_PROXY` is load-bearing behind Railway.** Without it the key is
`req.socket.remoteAddress`, which is the *proxy* — so the bucket is effectively
global and every MUON install on earth shares one ceiling, which turns a launch-day
rush into `rate_limited` for people who did nothing wrong. With it, only the
**last** hop of `X-Forwarded-For` is read: the header is caller-controlled, so
reading `[0]` (or trusting it when there is no proxy) would let anyone mint a
fresh bucket per request and delete the limiter. Leave it unset when this service
is directly exposed.

Clients map a `429` to a typed `rate_limited` code with its own copy ("try again
in a minute; nothing about this sign-in is wrong"), rather than to `refused` —
which used to send people to re-run a sign-in that was already correct.

The admin bearer is compared over **SHA-256 digests** in constant time. Comparing
the secrets directly needs a length guard (`timingSafeEqual` throws on unequal
lengths), and that guard leaked the token's length to anyone who could time the
endpoint.

## One-time setup (founder, Railway CLI)

```bash
cd packaging/install-registry
railway add -s install-registry \
  -v "REGISTRY_SIGNING_SECRET=$(openssl rand -hex 32)" \
  -v "REGISTRY_ADMIN_TOKEN=$(openssl rand -hex 32)" \
  -v "TRUST_PROXY=1"
railway volume -s install-registry add -m /data
railway domain registry.getmuon.com -s install-registry
```

`TRUST_PROXY=1` is not optional in this deployment: behind Railway's proxy every
request arrives from the same address, so without it the rate limiter is one
global bucket shared by every install (see *Env* above).

Note `railway volume` takes `-s` on ITSELF, not on `add` — `volume add -s …`
fails with "unexpected argument".

### Deploying it — and the trap that bit us once

`railway up` uploads the **git repository root**, not the directory you run it
from. This repo has a `Dockerfile` at its root that builds the Next.js marketing
site, so `cd packaging/install-registry && railway up` deployed **the website**
to this service: the logs read `muon-labs@0.2.0 start` → `next start`, the
deploy went green, `/healthz` 404'd, and Railway still reported the custom
domain ACTIVE. A green deploy is not evidence that the right program is running.

Until this service has its **root directory** set to `packaging/install-registry`
in the Railway dashboard (there is no CLI flag for it), deploy from a copy that
is **outside** any git repo, so the upload is only these files:

```bash
STAGE=$(mktemp -d)
cp packaging/install-registry/{package.json,railway.json,server.mjs,test.mjs,README.md} "$STAGE"/
cd "$STAGE" && railway up -c \
  -p <projectId> -s install-registry -e production
```

`railway.json` then applies as intended — NIXPACKS, `node server.mjs`,
healthcheck `/healthz`. A correct build installs **one** package and never
mentions Next.js.

### Proving it actually serves the registry

DNS is a separate problem from the service (ours pointed at Vercel for hours
after Railway called the domain ACTIVE), so verify from **inside the container**
first — that isolates the program from the record:

```bash
railway ssh --service install-registry \
  "curl -sS -D- -o /dev/null http://127.0.0.1:8080/healthz"
```

Pass looks like this, and the two headers are the point — `ok` alone does not
tell you it can mint:

```text
HTTP/1.1 200 OK
x-registry-can-mint: 1
x-registry-can-read: 1
```

`can-mint: 0` means `REGISTRY_SIGNING_SECRET` is unset or under 16 chars, and
every registration would 503 while the deploy still looks healthy. Startup logs
one line naming the ledger path and port: `[install-registry] recording to
/data/installs.jsonl on :8080`. Also worth one check each, unauthenticated:
`GET /v1/installs` → 401 and `POST /v1/installs` → 401.

### DNS, which the service cannot do for itself

`railway domain` claiming ACTIVE only means Railway will answer for the
hostname — it does not move anybody's DNS. Point `registry.getmuon.com` at
Railway (CNAME to the target `railway domain status <id>` prints) and remove the
record that sends it elsewhere. Until then a gated client POSTs into whatever
that name currently resolves to, so **do not bake a gated release** before the
public `/healthz` answers `ok` with `x-registry-can-mint: 1`.

> **Rotating `REGISTRY_SIGNING_SECRET` does NOT re-gate anyone.** An earlier
> version of this file claimed it did. No client verifies the HMAC, so every
> cached grant keeps working. See *What the grant actually proves* above for the
> mechanism that does re-gate (a `version` bump, shipped client-side).

## Reading the table

```bash
curl -sS -H "Authorization: Bearer $REGISTRY_ADMIN_TOKEN" \
  https://registry.getmuon.com/v1/installs | jq '{complete, truncated, count}'
```

**Read those three first.** `complete: false` means the read failed and the rows
are a fragment (the response is a 500); `truncated: true` means rotated segments
or an 8MB tail are not in the table. Then `jq '.installs'` for the rows.

## Local check

`npm test` boots the real server on an ephemeral port against a temp volume and
a stub GitHub, and verifies twenty-one behaviours: an unverified token is refused,
the record shape, `(ghId, surface)` dedup, unknown-field refusal, the retired
`mcp` surface being refused, missing-signing-secret fail-closed, admin auth on the
read, the token never landing on the volume, the admin read reporting `truncated`,
`TRUST_PROXY` honouring only the last forwarded hop, `firstSeen` matching the
oldest row in the whole ledger, `/healthz` telling the truth about mintability,
and the two ways an unauthenticated caller used to be able to hurt this service:

- a **malformed `Host` header**, which killed the process (the handler built a URL
  from an attacker-controlled base; the throw was an unhandled rejection, which on
  modern node exits). The test asserts the server is still answering afterwards,
  because a 400 alone would not prove it.
- an **oversized body**, which reset the connection instead of answering `413`, so
  the client reported "the registry could not be reached" — sending a person to
  check their network over a body this service simply declined to read.

Plus the eight added by the 2026-08-17 triage: a GitHub 5xx answering a retryable
`503` (not "your identity is bad"), all three GitHub rate-limit shapes answering
`429` with `Retry-After`, a plain GitHub 403 still answering `401`, registration
staying **under a 40 ms budget against a 34MB ledger** (the streaming version
needed ~120 ms) with rotation keeping `firstSeen` exactly where it was, a torn
sidecar rebuilding from the ledger, the founder's read refusing to call a failed
read complete, the limiter holding one window per `/64` and per `/24`, and a
512KB oversized body getting its `413` **delivered without a reset** — read by a
deliberately late reader, because a client that reads instantly wins the race
even against the broken version, which is why the earlier 64KB check passed while
the defect was live.
