import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  advertisedChords,
  captureOne,
  describeReport,
  judge,
  parseWaitFlag,
  promptGesture,
  runKeysDoctor,
  type KeysDoctorReport,
} from "../src/shell/keys-doctor.js";
import { KEYMAP } from "../src/shell/keymap.js";

/**
 * THE DOCTOR EXISTS BECAUSE A PROBE LIED.
 *
 * The founder reported that almost none of the advertised chords worked in
 * their terminal, and I could not reproduce it: their config was clean, the
 * engine's bindings were guarded, the decoder's tests passed, and a pty probe
 * said 79 of 79 keys arrived. That probe sent the bytes I BELIEVED a terminal
 * sends, so it could only ever confirm my own model of the input.
 *
 * A terminal is not one thing. Every emulator answers the protocol
 * negotiation differently, every user can reconfigure it, and a multiplexer in
 * between rewrites it again. So MUON stops reasoning about what reaches it and
 * measures — on the user's machine, against the chords it actually advertises.
 *
 * These tests are about the CLASSIFIER, which is the part that must not repeat
 * the original mistake: it has to be able to say "this does not work" about a
 * real terminal's real bytes.
 */

const ESC = String.fromCodePoint(0x1b);
const CTRL_B = String.fromCodePoint(2);
const CTRL_Q = String.fromCodePoint(17);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => sleep(5);

/** A stdin that only has to emit "data" and be listenable. */
function fakeStdin() {
  const stream = new EventEmitter() as unknown as NodeJS.ReadStream & {
    press: (data: string) => void;
  };
  Object.assign(stream, {
    setRawMode: () => stream,
    resume: () => stream,
    pause: () => stream,
    setEncoding: () => stream,
    press: (data: string) => stream.emit("data", data),
  });
  return stream;
}

function fakeTty() {
  const stdin = fakeStdin();
  let out = "";
  return {
    stdin,
    stdout: { write: (text: string) => void (out += text) } as NodeJS.WriteStream,
    written: () => out,
    press: (data: string) => stdin.press(data),
  };
}

function chord(key: string) {
  const entry = advertisedChords().find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no advertised chord ${key}`);
  return entry;
}

describe("it asks about exactly what the desk advertises", () => {
  it("covers every always- and prefix-scoped binding, and nothing invented", () => {
    // If `?` shows it, the doctor must be able to check it. A chord the help
    // advertises and the doctor cannot test is a gap in the law, not a gap in
    // the doctor.
    const advertised = KEYMAP.filter(
      (entry) => entry.scope === "always" || entry.scope === "prefix"
    );
    expect(advertisedChords()).toEqual(advertised);
    expect(advertisedChords().length).toBeGreaterThan(5);
  });
});

describe("the four verdicts, each on a real failure shape", () => {
  it("WORKS when the legacy byte arrives", () => {
    expect(judge(chord("ctrl+q"), CTRL_Q).outcome).toBe("works");
    expect(judge(chord("ctrl+b"), CTRL_B).outcome).toBe("works");
  });

  it("WORKS when the same chord arrives as kitty CSI-u", () => {
    // The form the founder's terminal sends once the protocol is negotiated.
    // A doctor that only understood legacy bytes would report a false failure
    // and send someone hunting the wrong bug.
    expect(judge(chord("ctrl+q"), `${ESC}[113;5u`).outcome).toBe("works");
    expect(judge(chord("ctrl+b"), `${ESC}[98;5u`).outcome).toBe("works");
  });

  it("SWALLOWED when nothing arrived at all", () => {
    // The terminal, the OS or a multiplexer took it. This is the verdict that
    // would have told the founder in one command what I could not work out
    // from their config.
    const verdict = judge(chord("ctrl+q"), "");
    expect(verdict.outcome).toBe("swallowed");
    expect(verdict.note).toContain("nothing reached MUON");
    expect(verdict.received).toBe("");
  });

  it("UNDECODED when the bytes arrive in a form MUON does not know", () => {
    // The exact shape of the arrow bug: a sequence MUON does not recognise is
    // not dropped — it is forwarded to the child as though it were typing.
    const verdict = judge(chord("ctrl+q"), `${ESC}[9999;77:1u`);
    expect(verdict.outcome).toBe("undecoded");
    expect(verdict.note).toContain("does not recognise");
  });

  it("MISROUTED when the bytes decode to a different action", () => {
    // Pressing the wrong key, or a terminal that remaps one chord onto
    // another. Reported as wrong rather than as broken, because the fix is
    // different.
    const verdict = judge(chord("ctrl+q"), CTRL_B);
    expect(verdict.outcome).toBe("misrouted");
    expect(verdict.note).toContain("different key");
  });

  it("records the RAW BYTES on every verdict, so a report is actionable", () => {
    // "It did not work" is a complaint. The hex is a decoder case with a test.
    expect(judge(chord("ctrl+q"), `${ESC}[113;5u`).received).toBe(
      "1b5b3131333b3575"
    );
  });
});

describe("a prefix chord is judged in the scope it lives in", () => {
  it("resolves a prefix command with the prefix armed", () => {
    // `s` alone means nothing — it belongs to the child. Judged without the
    // armed prefix it would report a false failure for every prefix row.
    const sessions = advertisedChords().find(
      (entry) => entry.scope === "prefix" && entry.key === "ctrl+b s"
    );
    expect(sessions, "the keymap still advertises ctrl+b s").toBeDefined();
    expect(judge(sessions!, "s").outcome).toBe("works");
  });

  it("and a bare key in the ALWAYS scope is not given that benefit", () => {
    // `ctrl+q` must work with nothing armed; if it only worked after a prefix
    // the doctor would be hiding the failure it exists to find.
    expect(judge(chord("ctrl+q"), CTRL_Q).outcome).toBe("works");
  });
});

describe("the wait budget is a human's to set", () => {
  // The doctor's whole value is that a verdict is TRUE. A window too short to
  // press the chord in manufactures "swallowed" — the same false-failure
  // direction as the probe this tool replaced, just with a nicer report.

  it("defaults to a generous window rather than a hurried one", async () => {
    const io = fakeTty();
    // Only the negotiation is shortened; perKeyMs is left to the default,
    // which is the thing under test.
    const run = runKeysDoctor({ ...io, negotiateMs: 1 });
    await tick();
    expect(io.written()).toMatch(/You have 15s per keystroke/);
    io.press(String.fromCodePoint(3));
    await run;
  });

  it("accepts --wait in both spellings", () => {
    expect(parseWaitFlag(["--wait", "45"]).perKeyMs).toBe(45_000);
    expect(parseWaitFlag(["--wait=2.5"]).perKeyMs).toBe(2_500);
    expect(parseWaitFlag(["--json"]).perKeyMs).toBeUndefined();
  });

  it("REFUSES a bad --wait instead of quietly using the default", () => {
    // Falling back would hand someone a 15s window while they believed they
    // had asked for 60, and every swallowed verdict after that is unexplainable.
    expect(parseWaitFlag(["--wait", "soon"]).error).toContain("positive number");
    expect(parseWaitFlag(["--wait", "0"]).error).toBeTruthy();
    expect(parseWaitFlag(["--wait", "-5"]).error).toBeTruthy();
    expect(parseWaitFlag(["--wait"]).error).toContain("nothing");
  });
});

describe("a prefix gesture gets a FRESH window for its second key", () => {
  it("does not count the pause after ctrl+b against the letter", async () => {
    // Two presses sharing one budget meant a human who thought between them
    // got a false "swallowed" for a chord that works.
    // The timings straddle the ORIGINAL deadline deliberately. A human spends
    // most of the first window finding ctrl+b, so the letter lands after the
    // shared budget would have expired but well inside a fresh one.
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 100, true);
    await sleep(75); // hunting for the prefix key
    stdin.press(CTRL_B); // …found at 75ms of a 100ms budget
    await sleep(60); // the letter lands at ~135ms: past the old deadline
    stdin.press("s");
    expect(await captured).toBe("s");
  });

  it("still gives up when the second key never comes", async () => {
    // The refresh must not become "wait forever" — an unpressed prefix chord
    // is still a swallowed verdict, and the run has to reach the next row.
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 30, true);
    stdin.press(CTRL_B);
    expect(await captured).toBe("");
  });

  it("and an ALWAYS chord gets exactly one window", async () => {
    const stdin = fakeStdin();
    expect(await captureOne(stdin, 20, false)).toBe("");
  });

  it("detaches its listener so a later chord is not judged twice", async () => {
    // Every row installs a listener; leaking one would feed a keystroke to a
    // finished capture and silently corrupt the next verdict.
    const stdin = fakeStdin();
    await captureOne(stdin, 10, false);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});

describe("it asks for the gesture it actually wants", () => {
  // The founder ran the doctor and every prefix row said `misrouted`. The
  // cause was this prompt: the keymap spells the chord as the WHOLE gesture,
  // so "ctrl+b then " + "ctrl+b s" told them to press the prefix twice. The
  // second ctrl+b was then judged — accurately — as a different action, and a
  // tool built to end guesswork reported a terminal fault that did not exist.
  it("never prints the prefix twice", () => {
    for (const entry of advertisedChords()) {
      const prompt = promptGesture(entry);
      expect(prompt.match(/ctrl\+b/g)?.length ?? 0, prompt).toBeLessThanOrEqual(1);
    }
  });

  it("spells a prefix chord as 'ctrl+b then <key>'", () => {
    expect(promptGesture({ key: "ctrl+b s", scope: "prefix" })).toBe("ctrl+b then s");
    expect(promptGesture({ key: "ctrl+b ?", scope: "prefix" })).toBe("ctrl+b then ?");
  });

  it("leaves an always-scoped chord alone", () => {
    expect(promptGesture({ key: "ctrl+q", scope: "always" })).toBe("ctrl+q");
  });
});

describe("a fumbled gesture is forgiven, not blamed on the terminal", () => {
  it("a REPEATED prefix re-arms instead of becoming the answer", async () => {
    // Exactly what the founder's run did: ctrl+b, ctrl+b, s.
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 120, true);
    stdin.press(CTRL_B);
    stdin.press(CTRL_B);
    await sleep(10);
    stdin.press("s");
    expect(await captured).toBe("s");
  });

  it("and the re-arm is safe: no prefix chord's second key IS the prefix", () => {
    // If one ever were, re-arming would make that chord untestable. This is
    // the guard that lets the forgiveness above stay unconditional.
    for (const entry of advertisedChords()) {
      if (entry.scope !== "prefix") continue;
      expect(entry.key.replace(/^\S+\s+/, ""), entry.key).not.toBe("ctrl+b");
    }
  });
});

describe("the report tells a human what to do", () => {
  const report = (outcomes: KeysDoctorReport["verdicts"]): KeysDoctorReport => ({
    protocol: "kitty",
    protocolDetail: "granted flags 7",
    term: "xterm-ghostty",
    verdicts: outcomes,
  });

  it("says plainly when everything works", () => {
    const text = describeReport(
      report([
        { key: "ctrl+q", action: "quit", received: "11", outcome: "works", note: "" },
      ])
    );
    expect(text).toContain("every advertised chord works");
  });

  it("names the broken ones and puts the blame in the right place", () => {
    // A chord MUON advertises and cannot receive is MUON's bug. A human should
    // not close this thinking their terminal is misconfigured.
    const text = describeReport(
      report([
        { key: "ctrl+q", action: "quit", received: "", outcome: "swallowed", note: "gone" },
        { key: "ctrl+b", action: "arm-prefix", received: "02", outcome: "works", note: "" },
      ])
    );
    expect(text).toContain("1 of 2 advertised chord(s) do NOT work here");
    expect(text).toContain("ctrl+q — swallowed");
    expect(text).toContain("is a bug in MUON, not in you");
  });

  it("states which protocol the terminal granted, because it changes everything", () => {
    const text = describeReport(report([]));
    expect(text).toContain("xterm-ghostty");
    expect(text).toContain("kitty");
    expect(text).toContain("granted flags 7");
  });
});

describe("a coalesced read is still two keystrokes", () => {
  it("accepts ctrl+b and its command key arriving together", () => {
    // The terminal hands over whatever is in the pipe. `ctrl+b` then `s` typed
    // a fraction of a second apart often arrives as one read, `\x02s`.
    // Treating a read as exactly one key meant the prefix went unrecognised,
    // the command key was never recorded, and a WORKING chord was reported as
    // swallowed — the doctor failing in its most misleading direction.
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 200, true);
    stdin.press(`${CTRL_B}s`);
    return expect(captured).resolves.toBe("s");
  });

  it("still handles the two keystrokes arriving separately", () => {
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 200, true);
    stdin.press(CTRL_B);
    stdin.press("s");
    return expect(captured).resolves.toBe("s");
  });

  it("a lone prefix in one read still waits for the command key", () => {
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 20, true);
    stdin.press(CTRL_B);
    return expect(captured).resolves.toBe("");
  });
});

describe("the doctor reads the way the DESK reads", () => {
  /**
   * A terminal splits its reads wherever the pipe was full, so `ESC[98;5u` can
   * arrive as `ESC[98;` then `5u`. The desk reassembles those; the doctor did
   * not — so it would report a chord the desk handles perfectly as
   * `undecoded` or `swallowed`. A diagnostic that is wrong about exactly the
   * terminal behaviour it exists to investigate is worse than none.
   */
  it("reassembles a chord split across two reads", async () => {
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 400, false);
    stdin.press(`${ESC}[113;`);
    await sleep(10);
    stdin.press("5u");
    expect(await captured).toBe(`${ESC}[113;5u`);
  });

  it("reassembles a prefix gesture whose first half is split", async () => {
    const stdin = fakeStdin();
    const captured = captureOne(stdin, 400, true);
    stdin.press(`${ESC}[98`);
    await sleep(5);
    stdin.press(";5u");
    await sleep(5);
    stdin.press("s");
    expect(await captured).toBe("s");
  });
});
