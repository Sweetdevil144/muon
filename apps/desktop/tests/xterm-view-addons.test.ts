// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ROADMAP T4 — the desktop xterm upgrade beyond FitAddon-only: search,
 * unicode11, clipboard, and serialize are loaded on EVERY view (including
 * read-only job consoles), and OSC-8 link activation goes through the
 * allowlist with a ⌘/Ctrl-click gate. Each addon class is faked (same
 * pattern as `xterm-view-fit.test.ts`) so this asserts WIRING — which addons
 * get loaded, with what options, and how the link handler and serialize
 * method behave — without a real canvas/DOM terminal.
 */

type LoadedAddon = { kind: string; instance: unknown };

let loadedAddons: LoadedAddon[] = [];
let lastLinkHandler: { activate: (event: unknown, text: string) => void } | undefined;
let lastTerminal: FakeTerminal | undefined;

function rememberTerminal(instance: FakeTerminal): void {
  lastTerminal = instance;
}

class FakeTerminal {
  cols = 80;
  rows = 24;
  unicode: { activeVersion: string } = { activeVersion: "6" };
  constructor(options: Record<string, unknown>) {
    lastLinkHandler = options.linkHandler as typeof lastLinkHandler;
    rememberTerminal(this);
  }
  loadAddon(addon: unknown): void {
    const kind = (addon as { constructor: { name: string } }).constructor.name;
    loadedAddons.push({ kind, instance: addon });
  }
  open(): void {}
  attachCustomKeyEventHandler(): void {}
  onData() {
    return { dispose: () => undefined };
  }
  onResize() {
    return { dispose: () => undefined };
  }
  write(): void {}
  input(): void {}
  resize(): void {}
  dispose(): void {}
}

class FakeFit {
  activate(): void {}
  dispose(): void {}
  fit(): void {}
  proposeDimensions() {
    return undefined;
  }
}

let lastSearchAddon: FakeSearch | undefined;
function rememberSearchAddon(instance: FakeSearch): void {
  lastSearchAddon = instance;
}
class FakeSearch {
  findNextCalls: Array<[string, unknown]> = [];
  findPreviousCalls: Array<[string, unknown]> = [];
  cleared = 0;
  constructor() {
    rememberSearchAddon(this);
  }
  findNext(term: string, options?: unknown): boolean {
    this.findNextCalls.push([term, options]);
    return true;
  }
  findPrevious(term: string, options?: unknown): boolean {
    this.findPreviousCalls.push([term, options]);
    return false;
  }
  clearDecorations(): void {
    this.cleared += 1;
  }
}

class FakeUnicode11 {}
class FakeClipboard {}

let lastSerializeAddon: FakeSerialize | undefined;
function rememberSerializeAddon(instance: FakeSerialize): void {
  lastSerializeAddon = instance;
}
class FakeSerialize {
  toReturn = "SERIALIZED-BUFFER";
  constructor() {
    rememberSerializeAddon(this);
  }
  serialize(): string {
    return this.toReturn;
  }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      return new FakeTerminal(options) as unknown as object;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    constructor() {
      return new FakeFit() as unknown as object;
    }
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    constructor() {
      return new FakeSearch() as unknown as object;
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    constructor() {
      return new FakeUnicode11() as unknown as object;
    }
  },
}));
vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class {
    constructor() {
      return new FakeClipboard() as unknown as object;
    }
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    constructor() {
      return new FakeSerialize() as unknown as object;
    }
  },
}));

const { createXtermView } = await import("../src/renderer/lib/xterm-view.js");

function container(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { get: () => 1200 });
  Object.defineProperty(element, "clientHeight", { get: () => 700 });
  document.body.appendChild(element);
  return element;
}

beforeEach(() => {
  loadedAddons = [];
  lastLinkHandler = undefined;
  lastTerminal = undefined;
  lastSearchAddon = undefined;
  lastSerializeAddon = undefined;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("createXtermView — ROADMAP T4 addon wiring", () => {
  it("loads fit, search, unicode11, clipboard, and serialize on every view", () => {
    createXtermView(container());
    const kinds = loadedAddons.map((a) => a.kind);
    expect(kinds).toContain("FakeFit");
    expect(kinds).toContain("FakeSearch");
    expect(kinds).toContain("FakeUnicode11");
    expect(kinds).toContain("FakeClipboard");
    expect(kinds).toContain("FakeSerialize");
  });

  it("loads every addon on a READ-ONLY (job console) view too", () => {
    createXtermView(container(), { readOnly: true });
    const kinds = loadedAddons.map((a) => a.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "FakeFit",
        "FakeSearch",
        "FakeUnicode11",
        "FakeClipboard",
        "FakeSerialize",
      ])
    );
  });

  it("activates unicode version 11", () => {
    createXtermView(container());
    expect(lastTerminal?.unicode.activeVersion).toBe("11");
  });

  it("serialize() returns the SerializeAddon's buffer", () => {
    const view = createXtermView(container());
    expect(view.serialize?.()).toBe("SERIALIZED-BUFFER");
  });

  it("serialize() fails safe (empty string) if the addon throws", () => {
    const view = createXtermView(container());
    lastSerializeAddon!.serialize = () => {
      throw new Error("disposed");
    };
    expect(view.serialize?.()).toBe("");
  });

  it("exposes search.findNext / findPrevious / clear wired to the addon", () => {
    const view = createXtermView(container());
    expect(view.search.findNext("needle", { caseSensitive: true })).toBe(true);
    expect(lastSearchAddon!.findNextCalls).toContainEqual([
      "needle",
      { caseSensitive: true },
    ]);
    expect(view.search.findPrevious("needle")).toBe(false);
    expect(lastSearchAddon!.findPreviousCalls).toContainEqual(["needle", undefined]);
    view.search.clear();
    expect(lastSearchAddon!.cleared).toBe(1);
  });

  describe("OSC-8 link handler", () => {
    it("ignores a plain click (no modifier) on any link", () => {
      const onOpenLink = vi.fn();
      createXtermView(container(), {
        workspaceRoot: "/ws",
        onOpenLink,
      });
      lastLinkHandler!.activate(
        { metaKey: false, ctrlKey: false },
        "https://example.com"
      );
      expect(onOpenLink).not.toHaveBeenCalled();
    });

    it("opens an allowlisted http(s) link on ⌘-click", () => {
      const onOpenLink = vi.fn();
      createXtermView(container(), { onOpenLink });
      lastLinkHandler!.activate(
        { metaKey: true, ctrlKey: false },
        "https://example.com/docs"
      );
      expect(onOpenLink).toHaveBeenCalledWith({
        kind: "url",
        url: "https://example.com/docs",
      });
    });

    it("opens an in-workspace path on Ctrl-click when a workspaceRoot is set", () => {
      const onOpenLink = vi.fn();
      createXtermView(container(), {
        workspaceRoot: "/Users/founder/ws",
        onOpenLink,
      });
      lastLinkHandler!.activate(
        { metaKey: false, ctrlKey: true },
        "src/index.ts"
      );
      expect(onOpenLink).toHaveBeenCalledWith({
        kind: "path",
        absolutePath: "/Users/founder/ws/src/index.ts",
      });
    });

    it("denies a path-shaped link when no workspaceRoot is bound", () => {
      const onOpenLink = vi.fn();
      createXtermView(container(), { onOpenLink }); // no workspaceRoot
      lastLinkHandler!.activate({ metaKey: true, ctrlKey: false }, "src/index.ts");
      expect(onOpenLink).not.toHaveBeenCalled();
    });

    it("denies a disallowed scheme (javascript:) even on ⌘-click", () => {
      const onOpenLink = vi.fn();
      createXtermView(container(), { workspaceRoot: "/ws", onOpenLink });
      lastLinkHandler!.activate(
        { metaKey: true, ctrlKey: false },
        "javascript:alert(1)"
      );
      expect(onOpenLink).not.toHaveBeenCalled();
    });

    it("denies a path that escapes the workspace root", () => {
      const onOpenLink = vi.fn();
      createXtermView(container(), {
        workspaceRoot: "/Users/founder/ws",
        onOpenLink,
      });
      lastLinkHandler!.activate(
        { metaKey: true, ctrlKey: false },
        "../../etc/passwd"
      );
      expect(onOpenLink).not.toHaveBeenCalled();
    });
  });
});
