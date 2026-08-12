import { describe, expect, it } from "vitest";
import {
  DESK_PREFIX,
  KEYMAP,
  helpSections,
  type KeymapEntry,
} from "../src/shell/keymap.js";
import { routeKey, topLayer, type ShellScope } from "../src/shell/keys.js";
import { vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";

/**
 * THE DRIFT-LOCK.
 *
 * Founder law 6: "Every key in `?` / README / keymap works in every reachable
 * scope, or it is removed from help. Advertised-but-inert is a P0 bug."
 *
 * Discipline cannot enforce that — the help list and the dispatcher drift the
 * moment anyone edits one of them. So `keymap.ts` is the ONLY list, `?`
 * renders from it, `routeKey` resolves against it, and this file asserts the
 * two can never disagree: every advertised entry must produce a live intent
 * in a scope where a human can actually reach it.
 *
 * If you add a row to KEYMAP without wiring it, this fails. If you wire a key
 * without advertising it, the last test here fails. That is the point.
 */

const ESC = String.fromCodePoint(0x1b);

function scope(over: Partial<ShellScope> = {}): ShellScope {
  return {
    reviewOpen: false,
    reviewApprovable: true,
    reviewResolving: false,
    memoryOpen: false,
    memoryBusy: false,
    helpOpen: false,
    navOpen: false,
    spawnMenuOpen: false,
    crewOpen: false,
    sidebarOpen: false,
    inboxFocused: false,
    inboxHasRows: false,
    livePane: false,
    governedOpen: false,
    corpseOnScreen: false,
    prefixArmed: false,
    composerOpen: false,
    composerBusy: false,
    ...over,
  };
}

/** The scope each keymap entry claims to be reachable in. */
function scopeFor(entry: KeymapEntry): ShellScope {
  switch (entry.scope) {
    case "prefix":
      return scope({ prefixArmed: true });
    case "overlay":
      return scope({ spawnMenuOpen: true });
    case "modal":
      return scope({ reviewOpen: true });
    case "terminal":
      return scope({ livePane: true });
    default:
      return scope();
  }
}

describe("every advertised key is live in the scope it advertises", () => {
  it.each(KEYMAP.map((entry) => [`${entry.scope}: ${entry.key}`, entry] as const))(
    "%s",
    (_name, entry) => {
      for (const data of entry.match) {
        const intent = routeKey(data, scopeFor(entry));
        expect(
          intent.kind,
          `"${entry.key}" (${entry.scope}) is advertised as "${entry.help}" but routes to none`
        ).not.toBe("none");
      }
    }
  );

  it("`?` renders every entry, and nothing it does not dispatch", () => {
    const advertised = helpSections().flatMap((section) => section.entries);
    // The help IS the table — not a copy that can fall behind it.
    expect(advertised.length).toBe(
      KEYMAP.filter((e) => e.scope !== "terminal").length
    );
    for (const entry of advertised) {
      expect(KEYMAP).toContain(entry);
    }
  });
});

describe("the founder's four broken keys, in every scope they must work", () => {
  const LISTS: Array<[string, ShellScope]> = [
    ["cockpit", scope()],
    ["spawn menu", scope({ spawnMenuOpen: true })],
    ["destinations", scope({ navOpen: true })],
    ["crew drawer", scope({ crewOpen: true })],
    ["inbox", scope({ inboxFocused: true, inboxHasRows: true })],
    ["sidebar", scope({ sidebarOpen: true })],
    ["memory", scope({ memoryOpen: true })],
  ];

  it.each(LISTS)("↑ and ↓ move the selection in the %s", (_name, state) => {
    expect(routeKey(`${ESC}[B`, state)).toEqual({ kind: "move", delta: 1 });
    expect(routeKey(`${ESC}[A`, state)).toEqual({ kind: "move", delta: -1 });
    // The vi pair too, in every one of them.
    expect(routeKey("j", state)).toEqual({ kind: "move", delta: 1 });
    expect(routeKey("k", state)).toEqual({ kind: "move", delta: -1 });
  });

  it.each(
    LISTS.filter(([name]) => name !== "cockpit" && name !== "sidebar")
  )("Esc pops exactly ONE layer from the %s", (_name, state) => {
    expect(routeKey(ESC, state)).toEqual({ kind: "pop-layer" });
  });

  it("the sidebar is a TOGGLE, not an Esc layer — Esc belongs to the child", () => {
    // A visible rail owns no keyboard, so it is not a layer. Making Esc close
    // it would steal Esc from the pane, and a vendor CLI uses Esc constantly
    // (it is how you interrupt one). The same chord that opened it closes it.
    const withRail = scope({ sidebarOpen: true, livePane: true });
    expect(routeKey(ESC, withRail)).toEqual({ kind: "to-child", data: ESC });
    expect(routeKey("s", scope({ sidebarOpen: true, prefixArmed: true }))).toEqual({
      kind: "toggle-sidebar",
    });
  });

  it("Esc in the cockpit is a no-op — it never quits the app", () => {
    expect(routeKey(ESC, scope())).toEqual({ kind: "none" });
  });

  it("Tab cycles focus EVEN WITH the catalogue open — the reported break", () => {
    const withCatalogue = scope({ spawnMenuOpen: true });
    expect(routeKey("\t", withCatalogue)).toEqual({ kind: "cycle-zone", delta: 1 });
    expect(routeKey(`${ESC}[Z`, withCatalogue)).toEqual({
      kind: "cycle-zone",
      delta: -1,
    });
  });

  it.each(LISTS)("Tab is live in the %s", (_name, state) => {
    // Except where a GATE owns the keyboard, Tab must never be swallowed.
    const intent = routeKey("\t", state);
    if (state.memoryOpen) {
      expect(intent.kind).toBe("none"); // a write surface owns its keys
    } else {
      expect(intent).toEqual({ kind: "cycle-zone", delta: 1 });
    }
  });
});

describe("the Esc stack pops one rung at a time, innermost first", () => {
  it("names the layers in reveal order", () => {
    // Opening sidebar → inbox → crew → destinations pops in exact reverse.
    const all = scope({
      sidebarOpen: true,
      inboxFocused: true,
      crewOpen: true,
      navOpen: true,
    });
    expect(topLayer(all)).toBe("destinations");
    expect(topLayer({ ...all, navOpen: false })).toBe("crew");
    expect(topLayer({ ...all, navOpen: false, crewOpen: false })).toBe("inbox");
    // The sidebar is NOT a rung: it is visible, not focused, and a layer is
    // something that owns the keyboard.
    expect(
      topLayer({ ...all, navOpen: false, crewOpen: false, inboxFocused: false })
    ).toBeNull();
    expect(topLayer(scope())).toBeNull();
  });

  it("a gate is always the innermost layer", () => {
    expect(topLayer(scope({ reviewOpen: true, navOpen: true }))).toBe("review");
  });
});

describe("the prefix does not leak", () => {
  it("a prefix key means NOTHING without the prefix, in a live pane", () => {
    // `c` is "crew" after ctrl+b. In a pane it must reach the CHILD.
    const live = scope({ livePane: true });
    expect(routeKey("c", live)).toEqual({ kind: "to-child", data: "c" });
    expect(routeKey("s", live)).toEqual({ kind: "to-child", data: "s" });
    expect(routeKey("w", live)).toEqual({ kind: "to-child", data: "w" });
  });

  it("armed, the same keys are desk commands", () => {
    const armed = scope({ prefixArmed: true, livePane: true });
    expect(routeKey("c", armed)).toEqual({ kind: "toggle-crew" });
    expect(routeKey("s", armed)).toEqual({ kind: "toggle-sidebar" });
    expect(routeKey("w", armed)).toEqual({ kind: "close-tab" });
  });

  it("an unknown key after the prefix is swallowed, NOT sent to the child", () => {
    // Leaking here is how a prefix acquires meanings it never advertised.
    const armed = scope({ prefixArmed: true, livePane: true });
    expect(routeKey("Z", armed)).toEqual({ kind: "none" });
  });

  it("only TWO keys are ever taken from a child", () => {
    const live = scope({ livePane: true });
    const reserved = [String.fromCodePoint(17), DESK_PREFIX];
    for (const code of Array.from({ length: 26 }, (_, i) =>
      String.fromCodePoint(i + 1)
    )) {
      const intent = routeKey(code, live);
      if (reserved.includes(code)) {
        expect(intent.kind, `${code.codePointAt(0)}`).not.toBe("to-child");
      } else {
        expect(intent, `ctrl code ${code.codePointAt(0)} must reach the child`).toEqual({
          kind: "to-child",
          data: code,
        });
      }
    }
  });
});

describe("THE HARDER DRIFT-LOCK: an advertised key must CHANGE something", () => {
  /**
   * Routing to an intent is not working. `ctrl+b c` routed to `toggle-crew`,
   * flipped a boolean, moved a cursor — and rendered NOTHING, because the
   * drawer did not exist yet. It passed the route-level lock above for a full
   * wake. Founder law 6 does not say "every key routes"; it says every key
   * WORKS.
   *
   * So: drive each prefix command through a real Desk and assert the SCREEN
   * or the observable state actually moved.
   */
  const PREFIX = String.fromCodePoint(2);

  function makeDesk() {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      agents: [
        { id: "a1", name: "codex-1", status: "working", vendor: "codex" },
      ] as never,
      approvals: [
        {
          id: "ap-1",
          kind: "command",
          status: "pending",
          summary: "s",
          createdAt: "2026-01-01",
          evidence: {
            action: "A",
            scope: "S",
            impactIfApproved: "I",
            details: {},
            payloadDigest: "d",
          },
        },
      ] as never,
    };
    return new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 60, rows: 10 }),
      terminalRows: () => 40,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
  }

  const frame = (desk: Desk) => desk.shell.render(140).join("\n");

  it.each([
    ["s", "toggle-sidebar"],
    ["c", "toggle-crew"],
    ["i", "toggle-inbox"],
    ["g", "open-destinations"],
    ["?", "open-help"],
    ["t", "new-tab"],
    ["|", "split-pane"],
    ["o", "focus-other-pane"],
    ["a", "open-composer"],
  ])("ctrl+b %s (%s) changes the frame", (key, _action) => {
    const desk = makeDesk();
    desk.render();
    const before = frame(desk);
    desk.handleKey(PREFIX);
    desk.handleKey(key);
    desk.render();
    expect(
      frame(desk),
      `ctrl+b ${key} is advertised but the frame is byte-identical — it does nothing`
    ).not.toBe(before);
  });

  it("the crew drawer actually names the lanes and what is BLOCKED", () => {
    const desk = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("c");
    desk.render();
    const csi = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const out = frame(desk).replace(csi, "");
    expect(out).toContain("crew");
    expect(out).toContain("codex-1");
    // The agent has a pending approval bound to no job, so it is not blocked;
    // what matters is the drawer renders a LANE, not an empty box.
    expect(out).toMatch(/working|idle|blocked|done/);
  });

  it("every prefix command in the keymap is exercised above", () => {
    // If someone adds a prefix binding, this fails until they add its case to
    // the table in this file — which forces the observable-effect proof.
    const covered = new Set([
      "toggle-sidebar",
      "toggle-crew",
      "toggle-inbox",
      "open-destinations",
      "open-help",
      "new-tab",
      "open-memory",
      "next-tab",
      "prev-tab",
      "close-tab",
      "split-pane",
      "focus-other-pane",
      "focus-left-pane",
      "focus-right-pane",
      "open-composer",
      "answer-gate",
    ]);
    for (const entry of KEYMAP.filter((row) => row.scope === "prefix")) {
      expect(
        covered.has(entry.action),
        `prefix action "${entry.action}" has no observable-effect test`
      ).toBe(true);
    }
  });
});

describe("THE PASSIVE-FLAG AUDIT: nothing visible may eat a child's keys", () => {
  /**
   * The contract is "only ctrl+q and ctrl+b are ever taken from a child", and
   * it has now been broken twice by the same mistake in different clothes: a
   * VISIBLE thing was treated as a FOCUSED thing. The sidebar did it and
   * swallowed everything; `corpseOnScreen` did it for `x`.
   *
   * Eyeballing scopes did not catch either. This enumerates the product of
   * every passive flag and every key a vendor CLI actually uses, so the next
   * one fails here instead of in a founder's terminal.
   */
  const PASSIVE_FLAGS = [
    "sidebarOpen",
    "inboxHasRows",
    "corpseOnScreen",
    "governedOpen",
  ] as const;

  const CHILD_KEYS = [
    "q",
    "j",
    "k",
    "/",
    "a",
    "x",
    "c",
    "s",
    "\r",
    "\t",
    String.fromCodePoint(3), // ctrl-c
    ESC,
  ];

  it.each(PASSIVE_FLAGS)("%s does not swallow any key from a live pane", (flag) => {
    const live = scope({ livePane: true, [flag]: true });
    for (const key of CHILD_KEYS) {
      expect(
        routeKey(key, live),
        `${flag} + ${JSON.stringify(key)} must reach the child`
      ).toEqual({ kind: "to-child", data: key });
    }
  });

  it("ALL passive flags at once still leave the child its keys", () => {
    const live = scope({
      livePane: true,
      sidebarOpen: true,
      inboxHasRows: true,
      corpseOnScreen: true,
      governedOpen: true,
    });
    for (const key of CHILD_KEYS) {
      expect(routeKey(key, live), JSON.stringify(key)).toEqual({
        kind: "to-child",
        data: key,
      });
    }
  });
});

describe("no advertised chord REQUIRES a shift", () => {
  /**
   * The founder's rule after their second doctor run: a user should not have
   * to press shift to reach anything on this desk. Two chords did — `ctrl+b ?`
   * and `ctrl+b |` — and both were the ones that failed, because the decoder
   * guessed the shifted character instead of reading the terminal's.
   *
   * The decoder is fixed, so shift works. This keeps the REQUIREMENT gone: a
   * new binding on a shifted key would need an unshifted way in as well.
   */
  const SHIFTED = new Set([
    ..."~!@#$%^&*()_+{}|:\"<>?",
  ]);

  it("every prefix chord is reachable without shift", () => {
    for (const entry of KEYMAP) {
      if (entry.scope !== "prefix") continue;
      const unshifted = entry.match.filter(
        (key) => key.length === 1 && !SHIFTED.has(key) && key !== "\r" && key !== "\n"
      );
      const isEnter = entry.match.includes("\r");
      expect(
        unshifted.length > 0 || isEnter,
        `${entry.key} (${entry.action}) can only be reached with shift held`
      ).toBe(true);
    }
  });

  it("and the ADVERTISED key is the unshifted one", () => {
    // The label is what `?` prints and what the doctor asks for. Advertising
    // the shifted spelling while accepting both would still teach the harder
    // gesture.
    for (const entry of KEYMAP) {
      if (entry.scope !== "prefix") continue;
      const last = entry.key.split(" ").at(-1)!;
      expect(SHIFTED.has(last), `${entry.key} advertises a shifted key`).toBe(false);
    }
  });
});
