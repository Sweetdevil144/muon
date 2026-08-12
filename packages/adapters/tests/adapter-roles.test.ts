import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  ROLE_SPECS,
  type AgentRole,
  type LaneAdapter,
} from "@muon/protocol";
import { ClaudeAdapter } from "../src/claude-adapter.js";
import { CodexAdapter } from "../src/codex-adapter.js";
import { CursorAdapter } from "../src/cursor-adapter.js";
import { FakeLaneAdapter } from "../src/fake-lane-adapter.js";
import { OpencodeAdapter } from "../src/opencode-adapter.js";

/**
 * The role declarations are a CEILING the assignment engine trusts, so they must
 * be internally consistent with the protocol's own role table. Everything here
 * is a pure data assertion: no binary, no daemon, no network.
 */
const adapters: LaneAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new CursorAdapter(),
  new OpencodeAdapter(),
  new FakeLaneAdapter(),
];

describe("adapter role declarations", () => {
  for (const adapter of adapters) {
    describe(adapter.id, () => {
      it("declares both supportedRoles and roleAffinity", () => {
        expect(adapter.supportedRoles).toBeDefined();
        expect(adapter.roleAffinity).toBeDefined();
      });

      it("only names roles from the protocol taxonomy", () => {
        for (const role of adapter.supportedRoles ?? []) {
          expect(AGENT_ROLES).toContain(role);
        }
        for (const role of Object.keys(adapter.roleAffinity ?? {})) {
          expect(AGENT_ROLES).toContain(role as AgentRole);
        }
      });

      it("never declares a role whose required capabilities it lacks", async () => {
        const capabilities = await adapter.capabilities();
        for (const role of adapter.supportedRoles ?? []) {
          const missing = ROLE_SPECS[role].requiredCapabilities.filter(
            (capability) => !capabilities[capability]
          );
          expect(
            missing,
            `${adapter.id} claims '${role}' but lacks ${missing.join(", ")}`
          ).toEqual([]);
        }
      });

      it("never scores a role it cannot hold", () => {
        const supported = new Set<string>(adapter.supportedRoles ?? []);
        for (const role of Object.keys(adapter.roleAffinity ?? {})) {
          expect(
            supported.has(role),
            `${adapter.id} scores '${role}' but does not support it`
          ).toBe(true);
        }
      });

      it("keeps every affinity inside 0..1", () => {
        for (const [role, value] of Object.entries(adapter.roleAffinity ?? {})) {
          expect(Number.isFinite(value), `${role} affinity must be finite`).toBe(
            true
          );
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      });
    });
  }

  it("keeps Cursor to read-only roles only", () => {
    const cursor = new CursorAdapter();
    expect([...(cursor.supportedRoles ?? [])].sort()).toEqual([
      "architect",
      "qa",
      "reviewer",
      "scout",
    ]);
    for (const role of cursor.supportedRoles ?? []) {
      expect(ROLE_SPECS[role].authority).toBe("read-only");
      expect(ROLE_SPECS[role].allowsWriteTools).toBe(false);
    }
    // The three write/coordinate roles are refused at the ceiling, before any
    // capability or affinity arithmetic can rank around them.
    for (const role of ["implementer", "docs", "orchestrator"] as const) {
      expect(cursor.supportedRoles).not.toContain(role);
    }
  });

  it("holds OpenCode to scout and nothing else", () => {
    const opencode = new OpencodeAdapter();
    // Stated POSITIVELY: the whole ceiling is one role. Asserting the exact
    // array (rather than a list of absences) is what makes a future widening
    // fail here instead of sliding through as an unlisted role.
    expect([...opencode.supportedRoles]).toEqual(["scout"]);
    // Every role it does NOT hold, named, so the refusals are pinned too.
    for (const role of [
      "orchestrator",
      "implementer",
      "docs",
      "reviewer",
      "qa",
      "architect",
    ] as const) {
      expect(opencode.supportedRoles).not.toContain(role);
    }
  });

  it("keeps Cursor ahead of OpenCode on scouting", () => {
    // The Ollama lane used to win `scout` on affinity (0.85). Removing it had to
    // hand `scout` to Cursor, not to the vendor that replaced it — otherwise the
    // swap would silently re-route every existing crew's reconnaissance.
    const opencode = new OpencodeAdapter().roleAffinity?.scout ?? 0;
    expect(new CursorAdapter().roleAffinity?.scout ?? 0).toBeGreaterThan(
      opencode
    );
    expect(opencode).toBeGreaterThan(
      new ClaudeAdapter().roleAffinity?.scout ?? 0
    );
    expect(opencode).toBeGreaterThan(
      new CodexAdapter().roleAffinity?.scout ?? 0
    );
  });

  it("keeps the frontier lanes ahead on the roles that write or adjudicate", () => {
    const claude = new ClaudeAdapter().roleAffinity ?? {};
    const codex = new CodexAdapter().roleAffinity ?? {};
    const cursor = new CursorAdapter().roleAffinity ?? {};
    // Codex owns the change and the checks; Claude Code owns design and docs.
    expect(codex.implementer ?? 0).toBeGreaterThanOrEqual(
      codex.architect ?? 0
    );
    expect(claude.architect ?? 0).toBeGreaterThan(codex.architect ?? 0);
    expect(codex.qa ?? 0).toBeGreaterThan(claude.qa ?? 0);
    // Cursor reviews well but cannot be interposed on, so it sits below both.
    expect(cursor.reviewer ?? 0).toBeLessThan(claude.reviewer ?? 0);
    expect(cursor.reviewer ?? 0).toBeLessThan(codex.reviewer ?? 0);
  });
});
