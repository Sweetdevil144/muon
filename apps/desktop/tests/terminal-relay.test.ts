import { describe, expect, it } from "vitest";
import { FakePtyDriver, PtyHost, type PtyHostOptions } from "@muon/runner";
import { PtyRelay } from "../src/lib/pty-relay.js";
import { wireTerminal, type TerminalView } from "../src/renderer/lib/terminal-wire.js";
import type {
  TerminalClientFrame,
  TerminalClientPort,
  TerminalHostFrame,
  TerminalRelayPort,
} from "../src/shared/terminal-protocol.js";

/**
 * A synchronous, connected relay↔client port pair standing in for a
 * MessageChannelMain. Like a real MessagePort it BUFFERS frames posted before the
 * receiving end attaches a listener, then flushes on attach — this is exactly why
 * the relay may replay scrollback before the renderer's wireTerminal has wired up.
 */
function connectedPorts() {
  const toHostQueue: TerminalClientFrame[] = [];
  const toRendererQueue: TerminalHostFrame[] = [];
  let hostListener: ((f: TerminalClientFrame) => void) | undefined;
  let rendererListener: ((f: TerminalHostFrame) => void) | undefined;
  const onCloseListeners: Array<() => void> = [];
  const sent: TerminalHostFrame[] = [];

  const relayPort: TerminalRelayPort = {
    post: (f) => {
      sent.push(f);
      if (rendererListener) rendererListener(f);
      else toRendererQueue.push(f);
    },
    onFrame: (l) => {
      hostListener = l;
      toHostQueue.splice(0).forEach(l);
    },
    onClose: (l) => onCloseListeners.push(l),
  };
  const closeRendererEnd = () => onCloseListeners.forEach((l) => l());
  const clientPort: TerminalClientPort = {
    post: (f) => {
      if (hostListener) hostListener(f);
      else toHostQueue.push(f);
    },
    onFrame: (l) => {
      rendererListener = l;
      toRendererQueue.splice(0).forEach(l);
    },
    // Closing the renderer end propagates to the relay's port "close" (→ detach).
    close: closeRendererEnd,
  };
  return {
    relayPort,
    clientPort,
    sentToRenderer: sent,
    closeRendererEnd,
  };
}

function fakeView() {
  const writes: string[] = [];
  let inputCb: ((d: string) => void) | undefined;
  let resizeCb: ((s: { cols: number; rows: number }) => void) | undefined;
  let exited: { exitCode: number; signal?: number; lifetimeMs: number } | undefined;
  const view: TerminalView = {
    write: (d) => writes.push(d),
    onInput: (l) => {
      inputCb = l;
      return { dispose: () => (inputCb = undefined) };
    },
    onResize: (l) => {
      resizeCb = l;
      return { dispose: () => (resizeCb = undefined) };
    },
    markExited: (e) => (exited = e),
    dispose: () => undefined,
  };
  return {
    view,
    writes,
    typeInput: (d: string) => inputCb?.(d),
    resize: (s: { cols: number; rows: number }) => resizeCb?.(s),
    exited: () => exited,
  };
}

function setup(hostOptions?: PtyHostOptions) {
  let driver: FakePtyDriver | undefined;
  const host = new PtyHost((o) => (driver = new FakePtyDriver(o)), hostOptions);
  const relay = new PtyRelay(host);
  return {
    host,
    relay,
    driver: () => {
      if (!driver) throw new Error("no driver spawned");
      return driver;
    },
  };
}

const spawn = { file: "claude", cwd: "/ws" } as const;

describe("terminal byte relay (Wave 4 slice 5.0.2)", () => {
  it("round-trips output, input, resize, and exit end to end", () => {
    const { relay, driver } = setup();
    relay.open("s1", spawn);
    const { relayPort, clientPort } = connectedPorts();
    const v = fakeView();
    relay.attach("s1", relayPort);
    wireTerminal(clientPort, v.view);

    driver().emit("hello\n"); // host output → view
    expect(v.writes).toEqual(["hello\n"]);

    v.typeInput("ls\r"); // renderer input → host
    expect(driver().writes).toEqual(["ls\r"]);

    v.resize({ cols: 120, rows: 40 });
    expect(driver().resizes).toEqual([{ cols: 120, rows: 40 }]);

    driver().finish(0); // exit → view
    // The child's HOST-measured lifetime rides along, so the renderer never
    // has to date the death from its own clock (see terminal-protocol.ts).
    expect(v.exited()).toMatchObject({ exitCode: 0 });
    expect(v.exited()?.lifetimeMs).toBeTypeOf("number");
  });

  it("forwards renderer acks so host backpressure resumes end to end", () => {
    const { relay, driver } = setup({ highWaterMark: 8, lowWaterMark: 2 });
    relay.open("s1", spawn);
    const { relayPort, clientPort } = connectedPorts();
    // A SLOW renderer: it records data frames but does NOT auto-ack.
    const seenSeq: number[] = [];
    clientPort.onFrame((f) => {
      if (f.type === "data") seenSeq.push(f.seq);
    });
    relay.attach("s1", relayPort);

    driver().emit("123456789"); // 9 bytes > high-water → pause
    expect(driver().paused).toBe(true);

    clientPort.post({ type: "ack", seq: seenSeq.at(-1)! }); // renderer drains
    expect(driver().paused).toBe(false);
  });

  it("survives a renderer reload: the port closes → session lives → a new port replays scrollback", () => {
    const { host, relay, driver } = setup();
    relay.open("s1", spawn);

    const first = connectedPorts();
    const v1 = fakeView();
    relay.attach("s1", first.relayPort);
    wireTerminal(first.clientPort, v1.view);
    driver().emit("before-reload\n");
    expect(v1.writes).toEqual(["before-reload\n"]);

    // Window reloads: the renderer end closes. The pty must NOT be killed.
    first.closeRendererEnd();
    expect(host.has("s1")).toBe(true);
    // Output while detached is retained in the host's scrollback.
    driver().emit("while-detached\n");

    // A fresh port re-attaches and re-materializes the whole session.
    const second = connectedPorts();
    const v2 = fakeView();
    relay.attach("s1", second.relayPort);
    wireTerminal(second.clientPort, v2.view);
    expect(v2.writes).toEqual(["before-reload\n", "while-detached\n"]);

    driver().emit("after-reconnect\n");
    expect(v2.writes.at(-1)).toBe("after-reconnect\n");
  });

  it("reconnect race: a LATE close of the old port does not freeze the reconnected terminal", () => {
    const { host, relay, driver } = setup();
    relay.open("s1", spawn);
    const first = connectedPorts();
    relay.attach("s1", first.relayPort);
    driver().emit("a\n");

    // A new port attaches (reconnect) BEFORE the old port's close is processed.
    const second = connectedPorts();
    const v2 = fakeView();
    relay.attach("s1", second.relayPort);
    wireTerminal(second.clientPort, v2.view);

    // NOW the old port closes late — must NOT null the new consumer.
    first.closeRendererEnd();
    driver().emit("b\n");
    expect(v2.writes.at(-1)).toBe("b\n");
    expect(host.has("s1")).toBe(true);
  });

  it("stops writing to a DISPOSED view: a frame after wire.dispose() is ignored", () => {
    const { relay, driver } = setup();
    relay.open("s1", spawn);
    const { relayPort, clientPort } = connectedPorts();
    const v = fakeView();
    relay.attach("s1", relayPort);
    const wire = wireTerminal(clientPort, v.view);

    driver().emit("live\n");
    expect(v.writes).toEqual(["live\n"]);

    wire.dispose();
    driver().emit("after-dispose\n"); // arrives after the view was torn down
    expect(v.writes).toEqual(["live\n"]); // never written to a disposed view
  });

  it("destroys the pty on an explicit close frame (never orphaned)", () => {
    const { host, relay, driver } = setup();
    relay.open("s1", spawn);
    const { relayPort, clientPort } = connectedPorts();
    relay.attach("s1", relayPort);

    clientPort.post({ type: "close" });
    expect(driver().killed).toBeDefined();
    expect(host.has("s1")).toBe(false);
  });

  it("ignores a write that races after close instead of crashing", () => {
    const { relay } = setup();
    relay.open("s1", spawn);
    const { relayPort, clientPort } = connectedPorts();
    relay.attach("s1", relayPort);

    clientPort.post({ type: "close" });
    expect(() =>
      clientPort.post({ type: "write", data: "late keystroke" })
    ).not.toThrow();
  });

  it("puts BYTES + coordinates only on the wire — never a token/secret field (I1/I3)", () => {
    const { relay, driver } = setup();
    relay.open("s1", spawn);
    const { relayPort, clientPort, sentToRenderer } = connectedPorts();
    const v = fakeView();
    relay.attach("s1", relayPort);
    wireTerminal(clientPort, v.view);

    driver().emit("secret-looking output sk-abc123");
    driver().finish(0, 15);

    for (const frame of sentToRenderer) {
      const keys = Object.keys(frame).sort();
      if (frame.type === "data") {
        expect(keys).toEqual(["data", "seq", "type"]);
      } else {
        // exit carries only the numeric result + the child's measured
        // lifetime — never a credential.
        expect(
          keys.every((k) =>
            ["type", "exitCode", "signal", "lifetimeMs"].includes(k)
          )
        ).toBe(true);
      }
    }
  });
});
