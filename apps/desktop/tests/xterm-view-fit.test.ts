// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * U1 + U3 — the terminal VIEW's geometry contract, at the seam where it is
 * decided.
 *
 * U1: the pane must fit its container, must fit it on the FIRST frame (not one
 * or two animation frames later), must re-fit when the container changes, and
 * must recover when it was mounted with no box at all — a terminal that
 * measured 0x0 once and gave up is a terminal that never fits.
 *
 * U3: a read-only VIEWER of a console MUON does not own must NOT fit. Those
 * bytes were rendered against a fixed grid and MUON cannot resize that pty, so
 * the only faithful rendering is at the same grid.
 */

const terminals: FakeTerminal[] = [];
const fits: FakeFit[] = [];

class FakeTerminal {
  cols = 80;
  rows = 24;
  resizes: Array<{ cols: number; rows: number }> = [];
  disposed = false;
  written: string[] = [];
  constructor(readonly options: Record<string, unknown>) {
    terminals.push(this);
  }
  loadAddon(): void {}
  open(): void {}
  attachCustomKeyEventHandler(): void {}
  onData() {
    return { dispose: () => undefined };
  }
  onResize() {
    return { dispose: () => undefined };
  }
  write(data: string): void {
    this.written.push(data);
  }
  input(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push({ cols, rows });
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeFit {
  fits = 0;
  proposed: { cols: number; rows: number } | undefined = { cols: 97, rows: 41 };
  constructor() {
    fits.push(this);
  }
  activate(): void {}
  dispose(): void {}
  fit(): void {
    this.fits += 1;
    const terminal = terminals[terminals.length - 1];
    if (terminal && this.proposed) {
      terminal.resize(this.proposed.cols, this.proposed.rows);
    }
  }
  proposeDimensions() {
    return this.proposed;
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

const { createXtermView } = await import("../src/renderer/lib/xterm-view.js");

/** A container that reports a real box (jsdom gives everything 0 otherwise). */
function container(width: number, height: number): HTMLDivElement {
  const element = document.createElement("div");
  let w = width;
  let h = height;
  Object.defineProperty(element, "clientWidth", { get: () => w });
  Object.defineProperty(element, "clientHeight", { get: () => h });
  Object.assign(element, {
    resizeTo: (nextW: number, nextH: number) => {
      w = nextW;
      h = nextH;
    },
  });
  document.body.appendChild(element);
  return element;
}

const lastTerminal = () => terminals[terminals.length - 1]!;
const lastFit = () => fits[fits.length - 1]!;

beforeEach(() => {
  terminals.length = 0;
  fits.length = 0;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("U1 — the interactive pane fits its container", () => {
  it("fits SYNCHRONOUSLY on creation, before any animation frame", () => {
    // This is what lets the open hand a real grid to the pty: a measurement
    // that only lands two rAFs later is not available when the child spawns,
    // so the child's whole first frame is painted at the driver's 80x24.
    const view = createXtermView(container(1200, 700));
    expect(lastFit().fits).toBe(1);
    expect(view.size?.()).toEqual({ cols: 97, rows: 41 });
  });

  it("reports NO size when the container has no box (mounted hidden)", () => {
    const view = createXtermView(container(0, 0));
    expect(lastFit().fits).toBe(0);
    expect(view.size?.()).toBeNull();
  });

  it("recovers a pane that mounted hidden, once it is given a box", async () => {
    const element = container(0, 0);
    const view = createXtermView(element);
    expect(lastFit().fits).toBe(0);

    // The tab is activated: the container now measures.
    (element as unknown as { resizeTo: (w: number, h: number) => void }).resizeTo(
      1200,
      700
    );
    view.refit?.();
    expect(lastFit().fits).toBe(1);
    expect(view.size?.()).toEqual({ cols: 97, rows: 41 });
  });

  it("re-fits on a window resize", () => {
    createXtermView(container(1200, 700));
    expect(lastFit().fits).toBe(1);
    window.dispatchEvent(new Event("resize"));
    expect(lastFit().fits).toBe(2);
  });

  it("stops listening once disposed — no fit against a dead terminal", () => {
    const view = createXtermView(container(1200, 700));
    view.dispose();
    const after = lastFit().fits;
    window.dispatchEvent(new Event("resize"));
    expect(lastFit().fits).toBe(after);
    expect(lastTerminal().disposed).toBe(true);
  });
});

describe("U3 — a viewer of a console MUON does not own never re-wraps it", () => {
  it("pins the COLUMNS to the source grid instead of fitting the pane", () => {
    // A narrow pane. Fitting would give 97 columns and re-wrap every line of a
    // 120-column console; the source width is the only faithful one.
    createXtermView(container(700, 700), {
      readOnly: true,
      convertEol: true,
      fixedGrid: { cols: 120, rows: 32 },
    });
    expect(lastFit().fits).toBe(0); // never fitted
    expect(lastTerminal().resizes.at(-1)?.cols).toBe(120);
  });

  it("uses the source rows as a FLOOR, so tall panes show more, not less", () => {
    createXtermView(container(1200, 900), {
      fixedGrid: { cols: 120, rows: 32 },
    });
    // The pane can show 41 rows; the console's absolute row coordinates all
    // still land, and the spare rows are simply blank.
    expect(lastTerminal().resizes.at(-1)).toEqual({ cols: 120, rows: 41 });
  });

  it("never renders FEWER rows than the source console had", () => {
    lastFitProposal({ cols: 200, rows: 12 });
    createXtermView(container(1200, 200), {
      fixedGrid: { cols: 120, rows: 32 },
    });
    // 12 rows would put row 30 of the source's own frame off the bottom.
    expect(lastTerminal().resizes.at(-1)).toEqual({ cols: 120, rows: 32 });
  });

  it("keeps the source grid when the pane cannot be measured at all", () => {
    createXtermView(container(1200, 700), { fixedGrid: { cols: 120, rows: 32 } });
    const pinned = lastTerminal().resizes.at(-1);
    expect(pinned?.cols).toBe(120);
    expect(pinned!.rows).toBeGreaterThanOrEqual(32);
  });
});

/** Pre-seed what the NEXT FitAddon will propose. */
function lastFitProposal(proposal: { cols: number; rows: number }): void {
  const original = FakeFit.prototype.proposeDimensions;
  FakeFit.prototype.proposeDimensions = function proposeOnce() {
    FakeFit.prototype.proposeDimensions = original;
    return proposal;
  };
}
