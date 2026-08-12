import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VendorReadiness } from "@muon/client";
import { Onboarding } from "../src/renderer/onboarding.js";

/**
 * The desktop first-run wizard renders the shared readiness→step machine.
 * We render it to static markup (no Electron, no DOM) with a MOCKED readiness
 * array, the same seam the renderer feeds from `getVendorReadiness()`.
 */
function render(readiness: VendorReadiness[] | null): string {
  return renderToStaticMarkup(
    React.createElement(Onboarding, {
      readiness,
      // P6, "Run your first task" seeds + dispatches the sample task; the static
      // render never clicks it, so a no-op stub is enough for the markup asserts.
      onRunFirstTask: async () => ({ ok: false, reason: "canceled" }) as const,
      onRecheck: async () => undefined,
    })
  );
}

const ready: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  detail: "logged in as dev@example.com",
};

const installedNotAuth: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: false,
  detail: "not logged in",
  fixHint: "log into Codex first: `codex login`",
};

const notInstalled: VendorReadiness = {
  vendor: "cursor",
  installed: false,
  authenticated: false,
  detail: "Cursor CLI not found",
  fixHint: "install the Cursor agent CLI, then `cursor-agent login`",
};

describe("desktop Onboarding wizard", () => {
  it("connect phase: shows install hint + native login command, first-task locked", () => {
    const html = render([notInstalled, installedNotAuth]);
    expect(html).toContain("Connect or configure a coding agent");
    // installed-but-not-authed → the exact login command the user runs
    expect(html).toContain("codex login");
    // not-installed → the install hint (we never auto-install)
    expect(html).toContain("install the Cursor agent CLI");
    // First dispatch stays locked until an agent is ready.
    expect(html).toContain("Connect an agent to start");
    expect(html).toContain("disabled");
  });

  it("ready phase: unlocks the 'Run your first task' affordance", () => {
    const html = render([ready, installedNotAuth]);
    expect(html).toContain("You&#x27;re connected");
    expect(html).toContain("Run your first task");
    expect(html).toContain("completed task");
    expect(html).toContain("captured memory");
    // The connected vendor is shown as ready.
    expect(html).toContain("Claude Code");
    expect(html).toContain("ready");
  });

  it("degraded: readiness unavailable → manual steps, no false 'ready'", () => {
    const html = render(null);
    expect(html).toContain("Couldn&#x27;t check agent readiness");
    expect(html).toMatch(/claude|codex login|cursor-agent login/);
    expect(html).toContain("Connect an agent to start");
  });

  it("surfaces a failed readiness refresh inside the onboarding overlay", () => {
    const html = renderToStaticMarkup(
      React.createElement(Onboarding, {
        readiness: [installedNotAuth],
        onRunFirstTask: async () =>
          ({ ok: false, reason: "canceled" }) as const,
        onRecheck: async () => undefined,
        recheckError: "Provider checks are unavailable right now.",
      })
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Provider checks are unavailable right now.");
  });

  it("never leaks a token, and drops the redundant local-credentials footer", () => {
    for (const input of [[ready], [installedNotAuth], null] as const) {
      const html = render(input);
      // Founder call: the "MUON never stores… credentials" footer is noise the
      // user already knows — it must NOT be rendered.
      expect(html).not.toContain("MUON never stores, logs, or displays");
      expect(html).not.toMatch(/sk-|bearer|secret/i);
    }
  });

  it("restyles the connect list as prototype-style cards: icon tile, honest status line, Ready badge or Set-up label", () => {
    const html = render([ready, installedNotAuth]);
    // Card containers for every reported vendor, per the prototype's
    // `.connect` card treatment (icon tile + name/status + right-side badge).
    expect(html).toContain('class="connect-list"');
    expect(html).toContain('class="connect-card ready"');
    expect(html).toContain('class="connect-card login"');
    // Decorative brand glyph tile (the app's ONE vendor icon registry), never a
    // substitute for the name text. It replaced a wizard-local initials table
    // that had no entry for the fourth lane.
    const tiles = html.match(
      /<span class="connect-icon" aria-hidden="true">.*?<\/span><\/span>/g
    );
    expect(tiles?.length).toBe(2);
    for (const tile of tiles ?? []) {
      expect(tile).toContain("<svg");
      expect(tile).toContain('class="vendor-icon"');
    }
    // A truly dispatch-ready vendor gets the Ready badge…
    expect(html).toMatch(/<span class="connect-badge ready"[^>]*>Ready<\/span>/);
    // …an installed-but-not-authenticated vendor gets the honest Set-up
    // label, never a false "Ready".
    expect(html).toMatch(
      /<span class="connect-badge setup"[^>]*>Set up<\/span>/
    );
  });

  it("gives OpenCode a real branded card, its own label, and the real login", () => {
    const html = render([
      {
        vendor: "opencode",
        installed: true,
        authenticated: false,
        detail: "not logged in",
        fixHint: "log into OpenCode first: `opencode auth login`",
      },
    ]);
    // Never an unbranded card with an initials tile.
    expect(html).toContain("OpenCode");
    expect(html).toContain('class="vendor-icon"');
    // The exact self-service command, verbatim from the probe.
    expect(html).toContain("opencode auth login");
    // Unlike the Ollama lane it replaced, this one HAS an account, so the
    // account-free copy must NOT appear.
    expect(html).not.toMatch(/no sign-in exists/i);
  });

  it("a connected role-scoped lane gets a third badge state and the reason, not a false Ready or a false Set up", () => {
    const html = render([
      {
        vendor: "cursor",
        installed: true,
        authenticated: true,
        detail: "logged in as dev@example.com",
      },
    ]);
    expect(html).toMatch(
      /<span class="connect-badge scoped"[^>]*>Role-scoped<\/span>/
    );
    expect(html).not.toContain(">Ready<");
    expect(html).not.toContain(">Set up<");
    // The Gap-2 dead end: connected + green, still on "connect an agent", no
    // reason given. The reason is now on the page.
    expect(html).toContain("Connect a lane that can make changes.");
    expect(html).toMatch(/read-only crew roles only/);
    expect(html).toContain("reviewer, qa, architect, scout");
    expect(html).toContain("Connect an agent to start");
  });

  it("shows the real shared guidance sentence as each vendor's status line, not a fabricated tagline", () => {
    const html = render([installedNotAuth]);
    // Sourced verbatim from `vendorOnboardingStep` (packages/client), the same
    // copy the CLI and TUI render — never a desktop-only paraphrase.
    expect(html).toContain(
      "Codex is installed · setup needed. Sign in or configure its supported provider credentials."
    );
  });

  it("shows a centered logo mark above the headline", () => {
    const html = render([ready]);
    const mark = html.match(/<img[^>]*class="onboarding-logo"[^>]*>/)?.[0];
    expect(mark).toBeDefined();
    // decorative only, never announced, never the sole label for the brand
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).toContain('alt=""');
    expect(html.indexOf(mark!)).toBeLessThan(html.indexOf("<h1>"));
  });
});
