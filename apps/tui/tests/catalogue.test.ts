import { describe, expect, it } from "vitest";
import {
  buildCatalogue,
  filterCatalogue,
  type CatalogueEntry,
} from "../src/lib/catalogue.js";
import { PALETTE_COMMANDS } from "../src/lib/palette.js";
import { evasionPayloads, residualDanger } from "@muon/client";

// ADR-0042 D6. MUON models four kinds of invocable thing in four registries and
// surfaces them in four places — or, for harnesses and custom agents in the
// TUI, nowhere. `/ship` is discoverable and the `security-audit` harness is
// not, for no reason a user could state.

const harness = (over: Record<string, unknown> = {}) =>
  ({
    id: "h1",
    key: "security-audit",
    name: "Security audit",
    version: 1,
    createdBy: "muon",
    createdAt: "",
    updatedAt: "",
    config: {
      description: "Read-only audit with network tools denied.",
      profileOverlay: { sandbox: "read-only", permissionMode: "strict" },
      checks: [],
      ...(over.config as object),
    },
    ...over,
  }) as never;

describe("one list, four kinds", () => {
  it("puts harnesses and custom agents beside commands", () => {
    const entries = buildCatalogue({
      harnesses: [harness()],
      customAgents: [{ id: "custom:mine", slug: "mine", name: "My agent" }],
    });
    const kinds = new Set(entries.map((entry) => entry.kind));
    expect(kinds.has("command")).toBe(true);
    expect(kinds.has("harness")).toBe(true);
    expect(kinds.has("agent")).toBe(true);
  });

  it("orders commands first — that is what `/` is for", () => {
    const entries = buildCatalogue({ harnesses: [harness()] });
    expect(entries[0]!.kind).toBe("command");
  });

  it("falls back to the built-in commands when none are supplied", () => {
    expect(
      buildCatalogue({}).filter((entry) => entry.kind === "command").length
    ).toBe(PALETTE_COMMANDS.length);
  });

  it("omits a category entirely when its source did not load", () => {
    // "You have no harnesses" and "MUON could not read your harnesses" are
    // different facts. This function never fabricates the first from the
    // second; the caller owns which it reports.
    const entries = buildCatalogue({});
    expect(entries.some((entry) => entry.kind === "harness")).toBe(false);
  });
});

describe("authority is carried, not decorated", () => {
  it("reports what a harness SETS, without claiming it cannot widen", () => {
    // This test used to assert `/never widen/` and pinned a false claim in
    // place. A harness CAN widen: `applyHarnessToProfile` unions
    // `preauthorizedTools` into `allowedTools` (removing a must-ask gate), and
    // the overlay can replace `permissionMode`/`sandbox` with a wider value.
    const [entry] = buildCatalogue({ harnesses: [harness()] }).filter(
      (candidate) => candidate.kind === "harness"
    );
    expect(entry!.authority).toContain("read-only");
    expect(entry!.authority).not.toMatch(/never widen/i);
  });

  it("NAMES pre-authorized tools — the one field that grants authority", () => {
    const [entry] = buildCatalogue({
      harnesses: [
        harness({
          config: {
            description: "Implement",
            profileOverlay: { sandbox: "workspace-write" },
            checks: [],
            preauthorizedTools: ["Write", "Edit"],
          },
        }),
      ],
    }).filter((candidate) => candidate.kind === "harness");
    expect(entry!.authority).toContain("PRE-AUTHORIZES");
    expect(entry!.authority).toContain("Write");
    expect(entry!.authority).toMatch(/WITHOUT asking you/);
  });

  it("says so plainly when a harness pre-authorizes nothing", () => {
    const [entry] = buildCatalogue({ harnesses: [harness()] }).filter(
      (candidate) => candidate.kind === "harness"
    );
    expect(entry!.authority).toMatch(/Pre-authorizes nothing/);
    expect(entry!.authority).toMatch(/must-ask/);
  });

  it("does not describe a widening overlay as a narrowing", () => {
    // The self-contradicting render the old string produced:
    // "Narrows the lane — full-access · full-auto; it can never widen one."
    const [entry] = buildCatalogue({
      harnesses: [
        harness({
          config: {
            description: "",
            profileOverlay: { sandbox: "full-access", permissionMode: "full-auto" },
            checks: [],
          },
        }),
      ],
    }).filter((candidate) => candidate.kind === "harness");
    expect(entry!.authority).not.toMatch(/narrow/i);
    expect(entry!.authority).toContain("full-access");
  });

  it("says a custom agent is UNGOVERNED, in those words", () => {
    // The separate id namespace exists because MUON did not spawn it. A
    // catalogue that listed it beside governed lanes looking identical would
    // be the most misleading thing on the screen.
    const [entry] = buildCatalogue({
      customAgents: [{ id: "custom:mine", slug: "mine" }],
    }).filter((candidate) => candidate.kind === "agent");
    expect(entry!.authority).toMatch(/UNGOVERNED/);
    expect(entry!.badge).toBe("ungoverned");
  });

  it("gives every command the authority its contract already states", () => {
    for (const entry of buildCatalogue({}).filter((e) => e.kind === "command")) {
      expect(entry.authority, entry.label).toBeTruthy();
    }
  });
});

describe("filtering", () => {
  const entries: CatalogueEntry[] = buildCatalogue({
    harnesses: [harness()],
    customAgents: [{ id: "custom:mine", slug: "mine", name: "My agent" }],
  });

  it("matches label, effect and keywords", () => {
    expect(filterCatalogue(entries, "security").length).toBeGreaterThan(0);
    expect(filterCatalogue(entries, "audit").length).toBeGreaterThan(0);
  });

  it("narrows to one kind with a `kind:` prefix", () => {
    const harnesses = filterCatalogue(entries, "harness:");
    expect(harnesses.length).toBeGreaterThan(0);
    expect(harnesses.every((entry) => entry.kind === "harness")).toBe(true);
  });

  it("combines a kind prefix with a term", () => {
    expect(filterCatalogue(entries, "harness:security").length).toBe(1);
    expect(filterCatalogue(entries, "harness:nothingmatches")).toEqual([]);
  });

  it("returns everything for an empty query, and never mutates the input", () => {
    const before = entries.length;
    expect(filterCatalogue(entries, "   ").length).toBe(before);
    expect(entries.length).toBe(before);
  });

  it("is case-insensitive and does not reorder as you type", () => {
    // Substring, not fuzzy scoring: a list that reshuffles itself on each
    // keystroke is harder to use than one that simply shrinks.
    const upper = filterCatalogue(entries, "SECURITY");
    const lower = filterCatalogue(entries, "security");
    expect(upper.map((e) => e.id)).toEqual(lower.map((e) => e.id));
    const all = filterCatalogue(entries, "");
    const filtered = filterCatalogue(entries, "a");
    const orderInAll = filtered.map((e) => all.findIndex((x) => x.id === e.id));
    expect(orderInAll).toEqual([...orderInAll].sort((a, b) => a - b));
  });
});

describe("filter ranking", () => {
  it("puts the command whose NAME you typed first", () => {
    // Found by a run-form test, not by inspection: filtering alone ranked
    // "Quickstart: run your first task…" above "Run task on lane" for `run`,
    // because Q sorts before R — on a list whose Enter executes.
    const entries = buildCatalogue({ commands: PALETTE_COMMANDS });
    expect(filterCatalogue(entries, "run")[0]?.id).toBe("command:run");
  });

  it("an exact id or label beats a substring match elsewhere", () => {
    const entries = buildCatalogue({ commands: PALETTE_COMMANDS });
    // Both queries must have MORE THAN ONE match, or the assertion passes
    // with the ranking deleted — "plan" used to return exactly one entry,
    // which made half this test vacuous.
    expect(filterCatalogue(entries, "ship").length).toBeGreaterThan(1);
    expect(filterCatalogue(entries, "ship")[0]?.id).toBe("command:ship");
    expect(filterCatalogue(entries, "status").length).toBeGreaterThan(1);
    expect(filterCatalogue(entries, "status")[0]?.id).toBe("command:status");
  });

  it("an empty query keeps the stable catalogue order", () => {
    // Ranking must not disturb the resting list — that order is what the
    // frozen-palette snapshot and the ordinal hints rely on.
    const entries = buildCatalogue({ commands: PALETTE_COMMANDS });
    expect(filterCatalogue(entries, "").map((entry) => entry.id)).toEqual(
      entries.map((entry) => entry.id)
    );
  });
});

describe("stored text is sanitized where it ENTERS the catalogue", () => {
  // Commands are static and in-repo. Harness and custom-agent text is a
  // stored row — vendor-, agent-, or corruption-authored — and this catalogue
  // was the first surface putting it on a terminal with no sanitizer at all.
  // The palette is the surface whose Enter EXECUTES, so a repaint here is not
  // cosmetic.

  const CONTROL_CLASSES = [
    "invisible-directive",
    "reorder",
    "repaint",
    "row-forgery",
  ] as const;

  function textFields(entry: CatalogueEntry): string[] {
    return [
      entry.label,
      entry.effect,
      entry.authority ?? "",
      entry.badge ?? "",
      ...entry.keywords,
    ];
  }

  it("no control-carrying payload survives into a harness entry", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const [entry] = buildCatalogue({
        harnesses: [
          harness({
            name: payload.text,
            key: payload.text,
            config: {
              description: payload.text,
              profileOverlay: {
                sandbox: payload.text,
                permissionMode: payload.text,
              },
              // The highest-stakes string this file renders: it is spliced
              // into "PRE-AUTHORIZES x — those run WITHOUT asking you."
              preauthorizedTools: [payload.text],
            },
          }),
        ],
      }).filter((candidate) => candidate.kind === "harness");
      for (const field of textFields(entry!)) {
        expect(residualDanger(field, []), payload.id).toEqual([]);
      }
    }
  });

  it("no control-carrying payload survives into a custom-agent entry", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const [entry] = buildCatalogue({
        customAgents: [
          {
            id: "custom:x",
            slug: payload.text,
            name: payload.text,
            description: payload.text,
          },
        ],
      }).filter((candidate) => candidate.kind === "agent");
      for (const field of textFields(entry!)) {
        expect(residualDanger(field, []), payload.id).toEqual([]);
      }
    }
  });

  it("an absent description still reads as absent, not as hostile", () => {
    // Ordering bug this pins: terminalSafe("") returns the "(no printable
    // text)" marker, so sanitizing BEFORE choosing the fallback would label
    // every description-less harness as unrenderable.
    const [entry] = buildCatalogue({
      // NOTE: `...over` replaces `config` wholesale, so the overlay has to be
      // restated here — the defaults above do not merge into it.
      harnesses: [
        harness({
          config: {
            description: "",
            profileOverlay: { sandbox: "read-only", permissionMode: "strict" },
          },
        }),
      ],
    }).filter((candidate) => candidate.kind === "harness");
    expect(entry!.effect).toContain("applies:");
    expect(entry!.effect).not.toContain("no printable text");
  });

  it("a name of only invisible characters is reported, not papered over", () => {
    // The name is TRUTHY so it wins the fallback chain and sanitizes to the
    // marker. Falling through to the slug would hide an unrenderable name
    // behind a plausible label.
    const [entry] = buildCatalogue({
      customAgents: [{ id: "custom:x", slug: "real-slug", name: "\u200b\u200b" }],
    }).filter((candidate) => candidate.kind === "agent");
    expect(entry!.label).toBe("(no printable text)");
  });

  it("a keyword that sanitized to nothing is dropped, not left as a marker", () => {
    const [entry] = buildCatalogue({
      customAgents: [{ id: "custom:x", slug: "\u200b", name: "A" }],
    }).filter((candidate) => candidate.kind === "agent");
    expect(entry!.keywords).not.toContain("(no printable text)");
    expect(entry!.keywords).not.toContain("");
  });

  it("ranking sees the SANITIZED text, so what you read is what you match", () => {
    // The property that makes sanitizing at construction (not at render)
    // the right call: the entry is also what filterCatalogue matches and
    // what band() ranks. An invisible prefix must not change either.
    const entries = buildCatalogue({
      customAgents: [{ id: "custom:x", slug: "z", name: "\u200baudit\u200b" }],
    });
    const [top] = filterCatalogue(entries, "audit");
    expect(top?.label).toBe("audit");
  });

  it("a stored name that collides with a command loses the tie to the command", () => {
    // #8, pinned rather than assumed: an exact-match agent reaches ranking
    // band 0 alongside the real command. KIND_ORDER breaks that tie toward
    // the command, which is what `/` is for. The honest limit: an exact-match
    // agent still outranks a merely PREFIX-match command — safe only while
    // non-commands resolve to `elsewhere` instead of executing, which
    // catalogue-actions.test.ts is what actually holds.
    const entries = buildCatalogue({
      customAgents: [{ id: "custom:x", slug: "run", name: "run" }],
    });
    expect(filterCatalogue(entries, "run")[0]?.id).toBe("command:run");
  });
});

describe("matching reads the visible, sanitized name — never the raw id", () => {
  it("a query cannot match identity text the reader was never shown", () => {
    // Pass 11 F8. `filterCatalogue`/`band()` read `entry.id`, so a harness
    // keyed `deploy-prod` but LABELLED "Read-only lint" was returned and
    // ranked for the query `deploy` — on text the reader cannot see, and for
    // a stored source, text that was never sanitized. That contradicted this
    // file's own rule that what you read is what you match.
    const entries = buildCatalogue({
      commands: [],
      harnesses: [harness({ key: "deploy-prod", name: "Read-only lint" })],
    });
    const hits = filterCatalogue(entries, "deploy");
    // Findable by its KEY, which is what a user types and what the entry
    // exposes as `matchKey` — but the key is the sanitized one.
    expect(hits.map((entry) => entry.matchKey)).toEqual(["deploy-prod"]);
    expect(hits[0]?.matchKey).not.toContain("harness:");
  });

  it("the kind PREFIX is no longer accidentally matchable", () => {
    // `entry.id` began with `harness:`/`agent:`, so a bare query of a category
    // name matched every entry of that category through its id rather than
    // through the `kind:` filter that exists for it.
    const entries = buildCatalogue({
      commands: [],
      harnesses: [harness({ key: "audit", name: "Audit" })],
    });
    expect(filterCatalogue(entries, "harness").length).toBe(1); // the keyword, not the id prefix
    expect(
      filterCatalogue(entries, "audit").map((entry) => entry.label)
    ).toEqual(["Audit"]);
  });

  it("a stored key with hostile characters is sanitized before it is matched", () => {
    const entries = buildCatalogue({
      commands: [],
      harnesses: [harness({ key: "au\u202edit", name: "A" })],
    });
    const [entry] = entries;
    expect(residualDanger(entry!.matchKey, [])).toEqual([]);
  });
});
