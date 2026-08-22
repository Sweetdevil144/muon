import { describe, expect, it, vi } from "vitest";
import {
  createObservatoryUploader,
  FLUSH_AT_COUNT,
  OBSERVATORY_UPLOAD_PROVIDER,
} from "../src/lib/observatory-upload.js";
import type { ObservatoryRecord } from "../src/lib/observatory.js";

// ADR-0031. The uploader's contract: consent at send time, wire payload =
// spool row verbatim + anonymous id, silent bounded retry, zero egress with
// no consent or no key.

function row(name: string): ObservatoryRecord {
  return {
    name: name as ObservatoryRecord["name"],
    at: "2026-08-07T00:00:00.000Z",
    appVersion: "0.1.1",
    platform: "darwin",
    arch: "arm64",
    provider: "none",
    schema: 1,
  } as ObservatoryRecord;
}

function makeUploader(overrides: {
  enabled?: () => boolean;
  deviceId?: () => string | null;
  fetcher?: typeof fetch;
  key?: string;
}) {
  return createObservatoryUploader({
    enabled: overrides.enabled ?? (() => true),
    deviceId: overrides.deviceId ?? (() => "device-1"),
    fetcher: overrides.fetcher ?? (vi.fn() as unknown as typeof fetch),
    key: overrides.key ?? "phc_test",
    host: "https://ph.example",
    scheduleFlush: () => () => undefined, // no timers in tests
  });
}

describe("ADR-0031 observatory uploader", () => {
  it("without consent: nothing buffers, nothing sends", async () => {
    const fetcher = vi.fn();
    const up = makeUploader({
      enabled: () => false,
      fetcher: fetcher as unknown as typeof fetch,
    });
    up.enqueue(row("app.launch"));
    await up.flush();
    expect(up.pending()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("an empty key disables egress entirely", async () => {
    const fetcher = vi.fn();
    const up = makeUploader({ key: "", fetcher: fetcher as unknown as typeof fetch });
    up.enqueue(row("app.launch"));
    await up.flush();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the record verbatim as properties + the anonymous id, nothing else", async () => {
    const fetcher = vi.fn(async () => ({ ok: true }) as Response);
    const up = makeUploader({ fetcher: fetcher as unknown as typeof fetch });
    up.enqueue(row("funnel.first_chat"));
    await up.flush();

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://ph.example/batch/");
    const body = JSON.parse(String(init.body)) as {
      api_key: string;
      batch: { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }[];
    };
    expect(body.api_key).toBe("phc_test");
    expect(body.batch).toHaveLength(1);
    const entry = body.batch[0]!;
    expect(entry.event).toBe("funnel.first_chat");
    expect(entry.distinct_id).toBe("device-1");
    expect(entry.timestamp).toBe("2026-08-07T00:00:00.000Z");
    // Properties are the row minus name/at, plus EXACTLY one deliberate key:
    // `$ip: null`, which forbids PostHog's ingest from stamping the request's
    // source IP onto the event (ADR-0095 D3; the review's F4).
    expect(entry.properties).toEqual({
      appVersion: "0.1.1",
      platform: "darwin",
      arch: "arm64",
      provider: "none",
      schema: 1,
      $ip: null,
    });
  });

  it("a network failure retains the batch and retries on the next flush", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return { ok: true } as Response;
    });
    const up = makeUploader({ fetcher: fetcher as unknown as typeof fetch });
    up.enqueue(row("app.launch"));
    await up.flush();
    expect(up.pending()).toBe(1); // retained
    await up.flush();
    expect(up.pending()).toBe(0); // delivered
    expect(calls).toBe(2);
  });

  it("consent revoked mid-buffer drops the rows instead of uploading them later", async () => {
    let consent = true;
    const fetcher = vi.fn(async () => ({ ok: true }) as Response);
    const up = makeUploader({
      enabled: () => consent,
      fetcher: fetcher as unknown as typeof fetch,
    });
    up.enqueue(row("app.launch"));
    consent = false;
    await up.flush();
    expect(up.pending()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("auto-flushes at the batch threshold", async () => {
    const fetcher = vi.fn(async () => ({ ok: true }) as Response);
    const up = makeUploader({ fetcher: fetcher as unknown as typeof fetch });
    for (let i = 0; i < FLUSH_AT_COUNT; i += 1) {
      up.enqueue(row("app.launch"));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalled();
  });

  it("holds (bounded) while the consent epoch has no device id yet", async () => {
    const fetcher = vi.fn(async () => ({ ok: true }) as Response);
    const up = makeUploader({
      deviceId: () => null,
      fetcher: fetcher as unknown as typeof fetch,
    });
    up.enqueue(row("app.launch"));
    await up.flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(up.pending()).toBe(1);
  });
});

describe("revocation drops the buffer immediately, not at the next flush", () => {
  // cubic's finding, and it is a real race. `flush` refuses without consent and
  // empties the buffer when it NOTICES — but it only notices on a timer tick or
  // at the batch threshold. Between a revoke and the next flush the rows sit
  // there, and re-granting inside that window mints a new consent epoch, so the
  // next flush finds consent true, a device id present, and ships the
  // pre-revocation rows under the NEW consent.
  function harness() {
    let enabled = true;
    let deviceId: string | null = "epoch-1";
    const sent: unknown[] = [];
    const uploader = createObservatoryUploader({
      enabled: () => enabled,
      deviceId: () => deviceId,
      key: "phc_test",
      fetcher: (async (_url: string, init?: { body?: string }) => {
        sent.push(JSON.parse(String(init?.body ?? "{}")));
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
      scheduleFlush: () => () => undefined,
    });
    return {
      uploader,
      sent,
      revoke: () => {
        enabled = false;
        deviceId = null;
      },
      regrant: () => {
        enabled = true;
        deviceId = "epoch-2";
      },
    };
  }

  const record = (name: string) =>
    ({ name, at: "2026-08-07T00:00:00.000Z" }) as never;

  it("does NOT upload pre-revocation rows after a rapid re-grant", async () => {
    const h = harness();
    h.uploader.enqueue(record("app.launch"));
    expect(h.uploader.pending()).toBe(1);

    h.revoke();
    h.uploader.discard();
    h.regrant();
    await h.uploader.flush();

    expect(h.uploader.pending()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("without discard, the same sequence would have shipped them", async () => {
    // The counterfactual, so the fix is not mistaken for a no-op: consent is
    // restored before any flush runs, so nothing else in the path ever drops
    // the row.
    const h = harness();
    h.uploader.enqueue(record("app.launch"));
    h.revoke();
    h.regrant();
    await h.uploader.flush();
    expect(h.sent.length).toBe(1);
  });

  it("discard is safe to call when nothing is buffered", () => {
    const h = harness();
    expect(() => h.uploader.discard()).not.toThrow();
    expect(h.uploader.pending()).toBe(0);
  });
});

describe("v2 surface events on the wire (ADR-0095 shape pins)", () => {
  // The appendix's discipline: assert the SHAPE of what leaves the machine.
  // The wire payload is the spool row verbatim, so these pins are the egress
  // audit for the three events the 2026-08-23 grant added.
  const AT = "2026-08-23T00:00:00.000Z";
  // The REAL configured provider (the review's F11: pinning "none" audited a
  // payload production never emits).
  const base = {
    at: AT,
    appVersion: "0.6.1",
    platform: "darwin" as const,
    arch: "arm64",
    provider: OBSERVATORY_UPLOAD_PROVIDER,
    schema: 2 as const,
  };

  async function send(record: ObservatoryRecord) {
    const fetcher = vi.fn(async () => ({ ok: true }) as Response);
    const up = makeUploader({ fetcher: fetcher as unknown as typeof fetch });
    up.enqueue(record);
    await up.flush();
    const [, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    const body = String(init.body);
    const parsed = JSON.parse(body) as {
      batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[];
    };
    return { body, entry: parsed.batch[0]! };
  }

  it("mcp.tool_call ships EXACTLY usage coordinates — never arguments or results", async () => {
    const { body, entry } = await send({
      name: "mcp.tool_call",
      tool: "memory_search",
      durationMs: 42,
      error: "none",
      client: "claude-code",
      ...base,
    } as ObservatoryRecord);
    expect(entry.event).toBe("mcp.tool_call");
    expect(entry.properties).toEqual({
      tool: "memory_search",
      durationMs: 42,
      error: "none",
      client: "claude-code",
      appVersion: "0.6.1",
      platform: "darwin",
      arch: "arm64",
      provider: OBSERVATORY_UPLOAD_PROVIDER,
      schema: 2,
      $ip: null,
    });
    for (const forbidden of ["query", "notes", "path", "token", "prompt", "arguments", "result"]) {
      expect(body).not.toContain(`"${forbidden}"`);
    }
  });

  it("identity gate events ship surface + coarse reason and NO identity coordinate", async () => {
    const passed = await send({
      name: "identity.gate_passed",
      surface: "cli",
      trigger: "command",
      ...base,
    } as ObservatoryRecord);
    expect(passed.entry.properties).toEqual({
      surface: "cli",
      trigger: "command",
      appVersion: "0.6.1",
      platform: "darwin",
      arch: "arm64",
      provider: OBSERVATORY_UPLOAD_PROVIDER,
      schema: 2,
      $ip: null,
    });
    const refused = await send({
      name: "identity.gate_refused",
      surface: "mcp",
      reason: "expired",
      trigger: "tool_call",
      ...base,
    } as ObservatoryRecord);
    expect(refused.entry.properties).toEqual({
      surface: "mcp",
      reason: "expired",
      trigger: "tool_call",
      appVersion: "0.6.1",
      platform: "darwin",
      arch: "arm64",
      provider: OBSERVATORY_UPLOAD_PROVIDER,
      schema: 2,
      $ip: null,
    });
    // The 0052 rule, pinned at the egress boundary: no login, no id, no
    // digest — the ONLY identifier on the wire is the anonymous device id.
    for (const forbidden of ["login", "ghId", "ghLogin", "digest", "token", "email"]) {
      expect(passed.body).not.toContain(`"${forbidden}"`);
      expect(refused.body).not.toContain(`"${forbidden}"`);
    }
    expect(passed.entry.distinct_id).toBe("device-1");
  });
});
