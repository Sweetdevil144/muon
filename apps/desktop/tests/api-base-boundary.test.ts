import { describe, expect, it } from "vitest";
import { isLoopbackApiBase } from "../src/lib/deep-links.js";

// ── Two findings from the terminal/IPC security review, one root ─────────────
//
// `settings.apiBase` was accepted with `.trim()` and nothing else, and it reaches
// two dangerous sinks:
//
//   1. `makeClient()` attaches `settings.apiToken` — the OPERATOR bearer, the
//      credential that approves gates and confirms memory — to every request
//      against that base. `restartRunner()` also hands it to the sandboxed runner
//      as `MUON_API_BASE`. So one unvalidated settings write could aim MUON's
//      whole control plane at a remote host, persistently.
//   (A second sink — the tray's "Open TUI in Terminal" AppleScript `do script`
//   — was removed with its tray item; its quoting tests went with it.)

describe("isLoopbackApiBase — the desktop is loopback-only by design", () => {
  it("accepts the loopback spellings, including IPv6 and a port", () => {
    for (const value of [
      "http://localhost:4000",
      "http://127.0.0.1:4000",
      "https://127.0.0.1:8443",
      "http://[::1]:4000",
    ]) {
      expect(isLoopbackApiBase(value), value).toBe(true);
    }
  });

  it("REFUSES a remote host — the operator-credential egress", () => {
    for (const value of [
      "https://evil.example",
      "http://10.0.0.5:4000",
      "http://muon.internal",
      // Looks loopback, is not: the host is `evil.example`.
      "http://evil.example/127.0.0.1",
      "http://127.0.0.1.evil.example",
    ]) {
      expect(isLoopbackApiBase(value), value).toBe(false);
    }
  });

  it("REFUSES a non-http scheme and anything unparseable", () => {
    for (const value of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "",
      "//127.0.0.1:4000",
    ]) {
      expect(isLoopbackApiBase(value), value).toBe(false);
    }
  });
});

