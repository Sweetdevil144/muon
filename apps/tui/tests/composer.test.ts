import { describe, expect, it, vi } from "vitest";
import { evasionPayloads, residualDanger } from "@muon/client";
import type { MuonApiClient } from "@muon/client";
import { Desk } from "../src/shell/desk.js";
import { buildActionForm, EXECUTABLE_ACTIONS } from "../src/lib/actions.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";
import { routeKey, type ShellScope } from "../src/shell/keys.js";

/**
 * THE COMPOSER — the desk's way to create work.
 *
 * Before this, the shell desk could watch agents, answer their gates and read
 * memory, but had no way to tell MUON to do anything. These defend the two
 * things that make it trustworthy: it goes through the SHARED governed path
 * (not a second dialect), and it never lies about what happened.
 */

const PREFIX = String.fromCodePoint(2);
const ESC = String.fromCodePoint(0x1b);

function plain(lines: string[]): string {
  const csi = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

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

function makeDesk(createTask = vi.fn(async () => ({ id: "task-7" }))) {
  const snapshot: BrainSnapshot = { ...emptyBrainSnapshot() };
  const refresh = vi.fn(async () => {});
  const desk = new Desk({
    client: { createTask } as unknown as MuonApiClient,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 40, rows: 8 }),
    terminalRows: () => 40,
    cwd: () => "/repo",
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
    refresh,
  });
  return { desk, createTask, refresh };
}

function type(desk: Desk, text: string): void {
  for (const char of text) desk.handleKey(char);
}

describe("the composer creates real work through the SHARED path", () => {
  it("ctrl+b a opens it, and it names what it will do", () => {
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    desk.handleKey("\r"); // choose "task-new", the first offer
    expect(desk.centreKind()).toBe("composer");
    const out = plain(desk.shell.render(120));
    expect(out).toContain("Create task");
    // The consequence is stated before the human commits to it.
    expect(out).toContain("creates real work in the brain");
  });

  it("submits through executeAction — the classic desk's governed call", async () => {
    const { desk, createTask, refresh } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    desk.handleKey("\r"); // choose "task-new", the first offer
    type(desk, "ship the composer");
    desk.handleKey(`${ESC}[B`);
    type(desk, "wire the shell desk to createTask");
    desk.handleKey("\r");
    await vi.waitFor(() => expect(createTask).toHaveBeenCalled());
    const payload = createTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.title).toBe("ship the composer");
    expect(payload.description).toBe("wire the shell desk to createTask");
    // A create must re-read the brain, or the new task is invisible until the
    // next poll.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("a FAILED submit stays on screen — a cleared form would read as success", async () => {
    const failing = vi.fn(async () => {
      throw new Error("409 duplicate title");
    });
    const { desk } = makeDesk(failing as never);
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    desk.handleKey("\r"); // choose "task-new", the first offer
    type(desk, "t");
    desk.handleKey(`${ESC}[B`);
    type(desk, "d");
    desk.handleKey("\r");
    await vi.waitFor(() =>
      expect(desk.composerState()?.result?.ok).toBe(false)
    );
    expect(plain(desk.shell.render(120))).toContain("409 duplicate title");
    // And it is STILL open, with the typed values intact.
    expect(desk.centreKind()).toBe("composer");
    expect(desk.composerState()?.values.title).toBe("t");
  });

  it("validation refuses an empty required field WITHOUT calling the brain", async () => {
    const { desk, createTask } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    desk.handleKey("\r"); // choose "task-new", the first offer
    desk.handleKey("\r");
    await vi.waitFor(() => expect(desk.composerState()?.result).not.toBeNull());
    expect(createTask).not.toHaveBeenCalled();
    expect(desk.composerState()?.result?.ok).toBe(false);
  });
});

describe("the composer is a TEXT surface", () => {
  it("plain letters type — they are not desk commands", () => {
    // A human typing a title must be able to write "q", "j" and "/" without
    // quitting, moving a list, or opening a menu.
    const open = scope({ composerOpen: true });
    for (const char of ["q", "j", "k", "/", "t", "c", "s"]) {
      expect(routeKey(char, open)).toEqual({ kind: "composer-type", data: char });
    }
  });

  it("only Esc, Enter and the arrows belong to the desk", () => {
    const open = scope({ composerOpen: true });
    expect(routeKey(ESC, open)).toEqual({ kind: "pop-layer" });
    expect(routeKey("\r", open)).toEqual({ kind: "activate" });
    expect(routeKey(`${ESC}[B`, open)).toEqual({ kind: "move", delta: 1 });
    expect(routeKey(`${ESC}[A`, open)).toEqual({ kind: "move", delta: -1 });
  });

  it("ctrl+q still quits from inside a text field", () => {
    expect(routeKey(String.fromCodePoint(17), scope({ composerOpen: true }))).toEqual({
      kind: "quit",
    });
  });

  it("a submit in flight cannot be re-sent", () => {
    const busy = scope({ composerOpen: true, composerBusy: true });
    expect(routeKey("\r", busy)).toEqual({ kind: "none" });
    // esc still escapes — a human is never trapped.
    expect(routeKey(ESC, busy)).toEqual({ kind: "pop-layer" });
  });

  it("backspace deletes, and control bytes never enter a field", () => {
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    desk.handleKey("\r"); // choose "task-new", the first offer
    type(desk, "abc");
    desk.handleKey(String.fromCodePoint(0x7f));
    expect(desk.composerState()?.values.title).toBe("ab");
    // A raw escape byte is not text: it is how a sequence becomes a payload.
    desk.handleKey(String.fromCodePoint(0x1b));
    expect(desk.composerState()).toBeNull();
  });

  it("control bytes are FILTERED at the field, not merely routed away", async () => {
    // Routing sends Esc elsewhere, so the router hides this. The filter must
    // be tested where it lives: a paste or a mouse report arrives as one
    // chunk mixing printable text with control bytes, and only the printable
    // half may become a task title.
    const { composerType, openComposer } = await import("../src/shell/composer.js");
    const { buildActionForm } = await import("../src/lib/actions.js");
    const form = buildActionForm("task-new", {})!;
    const state = openComposer(form);
    const esc = String.fromCodePoint(0x1b);
    const bel = String.fromCodePoint(7);
    const typed = composerType(state, `ok${esc}[31m${bel}text`);
    // SGR TOO, not just the introducer. A title is not a screen: pasting
    // coloured text used to leave `[31mRED[0m` in the field and send it to
    // the brain, because the screen sanitizer deliberately preserves SGR.
    expect(typed.values.title, "no escapes, no SGR, no BEL").toBe("oktext");
    expect(typed.values.title).not.toContain(esc);
    expect(typed.values.title).not.toContain(bel);
    expect(typed.values.title).not.toContain("31m");
  });

  it("esc pops the composer FIRST — it is the innermost layer", () => {
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("s");
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    desk.handleKey("\r"); // choose "task-new", the first offer
    desk.handleKey(ESC);
    expect(desk.centreKind()).not.toBe("composer");
    // The sidebar it was opened over survives.
    expect(desk.revealed().sidebar).toBe(true);
  });

  it("replays the corpus through typed values", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const { desk } = makeDesk();
      desk.handleKey(PREFIX);
      desk.handleKey("a");
      type(desk, payload.text);
      const out = plain(desk.shell.render(120));
      expect(residualDanger(out, ["\n"]), payload.id).toEqual([]);
    }
  });
});

describe("escape sequences never become task text", () => {
  it("an arrow key does not type `[D` into the title", async () => {
    // `code >= 0x20` drops the ESC and KEEPS the parameters, so a left arrow
    // typed `[D` and a paste typed `[200~…[201~` — and submitComposer sent
    // that to the brain.
    const { composerType, openComposer } = await import("../src/shell/composer.js");
    const { buildActionForm } = await import("../src/lib/actions.js");
    const esc = String.fromCodePoint(0x1b);
    let state = openComposer(buildActionForm("task-new", {})!);
    state = composerType(state, "Fix");
    state = composerType(state, `${esc}[D`);
    state = composerType(state, `${esc}[200~pasted${esc}[201~`);
    expect(state.values.title).toBe("Fixpasted");
    expect(state.values.title).not.toContain("[D");
    expect(state.values.title).not.toContain("200~");
  });
});

describe("the composer OFFERS what it can run, and only that", () => {
  it("opens on the CHOICE, not on one hard-coded command", async () => {
    // `ctrl+b a` used to go straight to `task-new`, so the desk could create a
    // task and nothing else — while `executeAction` already knew how to run,
    // assign and set a status. Those were reachable from the classic desk and
    // from nowhere on this one.
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    expect(desk.centreKind()).toBe("composer");
    const frame = plain(desk.shell.render(120));
    for (const command of EXECUTABLE_ACTIONS) {
      expect(frame, command).toContain(command);
    }
  });

  it("offers ONLY commands that actually execute", async () => {
    // `buildActionForm` can build a dozen forms; `executeAction` implements
    // four. Offering the rest would take a human's input and then answer
    // "cannot be run from here" — advertised-but-inert, with a wasted
    // keystroke on top.
    const { executeAction } = await import("../src/lib/actions.js");
    for (const command of EXECUTABLE_ACTIONS) {
      const form = buildActionForm(command, {});
      expect(form, command).not.toBeNull();
      // A command on the list must not be refused by the executor's default
      // arm. An empty submit fails VALIDATION, which is a different message.
      const result = await executeAction(
        {} as never,
        form!,
        Object.fromEntries(form!.fields.map((field) => [field.id, ""]))
      );
      expect(result.message, command).not.toContain("cannot be run from here");
    }
  });

  it("choosing swaps the picker for that command's form", () => {
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    // Walk to `run` and choose it.
    const index = EXECUTABLE_ACTIONS.indexOf("run");
    for (let step = 0; step < index; step += 1) desk.handleKey(`${ESC}[B`);
    desk.handleKey("\r");
    const frame = plain(desk.shell.render(120));
    expect(frame).toContain("Run task on lane");
    expect(frame).toContain("Lane key");
  });

  it("the picker cursor cannot run past the last command", () => {
    // The cursor means a CHOICE while picking and a FIELD once picked, so it
    // is clamped against whichever list is live. Clamped against the form's
    // fields it would have sat past the last command on any shorter form.
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    for (let step = 0; step < 20; step += 1) desk.handleKey(`${ESC}[B`);
    desk.handleKey("\r");
    // Whatever it landed on, it is a REAL form, not an empty centre.
    expect(desk.centreKind()).toBe("composer");
    expect(desk.composerState()?.phase).toBe("editing");
  });

  it("Esc closes the picker without choosing anything", () => {
    const { desk } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    desk.handleKey(ESC);
    expect(desk.centreKind()).not.toBe("composer");
  });
});

describe("the registry is the ONE definition of an action", () => {
  it("every offered command has a form AND a runner, structurally", async () => {
    // There used to be three lists — a form switch, an executor switch, and a
    // hand-written name list — and the picker's "this command has no form"
    // branch was REACHABLE, which is proof nothing enforced the alignment.
    const { ACTION_REGISTRY } = await import("../src/lib/actions.js");
    for (const id of EXECUTABLE_ACTIONS) {
      const entry = ACTION_REGISTRY[id];
      expect(typeof entry.form, id).toBe("function");
      expect(typeof entry.run, id).toBe("function");
      expect(entry.label, id).toContain(id);
    }
  });

  it("buildActionForm returns the REGISTRY's form, not a second copy", async () => {
    const { ACTION_REGISTRY } = await import("../src/lib/actions.js");
    for (const id of EXECUTABLE_ACTIONS) {
      expect(buildActionForm(id, {}), id).toEqual(
        ACTION_REGISTRY[id].form({})
      );
    }
  });

  it("a form the desk can BUILD but not run is refused by name", async () => {
    // `memory-search` has a form and no executor. Refusing it by name is the
    // honest outcome; rendering it and failing after a human typed is not.
    const { executeAction } = await import("../src/lib/actions.js");
    const form = buildActionForm("memory-search", {});
    expect(form).not.toBeNull();
    const result = await executeAction({} as never, form!, { query: "x" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("cannot be run from here");
    for (const id of EXECUTABLE_ACTIONS) {
      expect(result.message, "and names what it CAN run").toContain(id);
    }
  });
});
