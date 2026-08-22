import { describe, expect, it } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

/**
 * THE BRAIN CAN MOVE UNDER A LONG-LIVED HOST.
 *
 * Measured 2026-08-10: an MCP server spawned when the brain lockfile read
 * :55036 was still calling :55036 two days later. The brain had restarted onto
 * :51834 — `muon doctor` reached it without trouble, because the CLI is a new
 * process per command and re-reads the lockfile every time. The MCP server is
 * not: it resolves once, at construction, and then lives as long as the human's
 * vendor session.
 *
 * The result was every memory tool an attached agent held returning
 * "fetch failed", against an address nobody was listening on, with nothing on
 * any surface saying why. The moat, unreachable, silently.
 */

const OK = new Response(
  JSON.stringify({
    status: "ok",
    service: "muon-backend",
    timestamp: "2026-08-10T00:00:00.000Z",
  }),
  {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }
);

function refused(): never {
  throw new TypeError("fetch failed");
}

describe("a refused connection re-reads where the brain lives", () => {
  it("retries once at the new address and succeeds", async () => {
    const tried: string[] = [];
    const client = new MuonApiClient(
      "http://127.0.0.1:55036",
      async (input) => {
        const url = String(input);
        tried.push(url);
        if (url.startsWith("http://127.0.0.1:55036")) refused();
        return OK.clone();
      },
      "old-token",
      0,
      () => ({ baseUrl: "http://127.0.0.1:51834", apiToken: "new-token" })
    );

    await expect(client.health()).resolves.toBeTruthy();
    expect(tried).toEqual([
      "http://127.0.0.1:55036/health",
      "http://127.0.0.1:51834/health",
    ]);
  });

  it("carries the NEW token, not the dead brain's", async () => {
    // A restarted brain mints a fresh token. Rebasing the port alone would
    // trade "connection refused" for 401 — a different failure, equally opaque.
    const seen: (string | null)[] = [];
    const client = new MuonApiClient(
      "http://127.0.0.1:55036",
      async (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get("Authorization"));
        if (String(input).includes("55036")) refused();
        return OK.clone();
      },
      "old-token",
      0,
      () => ({ baseUrl: "http://127.0.0.1:51834", apiToken: "new-token" })
    );

    await client.health();
    expect(seen).toEqual(["Bearer old-token", "Bearer new-token"]);
  });

  it("subsequent calls go straight to the new address", async () => {
    const tried: string[] = [];
    const client = new MuonApiClient(
      "http://127.0.0.1:55036",
      async (input) => {
        tried.push(String(input));
        if (String(input).includes("55036")) refused();
        return OK.clone();
      },
      undefined,
      0,
      () => ({ baseUrl: "http://127.0.0.1:51834" })
    );

    await client.health();
    await client.health();
    // Three, not four: the move is remembered, not rediscovered per call.
    expect(tried).toHaveLength(3);
    expect(tried.at(-1)).toBe("http://127.0.0.1:51834/health");
  });
});

describe("it does not loop, and does not retry what may have landed", () => {
  it("a brain that is genuinely OFFLINE fails fast, with the same message", async () => {
    let calls = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:55036",
      async () => {
        calls += 1;
        refused();
      },
      undefined,
      0,
      // Same address back: nothing moved, so there is nothing to retry.
      () => ({ baseUrl: "http://127.0.0.1:55036" })
    );

    await expect(client.health()).rejects.toThrow(/fetch failed/);
    expect(calls, "no retry when the answer did not move").toBe(1);
  });

  it("retries AT MOST once, even if the new address is also refused", async () => {
    let calls = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:1",
      async () => {
        calls += 1;
        refused();
      },
      undefined,
      0,
      // A resolver that keeps moving would loop forever without the guard.
      () => ({ baseUrl: `http://127.0.0.1:${1000 + calls}` })
    );

    await expect(client.health()).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("a TIMEOUT is never retried — the brain may have processed it", async () => {
    // The distinction the whole mechanism rests on. A refused socket means the
    // request never reached a server, so replaying it cannot duplicate work.
    // A timeout means the opposite: the brain may have accepted and committed
    // it, and a retry could double a write.
    let calls = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:55036",
      async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return OK.clone();
      },
      undefined,
      20,
      () => ({ baseUrl: "http://127.0.0.1:51834" })
    );

    await expect(client.health()).rejects.toThrow(/did not respond within/);
    expect(calls, "a timed-out request is not replayed").toBe(1);
  });

  it("an HTTP error is not a connection failure and is not retried", async () => {
    let calls = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:55036",
      async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: "nope" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      },
      undefined,
      0,
      () => ({ baseUrl: "http://127.0.0.1:51834" })
    );

    await expect(client.health()).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

/**
 * THE BRAIN CAN ALSO STAY PUT AND ROTATE ITS TOKEN.
 *
 * The embedded port is stable, so an externally restarted brain (a CLI
 * `muon shutdown` + auto-start) usually rebinds the SAME port with a fresh
 * token. Nothing throws, /health passes because it is unauthenticated, and the
 * connection-failure lane above never runs — so a long-lived host 401s forever
 * against a brain that is sitting right there, healthy.
 */
describe("a 401 from a brain that never moved re-reads the lockfile once", () => {
  const UNAUTHORIZED = (): Response =>
    new Response(JSON.stringify({ message: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  it("adopts the rotated token and the retry succeeds", async () => {
    const seen: (string | null)[] = [];
    const client = new MuonApiClient(
      "http://127.0.0.1:10777",
      async (_input, init) => {
        const token = new Headers(init?.headers).get("Authorization");
        seen.push(token);
        return token === "Bearer new-token" ? OK.clone() : UNAUTHORIZED();
      },
      "stale-token",
      0,
      // Same base, new token: the signature of a same-port restart.
      () => ({ baseUrl: "http://127.0.0.1:10777", apiToken: "new-token" })
    );

    await expect(client.health()).resolves.toBeTruthy();
    expect(seen).toEqual(["Bearer stale-token", "Bearer new-token"]);
  });

  it("does not retry when the lockfile hands back the SAME token", async () => {
    // Then the credential is genuinely refused, and a retry is just a loop.
    let calls = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:10777",
      async () => {
        calls += 1;
        return UNAUTHORIZED();
      },
      "held-token",
      0,
      () => ({ baseUrl: "http://127.0.0.1:10777", apiToken: "held-token" })
    );

    await expect(client.health()).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("does not treat a 403 as a rotation", async () => {
    // 403 is authority, not identity: no token in any lockfile fixes it.
    let calls = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:10777",
      async () => {
        calls += 1;
        return new Response("{}", {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      },
      "held-token",
      0,
      () => ({ baseUrl: "http://127.0.0.1:10777", apiToken: "rotated" })
    );

    await expect(client.health()).rejects.toThrow(/403/);
    expect(calls).toBe(1);
  });

  it("a second consecutive 401 surfaces instead of looping", async () => {
    // The rotated token is ALSO refused. One retry, then the truth.
    let calls = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:10777",
      async () => {
        calls += 1;
        return UNAUTHORIZED();
      },
      "stale-token",
      0,
      () => ({
        baseUrl: "http://127.0.0.1:10777",
        apiToken: `rotated-${calls}`,
      })
    );

    await expect(client.health()).rejects.toThrow(/401/);
    expect(calls, "exactly one retry, never a loop").toBe(2);
  });

  it("rate-limits the lockfile read so a 401 storm cannot storm the disk", async () => {
    let calls = 0;
    let reads = 0;
    const client = new MuonApiClient(
      "http://127.0.0.1:10777",
      async () => {
        calls += 1;
        return UNAUTHORIZED();
      },
      "stale-token",
      0,
      () => {
        reads += 1;
        // A resolver that "rotates" on every read would otherwise re-arm the
        // retry for every request the host makes.
        return {
          baseUrl: "http://127.0.0.1:10777",
          apiToken: `rotated-${reads}`,
        };
      }
    );

    for (let i = 0; i < 5; i += 1) {
      await expect(client.health()).rejects.toThrow(/401/);
    }
    expect(reads, "one lockfile read per 30s window, not per 401").toBe(1);
    // 5 first attempts + the single retry the one allowed rebase earned.
    expect(calls).toBe(6);
  });

  it("leaves callers without a resolver exactly as they were", async () => {
    let calls = 0;
    const client = new MuonApiClient("http://127.0.0.1:10777", async () => {
      calls += 1;
      return UNAUTHORIZED();
    });
    await expect(client.health()).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });
});

describe("without a resolver, nothing changes", () => {
  it("behaves exactly as before for callers that do not supply one", async () => {
    // The CLI is a new process per command and re-reads the lockfile anyway.
    // This must stay opt-in rather than becoming a hidden retry for everyone.
    let calls = 0;
    const client = new MuonApiClient("http://127.0.0.1:55036", async () => {
      calls += 1;
      refused();
    });

    await expect(client.health()).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(1);
  });

  it("a resolver that throws is not allowed to mask the real failure", async () => {
    const client = new MuonApiClient(
      "http://127.0.0.1:55036",
      async () => refused(),
      undefined,
      0,
      () => {
        throw new Error("lockfile unreadable");
      }
    );
    // The operator must see "the brain is unreachable", not a lockfile error
    // from the recovery attempt.
    await expect(client.health()).rejects.toThrow(/fetch failed/);
  });
});
