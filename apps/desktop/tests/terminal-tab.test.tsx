// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { TerminalTab } from "../src/renderer/terminal-tab.js";
import type {
  TerminalClientFrame,
  TerminalClientPort,
  TerminalHostFrame,
} from "../src/shared/terminal-protocol.js";
import type { TerminalView } from "../src/renderer/lib/terminal-wire.js";
import { ParkedTerminalStore } from "../src/renderer/lib/parked-terminal-store.js";

function fakePort() {
  let listener: ((f: TerminalHostFrame) => void) | undefined;
  const posted: TerminalClientFrame[] = [];
  let closed = false;
  const port: TerminalClientPort = {
    post: (f) => posted.push(f),
    onFrame: (l) => (listener = l),
    close: () => (closed = true),
  };
  return {
    port,
    posted,
    emit: (f: TerminalHostFrame) => listener?.(f),
    isClosed: () => closed,
  };
}

/**
 * `measured` is what the view reports for `size()`: a grid when the pane has a
 * real box, `null` when it is hidden/unlaid-out, and `undefined` for a view
 * that predates the optional method at all (every older fake).
 */
function fakeView(measured?: { cols: number; rows: number } | null) {
  const writes: string[] = [];
  let inputCb: ((d: string) => void) | undefined;
  let exited: { exitCode: number; signal?: number } | undefined;
  let disposed = false;
  let refits = 0;
  const view: TerminalView = {
    write: (d) => writes.push(d),
    onInput: (l) => {
      inputCb = l;
      return { dispose: () => (inputCb = undefined) };
    },
    onResize: () => ({ dispose: () => undefined }),
    markExited: (e) => (exited = e),
    dispose: () => (disposed = true),
    refit: () => {
      refits += 1;
    },
    ...(measured !== undefined ? { size: () => measured } : {}),
  };
  return {
    view,
    writes,
    typeInput: (d: string) => inputCb?.(d),
    exited: () => exited,
    isDisposed: () => disposed,
    refits: () => refits,
  };
}

/**
 * A fake view that also implements `serialize()` — the ROADMAP T4 replay
 * source a park captures. Returned as a factory (not the shared `fakeView`
 * singleton pattern above) so a park/resume test can tell the ORIGINAL
 * instance apart from the one `resume()` recreates.
 */
function fakeSerializableView(snapshot: string) {
  const base = fakeView({ cols: 80, rows: 24 });
  const view: TerminalView = { ...base.view, serialize: () => snapshot };
  return { ...base, view };
}

const spawn = { file: "claude", cwd: "/ws" };

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("TerminalTab (Wave 4 slice 5.0.3)", () => {
  afterEach(() => cleanup());

  it("opens the session, streams host bytes into the view + acks, and sends input back", async () => {
    const p = fakePort();
    const v = fakeView();
    const openPort = vi.fn(async () => p.port);
    const createView = vi.fn(() => v.view);

    render(
      React.createElement(TerminalTab, {
        sessionId: "s1",
        spawn,
        openPort,
        createView,
      })
    );

    await waitFor(() => expect(openPort).toHaveBeenCalledWith("s1", spawn));
    await flush();
    expect(createView).toHaveBeenCalledTimes(1);

    act(() => p.emit({ type: "data", seq: 1, data: "boot\n" }));
    expect(v.writes).toEqual(["boot\n"]);
    expect(p.posted).toContainEqual({ type: "ack", seq: 1 }); // backpressure

    act(() => v.typeInput("ls\r"));
    expect(p.posted).toContainEqual({ type: "write", data: "ls\r" });

    act(() => p.emit({ type: "exit", exitCode: 0 }));
    expect(v.exited()).toEqual({ exitCode: 0 });
  });

  it("surfaces exit to the onExit callback", async () => {
    const p = fakePort();
    const v = fakeView();
    const onExit = vi.fn();
    render(
      React.createElement(TerminalTab, {
        sessionId: "s1",
        spawn,
        openPort: async () => p.port,
        createView: () => v.view,
        onExit,
      })
    );
    await flush();
    act(() => p.emit({ type: "exit", exitCode: 137, signal: 9 }));
    expect(onExit).toHaveBeenCalledWith({ exitCode: 137, signal: 9 });
  });

  it("reports output and input as activity events (ROADMAP T2)", async () => {
    const p = fakePort();
    const v = fakeView();
    const onActivity = vi.fn();
    render(
      React.createElement(TerminalTab, {
        sessionId: "s1",
        spawn,
        openPort: async () => p.port,
        createView: () => v.view,
        onActivity,
      })
    );
    await flush();

    act(() => p.emit({ type: "data", seq: 1, data: "boot\n" }));
    expect(onActivity).toHaveBeenCalledWith({ kind: "output", data: "boot\n" });

    act(() => v.typeInput("ls\r"));
    expect(onActivity).toHaveBeenCalledWith({ kind: "input", data: "ls\r" });
  });

  it("disposes on unmount WITHOUT sending a close frame (a reload leaves the session alive)", async () => {
    const p = fakePort();
    const v = fakeView();
    const { unmount } = render(
      React.createElement(TerminalTab, {
        sessionId: "s1",
        spawn,
        openPort: async () => p.port,
        createView: () => v.view,
      })
    );
    await flush();
    unmount();
    expect(p.posted).not.toContainEqual({ type: "close" }); // no KILL frame
    expect(p.isClosed()).toBe(true); // but the PORT closes → host detaches, session lives
    expect(v.isDisposed()).toBe(true); // view torn down (no XTerm/observer leak)
    // Input after unmount is ignored (wire disposed), never crashes.
    expect(() => v.typeInput("late")).not.toThrow();
  });

  it("re-opens the channel on remount (reconnect)", async () => {
    const openPort = vi.fn(async () => fakePort().port);
    const v = fakeView();
    const props = {
      sessionId: "s1",
      spawn,
      openPort,
      createView: () => v.view,
    };
    const first = render(React.createElement(TerminalTab, props));
    await waitFor(() => expect(openPort).toHaveBeenCalledTimes(1));
    first.unmount();

    render(React.createElement(TerminalTab, props));
    await waitFor(() => expect(openPort).toHaveBeenCalledTimes(2));
  });

  // U1/U3 — the pty is born at the size the pane will be READ at, so a
  // full-screen vendor TUI does not paint its first frame at 80 columns.
  it("opens with the view's MEASURED grid when the pane could measure itself", async () => {
    const p = fakePort();
    const v = fakeView({ cols: 214, rows: 57 });
    const openPort = vi.fn(async () => p.port);
    render(
      React.createElement(TerminalTab, {
        sessionId: "s1",
        spawn,
        openPort,
        createView: () => v.view,
      })
    );
    await waitFor(() =>
      expect(openPort).toHaveBeenCalledWith("s1", {
        file: "claude",
        cwd: "/ws",
        cols: 214,
        rows: 57,
      })
    );
  });

  it("sends NO geometry when the pane cannot measure itself", async () => {
    const p = fakePort();
    // A pane mounted hidden has no box; `size()` says so rather than guessing.
    const v = fakeView(null);
    const openPort = vi.fn(async () => p.port);
    render(
      React.createElement(TerminalTab, {
        sessionId: "s1",
        spawn,
        openPort,
        createView: () => v.view,
      })
    );
    await waitFor(() => expect(openPort).toHaveBeenCalledWith("s1", spawn));
    expect(openPort.mock.calls[0]![1]).not.toHaveProperty("cols");
  });

  // U2 — the tab-switch contract: backgrounding is show/hide, never lifecycle.
  it("backgrounding and restoring NEVER re-opens, closes, or disposes anything", async () => {
    const p = fakePort();
    const v = fakeView({ cols: 100, rows: 30 });
    const openPort = vi.fn(async () => p.port);
    const props = {
      sessionId: "s1",
      spawn,
      openPort,
      createView: () => v.view,
      hidden: false,
    };
    const view = render(React.createElement(TerminalTab, props));
    await waitFor(() => expect(openPort).toHaveBeenCalledTimes(1));

    view.rerender(React.createElement(TerminalTab, { ...props, hidden: true }));
    await flush();
    view.rerender(React.createElement(TerminalTab, { ...props, hidden: false }));
    await flush();

    expect(openPort).toHaveBeenCalledTimes(1); // no re-attach, no replay
    expect(p.isClosed()).toBe(false); // the host never detaches
    expect(p.posted).not.toContainEqual({ type: "close" }); // the pty never dies
    expect(v.isDisposed()).toBe(false); // the scrollback is the same XTerm

    // Bytes that arrived while it was backgrounded are still consumed + acked,
    // which is what keeps PtyHost's backpressure from pausing the child.
    act(() => p.emit({ type: "data", seq: 7, data: "still alive\n" }));
    expect(v.writes).toContain("still alive\n");
    expect(p.posted).toContainEqual({ type: "ack", seq: 7 });
  });

  it("re-measures when it comes back to the foreground", async () => {
    const p = fakePort();
    const v = fakeView({ cols: 100, rows: 30 });
    const props = {
      sessionId: "s1",
      spawn,
      openPort: async () => p.port,
      createView: () => v.view,
      hidden: true,
    };
    const view = render(React.createElement(TerminalTab, props));
    await flush();
    const beforeRestore = v.refits();

    view.rerender(React.createElement(TerminalTab, { ...props, hidden: false }));
    await flush();
    expect(v.refits()).toBe(beforeRestore + 1);

    // Going back to the background does NOT refit: a hidden container measures
    // 0×0, and fitting to that would resize the pty to a size nobody reads at.
    view.rerender(React.createElement(TerminalTab, { ...props, hidden: true }));
    await flush();
    expect(v.refits()).toBe(beforeRestore + 1);
  });
});

describe("TerminalTab — ROADMAP T4 parked-runtime LRU", () => {
  afterEach(() => cleanup());

  it("parking disposes the view but leaves the port (and pty) exactly alone", async () => {
    const p = fakePort();
    const first = fakeSerializableView("boot\n$ ");
    const createView = vi.fn(() => first.view);
    const store = new ParkedTerminalStore();
    const props = {
      sessionId: "s1",
      spawn,
      openPort: async () => p.port,
      createView,
      hidden: true,
      parked: false,
      parkedStore: store,
    };
    const view = render(React.createElement(TerminalTab, props));
    await flush();
    expect(createView).toHaveBeenCalledTimes(1);

    view.rerender(React.createElement(TerminalTab, { ...props, parked: true }));
    await flush();

    expect(first.isDisposed()).toBe(true); // the renderer resources are freed
    expect(p.isClosed()).toBe(false); // the channel is untouched
    expect(p.posted).not.toContainEqual({ type: "close" }); // the pty is untouched
    expect(store.has("s1")).toBe(true); // the on-screen buffer was captured
  });

  it("keeps consuming + acking bytes while parked, buffering them for replay", async () => {
    const p = fakePort();
    const first = fakeSerializableView("boot\n");
    const store = new ParkedTerminalStore();
    const props = {
      sessionId: "s1",
      spawn,
      openPort: async () => p.port,
      createView: () => first.view,
      parked: true,
      parkedStore: store,
    };
    render(React.createElement(TerminalTab, props));
    await flush();

    act(() => p.emit({ type: "data", seq: 9, data: "background output\n" }));
    // The host is never stalled by a parked pane: bytes are still acked...
    expect(p.posted).toContainEqual({ type: "ack", seq: 9 });
    // ...but never rendered into the disposed view.
    expect(first.writes).not.toContain("background output\n");
  });

  it("resuming recreates the view and replays the serialized buffer plus pending bytes", async () => {
    const p = fakePort();
    const first = fakeSerializableView("boot\n$ ");
    const second = fakeSerializableView("resumed\n$ ");
    const views = [first, second];
    const createView = vi.fn(() => views.shift()!.view);
    const store = new ParkedTerminalStore();
    const props = {
      sessionId: "s1",
      spawn,
      openPort: async () => p.port,
      createView,
      parked: false,
      parkedStore: store,
    };
    const view = render(React.createElement(TerminalTab, props));
    await flush();
    expect(createView).toHaveBeenCalledTimes(1); // the initial, live view

    view.rerender(React.createElement(TerminalTab, { ...props, parked: true }));
    await flush();
    // Bytes the host sends WHILE parked must still land after resume.
    act(() => p.emit({ type: "data", seq: 1, data: "MID-PARK\n" }));

    view.rerender(React.createElement(TerminalTab, { ...props, parked: false }));
    await flush();

    expect(createView).toHaveBeenCalledTimes(2); // the resumed, fresh view
    expect(second.writes).toEqual(["boot\n$ MID-PARK\n"]); // serialized snapshot + buffered bytes, replayed together in one write
  });

  it("falls back to the host's own scrollback when nothing was parked in memory", async () => {
    const p = fakePort();
    const first = fakeView({ cols: 80, rows: 24 });
    const second = fakeView({ cols: 80, rows: 24 });
    const views = [first, second];
    const createView = vi.fn(() => views.shift()!.view);
    const store = new ParkedTerminalStore(); // never parked in THIS window
    const fetchHostScrollback = vi.fn(async () => ({
      text: "from the host ring\n",
      cols: 80,
      rows: 24,
    }));
    const props = {
      sessionId: "s1",
      spawn,
      openPort: async () => p.port,
      createView,
      parked: false,
      parkedStore: store,
      fetchHostScrollback,
    };
    const view = render(React.createElement(TerminalTab, props));
    await flush();
    view.rerender(React.createElement(TerminalTab, { ...props, parked: true }));
    await flush();
    // Simulate the LRU CAP evicting this entry while parked, rather than
    // the ordinary "still in memory" path exercised by the previous test.
    store.take("s1");
    view.rerender(React.createElement(TerminalTab, { ...props, parked: false }));
    await flush();

    expect(fetchHostScrollback).toHaveBeenCalledWith("s1");
    expect(second.writes).toContain("from the host ring\n");
  });

  it("honours a park requested before the port even finished opening", async () => {
    let resolveOpen: (port: TerminalClientPort) => void;
    const opened = new Promise<TerminalClientPort>((resolve) => {
      resolveOpen = resolve;
    });
    const p = fakePort();
    const v = fakeSerializableView("");
    const store = new ParkedTerminalStore();
    render(
      React.createElement(TerminalTab, {
        sessionId: "s1",
        spawn,
        openPort: () => opened,
        createView: () => v.view,
        parked: true,
        parkedStore: store,
      })
    );
    await flush();
    resolveOpen!(p.port);
    await flush();

    expect(v.isDisposed()).toBe(true); // parked the instant the port was ready
    expect(p.isClosed()).toBe(false);
  });
});
