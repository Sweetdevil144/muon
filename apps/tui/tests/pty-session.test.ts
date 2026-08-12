import { describe, expect, it } from "vitest";
import { PtySession, type PtySessionSpec } from "../src/shell/pty-session.js";
import { TERMINAL_FAST_EXIT_MS } from "@muon/client/terminal-vendor-tabs";
import { PtyPane } from "../src/shell/pty-pane.js";

/**
 * REAL node-pty, REAL @xterm/headless — no mocks, by standing rule: an
 * embedded runtime needs at least one test against production options,
 * because a fake xterm once hid an app-killing crash on this very desktop.
 * (`real-library-pins`.) These spawn actual /bin/sh children.
 */

function spec(over: Partial<PtySessionSpec> = {}): PtySessionSpec {
  return {
    id: "s1",
    title: "test-shell",
    command: "/bin/sh",
    args: ["-c", "printf 'hello-from-pty'"],
    cwd: process.cwd(),
    envKind: "shell",
    ungoverned: true,
    cols: 40,
    rows: 6,
    ...over,
  };
}

/**
 * Wait for CONTENT, not for exit.
 *
 * xterm's `write` is asynchronous (its WriteBuffer chunks through timers), so
 * the emulator's screen LAGS the pty by a tick or two — a child's exit event
 * can beat its own last bytes onto the screen. Four tests here asserted right
 * after `exit !== null` and were latently flaky because of it; one finally
 * flaked when a refactor shifted the timing. Waiting on the text is both
 * correct and honest about the lag.
 */
function untilScreen(
  session: PtySession,
  text: string,
  timeoutMs = 10_000
): Promise<void> {
  return until(
    () => session.renderScreen().some((line) => line.includes(text)),
    timeoutMs
  );
}

function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error("condition not reached"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("PtySession — a real child, really emulated", () => {
  it("renders the child's actual output through the emulator", async () => {
    const session = new PtySession(spec());
    try {
      await until(() =>
        session.renderScreen().some((line) => line.includes("hello-from-pty"))
      );
      expect(
        session.renderScreen().join("\n")
      ).toContain("hello-from-pty");
    } finally {
      session.dispose();
    }
  });

  it("the emulator consumes without any renderer attached (node-pty drains the fd; the desktop's relay stall has no analogue here)", async () => {
    // Honest scope (corrected by review): node-pty drains the pty fd whether
    // or not anyone listens, so the DESKTOP's stall (an ack-gated relay over
    // a MessagePort) has no analogue in-process. What this pins is smaller
    // and still worth having: the emulator ingests everything with no
    // renderer attached, so the final screen is complete.
    const session = new PtySession(
      spec({ args: ["-c", "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; printf DONE-ALL"] })
    );
    try {
      // Only NOW read the screen: the child must have completed unthrottled.
      await untilScreen(session, "DONE-ALL", 15_000);
    } finally {
      session.dispose();
    }
  }, 20_000);

  it("F8: a fast failure keeps the pane; the exit banner names the code", async () => {
    const session = new PtySession(spec({ args: ["-c", "exit 3"] }));
    try {
      await until(() => session.exit !== null);
      expect(session.exit?.code).toBe(3);
      const pane = new PtyPane(session);
      expect(pane.render(80).join("\n")).toContain("[session exited: code 3]");
    } finally {
      session.dispose();
    }
  });

  it("F8 has exactly ONE threshold — the shared module's", async () => {
    // The review found TWO: a local FAST_FAILURE_MS=5000 (dead code, only its
    // own test called it) and the shared TERMINAL_FAST_EXIT_MS=4000 the
    // manager actually enforces. A child living 4.5s was simultaneously
    // "keep" and "close". The local rule is deleted; the runtime is recorded
    // on the session and the MANAGER judges it with the shared rule.
    let t = 0;
    const session = new PtySession(spec({ args: ["-c", "true"] }), () => {
      const v = t;
      t += TERMINAL_FAST_EXIT_MS + 1;
      return v;
    });
    try {
      await until(() => session.exit !== null);
      expect(session.exit!.runtimeMs).toBeGreaterThan(TERMINAL_FAST_EXIT_MS);
    } finally {
      session.dispose();
    }
  });

  it("renderScreen emits SGR and text ONLY — sampled while the child is ALIVE", async () => {
    // The previous version of this pin asserted after exit, when the disarm
    // had already emptied the buffer — expect("").not.toContain(x) passes for
    // every x, so the test could not fail while the behaviour was the exact
    // opposite (serialize emitted ?1049h/?1002h/?2004h into the host frame).
    // This samples DURING the hostile child's life and closes the class: the
    // ONLY escape allowed out of renderScreen is the SGR `m` sequence it
    // builds itself.
    const esc = String.fromCodePoint(0x1b);
    const session = new PtySession(
      spec({
        args: [
          "-c",
          `printf '${esc}[2J${esc}[?1049h${esc}[5;5H${esc}[31mtrapped${esc}[0m'; sleep 2`,
        ],
      })
    );
    try {
      await until(() =>
        session.renderScreen().some((line) => line.includes("trapped"))
      );
      expect(session.alive, "the child must still be ALIVE at sample time").toBe(
        true
      );
      const screen = session.renderScreen().join("\n");
      // Every escape present must be an SGR sequence and nothing else.
      const nonSgr = screen
        .split(esc)
        .slice(1)
        .filter((chunk) => !/^\[[0-9;]*m/.test(chunk));
      expect(nonSgr, `non-SGR escapes leaked: ${JSON.stringify(nonSgr)}`).toEqual(
        []
      );
      // The child's content is there — on the ALT buffer, at its position.
      expect(screen).toContain("trapped");
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("the child's COLORS survive the per-cell reconstruction", async () => {
    const esc = String.fromCodePoint(0x1b);
    const session = new PtySession(
      spec({ args: ["-c", `printf '${esc}[31mRED-TEXT${esc}[0m plain'; sleep 1`] })
    );
    try {
      await until(() =>
        session.renderScreen().some((line) => line.includes("RED-TEXT"))
      );
      const line = session.renderScreen().find((l) => l.includes("RED-TEXT"))!;
      expect(line).toContain(`${esc}[31m`);
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("MUON's control-plane tokens NEVER reach a spawned pane", async () => {
    // The sharpest finding of the bundle review: every pane inherited the
    // operator's bearer, so anything in an UNGOVERNED pane could call the
    // brain with operator authority. The desktop strips these at its spawn
    // boundary; the rule is now shared and this pins the TUI side.
    process.env.MUON_API_TOKEN = "smoke-secret-operator";
    process.env.MUON_FAKE_TEST_TOKEN = "backstop-check";
    try {
      const session = new PtySession(
        spec({ args: ["-c", "printf TOKEN=$MUON_API_TOKEN,BACK=$MUON_FAKE_TEST_TOKEN,END"] })
      );
      try {
        await untilScreen(session, "END");
        const screen = session.renderScreen().join("\n");
        expect(screen).toContain("TOKEN=,");
        expect(screen).toContain("BACK=,");
        expect(screen).not.toContain("smoke-secret-operator");
      } finally {
        session.dispose();
      }
    } finally {
      delete process.env.MUON_API_TOKEN;
      delete process.env.MUON_FAKE_TEST_TOKEN;
    }
  }, 15_000);

  it("D5: the ungoverned banner is chrome, and it is sanitized", async () => {
    const hostile = `evil${String.fromCodePoint(0x202e)}title`;
    const session = new PtySession(spec({ title: hostile }));
    try {
      const pane = new PtyPane(session);
      const out = pane.render(80).join("\n");
      expect(out).toContain("UNGOVERNED");
      expect(out).not.toContain(String.fromCodePoint(0x202e));
    } finally {
      session.dispose();
    }
  });

  it("F16: resize reaches both the emulator and the child", async () => {
    const session = new PtySession(
      spec({ args: ["-c", "sleep 0.4; printf COLS-$(tput cols)"] })
    );
    try {
      session.resize(97, 10);
      await untilScreen(session, "COLS-97");
    } finally {
      session.dispose();
    }
  });

  it("a paste wrapper is stripped for a child that never enabled bracketed paste", async () => {
    // The host always runs with bracketed paste armed, so a paste arrives as
    // ESC[200~…ESC[201~. A plain sh never enabled the mode; the review showed
    // the literal markers landing on its prompt. The emulator knows the
    // child's real DECSET 2004 state — forward exactly when asked for.
    const esc = String.fromCodePoint(0x1b);
    const session = new PtySession(spec({ args: ["-c", "read line; printf \"GOT:$line\""] }));
    try {
      session.write(`${esc}[200~hello-paste${esc}[201~\n`);
      await untilScreen(session, "GOT:");
      const screen = session.renderScreen().join("\n");
      expect(screen).toContain("GOT:hello-paste");
      expect(screen).not.toContain("[200~");
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("the wrapper is FORWARDED to a child that enabled the mode", async () => {
    const esc = String.fromCodePoint(0x1b);
    // The child arms DECSET 2004 itself, then cats its input raw.
    const session = new PtySession(
      spec({ args: ["-c", `printf '${esc}[?2004h'; read line; printf \"RAW:$line\" | cat -v`] })
    );
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the arm land
      session.write(`${esc}[200~wrapped${esc}[201~\n`);
      // Wait for the CHILD's own line ("RAW:"), not the tty's echo of what we
      // wrote: the echo appears in ~7ms and contains the same marker, so
      // matching on it alone proved nothing about what the child received.
      await untilScreen(session, "RAW:^[[200~wrapped");
    } finally {
      session.dispose();
    }
  }, 15_000);
});

describe("a child in application cursor keys mode gets the form it asked for", () => {
  // The second reason the founder's arrows did nothing, and the half a
  // mode-tracking test cannot reach: the mode must actually change what we
  // WRITE. A full-screen TUI arms DECSET 1 and listens for `ESC O A`; our host
  // is in the normal mode and sends `ESC [ A`, so forwarding verbatim hands
  // the child a sequence it has explicitly stopped listening for.
  //
  // REAL pty, per the standing rule — this is exactly the seam a fake would
  // paper over.
  const ESCAPE = String.fromCodePoint(0x1b);

  async function record(armDeccm: boolean, send: string): Promise<string> {
    const session = new PtySession(
      spec({
        // Arms DECCKM (or not), then echoes every byte it receives as hex.
        args: [
          "-c",
          `${armDeccm ? `printf '${ESCAPE}[?1h';` : ""} ` +
            `node -e 'process.stdin.setRawMode(true);` +
            `process.stdin.on("data",b=>process.stdout.write(b.toString("hex")+" "))'`,
        ],
      })
    );
    // Let the child arm the mode and reach its read loop.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    session.write(send);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const screen = session.renderScreen().join("");
    session.dispose();
    return screen;
  }

  it("re-encodes an arrow to SS3 when the child armed DECCKM", async () => {
    const seen = await record(true, `${ESCAPE}[A`);
    expect(seen, "ESC O A, not ESC [ A").toContain("1b4f41");
    expect(seen).not.toContain("1b5b41");
  }, 20_000);

  it("leaves the arrow alone when the child did NOT arm it", async () => {
    const seen = await record(false, `${ESCAPE}[A`);
    expect(seen).toContain("1b5b41");
    expect(seen).not.toContain("1b4f41");
  }, 20_000);

  it("keeps a MODIFIED arrow in its CSI form even in application mode", async () => {
    // SS3 has nowhere to put a modifier. xterm keeps CSI here, and so does
    // every CLI that parses it.
    const seen = await record(true, `${ESCAPE}[1;5D`);
    expect(seen).toContain("1b5b313b3544");
  }, 20_000);
});
