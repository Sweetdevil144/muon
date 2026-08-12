import { describe, expect, it, vi } from "vitest";

/**
 * T5 — THE SHARED-POLICY PIN, exercised the only way it can be.
 *
 * `terminal-spawn.ts` folds every `MUON_`-prefixed name from
 * `OPERATOR_TOKEN_ENV_VARS` (packages/adapters/src/sandbox/credential-policy.ts)
 * into the set a human terminal never inherits. Today the two agree exactly, so
 * a test written against the real constant cannot tell whether the fold is
 * there — deleting it changes nothing observable, which is precisely the
 * silence a drift guard has to break.
 *
 * So this file states the future: the shared policy gains a name this module's
 * own list does not have, AND that name does not end in `_TOKEN`, so the
 * pattern backstop cannot cover for a missing fold either. With the fold, it is
 * stripped. Without it, it reaches the vendor CLI.
 *
 * Its own file because the mock has to be in place before `terminal-spawn.ts`
 * is imported, and every other consumer of that module wants the real policy.
 */
const FUTURE_POLICY_NAME = "MUON_FUTURE_POLICY_KEY";

vi.mock("@muon/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/adapters")>();
  return {
    ...actual,
    OPERATOR_TOKEN_ENV_VARS: [
      ...actual.OPERATOR_TOKEN_ENV_VARS,
      FUTURE_POLICY_NAME,
    ],
  };
});

const { resolveTerminalSpawn, TERMINAL_STRIPPED_ENV_VARS } = await import(
  "../src/lib/terminal-spawn.js"
);

describe("a name added to the shared credential policy reaches this boundary", () => {
  it("is stripped from a human terminal without anyone editing this module", () => {
    // The pattern backstop is deliberately NOT what catches it.
    expect(FUTURE_POLICY_NAME.startsWith("MUON_")).toBe(true);
    expect(FUTURE_POLICY_NAME.endsWith("_TOKEN")).toBe(false);
    expect(TERMINAL_STRIPPED_ENV_VARS).toContain(FUTURE_POLICY_NAME);

    const previous = process.env[FUTURE_POLICY_NAME];
    process.env[FUTURE_POLICY_NAME] = "policy-secret";
    try {
      for (const kind of ["shell", "codex"]) {
        expect(
          resolveTerminalSpawn(kind, "/repo").env?.[FUTURE_POLICY_NAME],
          `${FUTURE_POLICY_NAME} survived into a '${kind}' terminal`
        ).toBeUndefined();
      }
    } finally {
      if (previous === undefined) {
        delete process.env[FUTURE_POLICY_NAME];
      } else {
        process.env[FUTURE_POLICY_NAME] = previous;
      }
    }
  });
});
