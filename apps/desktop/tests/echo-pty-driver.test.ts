import { describe, expect, it } from "vitest";
import { PtyHost } from "@muon/runner";
import { EchoPtyDriver } from "../src/lib/echo-pty-driver.js";
import { PtyRelay } from "../src/lib/pty-relay.js";
import { wireTerminal, type TerminalView } from "../src/renderer/lib/terminal-wire.js";
import type {
  TerminalClientFrame,
  TerminalClientPort,
  TerminalHostFrame,
  TerminalRelayPort,
} from "../src/shared/terminal-protocol.js";

describe("EchoPtyDriver (Wave 4 fake path)", () => {
  it("prints a banner then echoes writes; CR yields a prompt", async () => {
    const driver = new EchoPtyDriver({ file: "claude", cwd: "/ws" });
    const out: string[] = [];
    driver.onData((d) => out.push(d));
    await Promise.resolve(); // flush the queued banner
    expect(out.join("")).toContain("muon dev terminal");
    driver.write("ls");
    expect(out.join("")).toContain("ls");
    driver.write("\r");
    expect(out.join("")).toContain("\r\n$ ");
  });

  it("exits exactly once on kill", () => {
    const driver = new EchoPtyDriver({ file: "x", cwd: "/ws" });
    const exits: unknown[] = [];
    driver.onExit((e) => exits.push(e));
    driver.kill();
    driver.kill();
    expect(exits).toEqual([{ exitCode: 0 }]);
  });

  it("buffers output while paused and flushes on resume (backpressure honored)", () => {
    const driver = new EchoPtyDriver({ file: "x", cwd: "/ws" });
    const out: string[] = [];
    driver.onData((d) => out.push(d));
    driver.pause();
    driver.write("hidden");
    expect(out).toEqual([]);
    driver.resume();
    expect(out.join("")).toContain("hidden");
  });
});

// The FULL fake pipe: host(echo) → relay → (port) → wire → view. Proves a lane is
// watchable end to end with zero real vendor / node-pty.
describe("full fake terminal pipe", () => {
  function connectedPorts() {
    let hostListener: ((f: TerminalClientFrame) => void) | undefined;
    let rendererListener: ((f: TerminalHostFrame) => void) | undefined;
    const toRenderer: TerminalHostFrame[] = [];
    const relayPort: TerminalRelayPort = {
      post: (f) => (rendererListener ? rendererListener(f) : toRenderer.push(f)),
      onFrame: (l) => (hostListener = l),
      onClose: () => undefined,
    };
    const clientPort: TerminalClientPort = {
      post: (f) => hostListener?.(f),
      onFrame: (l) => {
        rendererListener = l;
        toRenderer.splice(0).forEach(l);
      },
      close: () => undefined,
    };
    return { relayPort, clientPort };
  }

  it("renders the banner and round-trips typed input", async () => {
    const host = new PtyHost((o) => new EchoPtyDriver(o));
    const relay = new PtyRelay(host);
    relay.open("s1", { file: "claude", cwd: "/ws" });
    const { relayPort, clientPort } = connectedPorts();
    relay.attach("s1", relayPort);

    const writes: string[] = [];
    const view: TerminalView = {
      write: (d) => writes.push(d),
      onInput: (l) => {
        // simulate a keystroke immediately
        setTimeout(() => l("hi"), 0);
        return { dispose: () => undefined };
      },
      onResize: () => ({ dispose: () => undefined }),
      markExited: () => undefined,
      dispose: () => undefined,
    };
    wireTerminal(clientPort, view);
    await Promise.resolve(); // banner
    await new Promise((r) => setTimeout(r, 0)); // keystroke

    const rendered = writes.join("");
    expect(rendered).toContain("muon dev terminal"); // banner reached the view
    expect(rendered).toContain("hi"); // typed input echoed back through the pipe
  });
});
