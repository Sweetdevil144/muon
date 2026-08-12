import { describe, expect, it } from "vitest";
import {
  classifyVendorFailure,
  noVendorReady,
  sanitizeVendorErrorMessage,
} from "../src/vendor-error.js";
import type { VendorReadiness } from "../src/types.js";
import { evasionPayloads, residualDanger } from "@muon/protocol";

// P6, graceful vendor-error handling. Pure classifier; deterministic.

const notInstalled: VendorReadiness = {
  vendor: "cursor",
  installed: false,
  authenticated: false,
  detail: "Cursor CLI not found",
  fixHint: "install the Cursor agent CLI (`curl https://cursor.com/install -fsS | bash`)",
};
const notLoggedIn: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: false,
  detail: "not logged in",
  fixHint: "log into Codex first: `codex login`",
};
const ready: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  detail: "logged in as dev@example.com",
};
const customProviderReady: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: true,
  credentialMethod: "custom-provider",
  detail: "configured with the active Codex provider",
};
const apiKeyReady: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  credentialMethod: "api-key",
  detail: "configured with a Claude Code API key",
};

describe("classifyVendorFailure", () => {
  it("not installed → not-ready, route onboarding, carries the install fixHint", () => {
    const notice = classifyVendorFailure({
      vendor: "cursor",
      readiness: [notInstalled],
      error: new Error("boom"),
    });
    expect(notice.kind).toBe("not-ready");
    expect(notice.route).toBe("onboarding");
    expect(notice.retryable).toBe(false);
    expect(notice.fixHint).toBe(notInstalled.fixHint);
    expect(notice.detail).toMatch(/isn't installed/i);
  });

  it("installed but not logged in → not-ready, onboarding, login fixHint", () => {
    const notice = classifyVendorFailure({
      vendor: "codex",
      readiness: [notLoggedIn],
    });
    expect(notice.kind).toBe("not-ready");
    expect(notice.route).toBe("onboarding");
    expect(notice.fixHint).toBe("log into Codex first: `codex login`");
    expect(notice.detail).toMatch(/isn't signed in/i);
  });

  it("ready vendor but a runtime AUTH error → still routed to onboarding", () => {
    const notice = classifyVendorFailure({
      vendor: "claude-code",
      readiness: [ready],
      error: new Error("Error: Please log in first (401 Unauthorized)"),
    });
    expect(notice.kind).toBe("not-ready");
    expect(notice.route).toBe("onboarding");
    // Falls back to a generic connect hint when readiness carries no fixHint.
    expect(notice.fixHint).toMatch(/sign in|ANTHROPIC_API_KEY|claude/i);
  });

  it.each([
    ["Codex custom provider", "codex", customProviderReady],
    ["Claude API key", "claude-code", apiKeyReady],
  ])(
    "usable BYOK never renders logged-out state: %s",
    (_name, vendor, readiness) => {
      const notice = classifyVendorFailure({
        vendor,
        readiness: [readiness],
        error: new Error("Not logged in (401 Unauthorized)"),
      });

      expect(notice.kind).toBe("run-failed");
      expect(notice.route).toBe("retry");
      expect(notice.retryable).toBe(true);
      expect(notice.fixHint).toBeUndefined();
      expect(JSON.stringify(notice)).not.toMatch(
        /logged out|not logged in|isn't signed in|log in first/i
      );
      expect(notice.detail).toMatch(/configured credential/i);
    }
  );

  it("ready vendor + a real run failure → run-failed, route retry, sanitized detail", () => {
    const notice = classifyVendorFailure({
      vendor: "claude-code",
      readiness: [ready],
      error: new Error("exit code 2: the check command failed\n  at Object.<anonymous>"),
    });
    expect(notice.kind).toBe("run-failed");
    expect(notice.route).toBe("retry");
    expect(notice.retryable).toBe(true);
    // First line only, no stack trace.
    expect(notice.detail).toBe("exit code 2: the check command failed");
    expect(notice.detail).not.toMatch(/at Object/);
  });

  it("never leaks a token in the classified detail (redacts token-shaped text)", () => {
    const notice = classifyVendorFailure({
      vendor: "claude-code",
      readiness: [ready],
      error: new Error("request failed with Authorization: Bearer sk-abc123DEF456ghi789"),
    });
    expect(JSON.stringify(notice)).not.toMatch(/sk-abc123DEF456ghi789/);
    expect(notice.detail).toMatch(/\[redacted\]/);
  });
});

describe("sanitizeVendorErrorMessage", () => {
  it("collapses to the first line and caps length", () => {
    expect(sanitizeVendorErrorMessage("boom\nstack line 1\nstack line 2")).toBe("boom");
    expect(sanitizeVendorErrorMessage(new Error("nope"))).toBe("nope");
    expect(sanitizeVendorErrorMessage("")).toBe("the vendor run failed");
  });

  it("redacts a token-shaped hex run even when it abuts a word char (P6 \\b gap)", () => {
    // A 64-hex MUON token butted against a word char defeated the old trailing
    // \b (x→_ is not a word boundary), leaking the token. The hex pass carries no
    // \b now, so the run is scrubbed wherever it sits; the suffix survives.
    const token = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // 64 hex
    const out = sanitizeVendorErrorMessage(`auth token ${token}_cache_miss`);
    expect(out).not.toContain(token);
    expect(out).toContain("[redacted]");
    expect(out).toBe("auth token [redacted]_cache_miss");
  });

  it("leaves a normal message untouched and still redacts sk-/bearer shapes", () => {
    expect(
      sanitizeVendorErrorMessage("the check command failed with exit code 2")
    ).toBe("the check command failed with exit code 2");
    expect(
      sanitizeVendorErrorMessage("request failed: Authorization: Bearer sk-abc123DEF456ghi789")
    ).not.toMatch(/sk-abc123DEF456ghi789/);
    expect(
      sanitizeVendorErrorMessage("denied by bearer aVeryLongOpaqueBearerToken12345")
    ).toContain("[redacted]");
  });
});

describe("the sanitizer is TERMINAL-safe, not just tidy", () => {
  // Review pass 11 F3. This function is named "sanitize" and every terminal
  // surface trusted it as one, but its only flattening was `\s+`, and `\s` in
  // JavaScript matches none of ESC (U+001B), the C1 CSI (U+009B), or the bidi
  // overrides (U+202A–202E). A backend error body is attacker/agent-reachable,
  // so SGR colour forgery and a right-to-left reorder reached the TUI's single
  // status line — one of them painting attacker text in MUON's own green.
  const ESC = String.fromCodePoint(0x1b);
  const C1_CSI = String.fromCodePoint(0x9b);
  const RLO = String.fromCodePoint(0x202e);

  it("strips escape, C1 and bidi from a hostile error body", () => {
    const hostile = `500 Internal Server Error, ${ESC}[32mVERIFIED BY MUON${ESC}[39m ${RLO}reversed${C1_CSI}2J`;
    const out = sanitizeVendorErrorMessage(new Error(hostile));
    expect(residualDanger(out, [])).toEqual([]);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(C1_CSI);
    expect(out).not.toContain(RLO);
    // The words survive — this flattens, it does not censor.
    expect(out).toContain("500 Internal Server Error");
  });

  it("replays the shared evasion corpus without leaking a control byte", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const out = sanitizeVendorErrorMessage(new Error(payload.text));
      expect(residualDanger(out, []), payload.id).toEqual([]);
    }
  });

  it("an all-control message becomes the honest generic line", () => {
    // Not the "(no printable text)" marker: presenting that as the vendor's
    // own words would be worse than saying plainly that the run failed.
    expect(sanitizeVendorErrorMessage(new Error(`${ESC}${RLO}${C1_CSI}`))).toBe(
      "the vendor run failed"
    );
  });

  it("the TITLE is sanitized too — vendorLabel falls through to a raw id", () => {
    const notice = classifyVendorFailure({
      vendor: `eviл${RLO}lane`,
      readiness: [],
      error: new Error("boom"),
    });
    expect(residualDanger(notice.title, [])).toEqual([]);
  });
});

describe("noVendorReady", () => {
  it("true when nothing is connected, false once one vendor is ready", () => {
    expect(noVendorReady([notInstalled, notLoggedIn])).toBe(true);
    expect(noVendorReady([ready])).toBe(false);
    expect(noVendorReady(null)).toBe(true);
  });
});
