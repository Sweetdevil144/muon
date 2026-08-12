#!/usr/bin/env node
/**
 * `muon keys doctor` — WHAT YOUR TERMINAL ACTUALLY SENDS.
 *
 * WHY THIS EXISTS, stated plainly because it is a confession as much as a
 * feature. The founder reported that almost none of the advertised chords
 * worked in their terminal. I could not reproduce it: their Ghostty config
 * takes only one keybind, the engine's own bindings are guarded, the
 * decoder's unit tests pass, and a pty probe reported 79 of 79 keys arriving.
 * That probe was wrong in the way that matters — it sent the bytes I BELIEVED
 * a terminal sends, so it could only ever confirm my own model.
 *
 * A terminal is not one thing. Ghostty, kitty, WezTerm, foot, iTerm2, Apple
 * Terminal, tmux and screen each answer the protocol negotiation differently,
 * every one of them can be reconfigured by its user, and a multiplexer in
 * between rewrites the answer again. MUON cannot know what reaches it by
 * reasoning; it has to look.
 *
 * So this runs on the REAL terminal, negotiates exactly as the desk does, and
 * for every chord the desk ADVERTISES it records what actually arrives and
 * what the desk would do with it. Four honest verdicts:
 *
 *   works        the bytes arrived and route to the advertised action
 *   undecoded    the bytes arrived in a form MUON does not understand
 *   swallowed    nothing arrived — the terminal, the OS or a multiplexer took it
 *   misrouted    the bytes decode, but to a different action
 *
 * "Advertised-but-inert is a P0 bug" is the founder's law. This is the law
 * made checkable on the machine where it actually matters — the user's.
 */

import { KEYMAP, DESK_PREFIX, type KeymapEntry } from "./keymap.js";
import { normalizeKeys } from "./normalize-keys.js";
import { KeyStreamReader } from "./key-stream.js";
import { routeKey, type ShellScope } from "./keys.js";

const ESC = String.fromCodePoint(0x1b);

/**
 * The wait for ONE keystroke.
 *
 * Generous on purpose. The cost of waiting too long is a slow run; the cost of
 * waiting too little is a FALSE "swallowed" verdict, which sends someone
 * hunting a bug that is not there — and this tool exists precisely because a
 * measurement that confirms the wrong thing is worse than no measurement.
 */
const DEFAULT_PER_KEY_MS = 15_000;

/** The desk's own negotiation, so the doctor sees what the desk would see. */
const REQUEST_KITTY = `${ESC}[>7u`;
const QUERY_KITTY = `${ESC}[?u`;
const QUERY_DA = `${ESC}[c`;
const RELEASE_KITTY = `${ESC}[<u`;

export type KeyVerdict = {
  readonly key: string;
  readonly action: string;
  /** Raw bytes the terminal produced, hex, empty when nothing arrived. */
  readonly received: string;
  readonly outcome: "works" | "undecoded" | "swallowed" | "misrouted";
  readonly note: string;
};

export type KeysDoctorReport = {
  /** What the terminal said when asked for the kitty keyboard protocol. */
  readonly protocol: "kitty" | "legacy" | "unknown";
  readonly protocolDetail: string;
  readonly term: string;
  readonly verdicts: readonly KeyVerdict[];
};

/**
 * The chords a human can be asked to press, in the order `?` lists them.
 *
 * PREFIX entries are asked as the two-keystroke gesture they really are: the
 * prefix, then the letter. Asking for the letter alone would test a scope that
 * does not exist on its own and would report a false failure.
 */
export function advertisedChords(): KeymapEntry[] {
  return KEYMAP.filter(
    (entry) => entry.scope === "always" || entry.scope === "prefix"
  );
}

/** The scope a doctor run evaluates against: a live pane, nothing revealed. */
function doctorScope(prefixArmed: boolean): ShellScope {
  return {
    reviewOpen: false,
    reviewApprovable: false,
    reviewResolving: false,
    memoryOpen: false,
    memoryBusy: false,
    helpOpen: false,
    navOpen: false,
    spawnMenuOpen: false,
    crewOpen: false,
    timelineOpen: false,
    settingsOpen: false,
    sidebarOpen: false,
    inboxFocused: false,
    inboxHasRows: false,
    livePane: true,
    governedOpen: false,
    corpseOnScreen: false,
    prefixArmed,
    composerOpen: false,
    composerBusy: false,
  };
}

/**
 * Judge ONE recorded keystroke. Pure, so the classification is testable
 * without a terminal — which is the whole lesson of the probe that lied.
 */
export function judge(entry: KeymapEntry, received: string): KeyVerdict {
  const base = { key: entry.key, action: entry.action, received: hex(received) };
  if (received === "") {
    return {
      ...base,
      outcome: "swallowed",
      note: "nothing reached MUON — your terminal, your OS or a multiplexer took this chord before it arrived",
    };
  }

  const decoded = normalizeKeys(received);

  // THE KEYMAP'S OWN `match` LIST IS THE TRUTH, not a second opinion about
  // what these bytes mean. If the decoded input is not one of the byte
  // sequences this entry claims, then whatever arrived is a different key —
  // which is a real and useful thing to report, and the only way to catch a
  // terminal that has remapped one chord onto another.
  if (!entry.match.includes(decoded)) {
    const elsewhere = routeKey(decoded, doctorScope(entry.scope === "prefix"));
    return {
      ...base,
      outcome: elsewhere.kind === "to-child" ? "undecoded" : "misrouted",
      note:
        elsewhere.kind === "to-child"
          ? `MUON does not recognise these bytes and would send them to the terminal in the pane. Decoded to ${hex(decoded)}.`
          : `these bytes are a different key — they resolve to '${elsewhere.kind}'`,
    };
  }

  // The right bytes arrived. The remaining question is the law's: does the
  // chord this desk ADVERTISES actually do something in the scope it claims?
  const intent = routeKey(decoded, doctorScope(entry.scope === "prefix"));
  if (intent.kind === "none" || intent.kind === "to-child") {
    return {
      ...base,
      outcome: "misrouted",
      note: `the bytes arrive correctly but resolve to '${intent.kind}' — advertised and inert`,
    };
  }
  return { ...base, outcome: "works", note: "" };
}

function hex(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

/** The one rendering, so `--json` and the printed table cannot disagree. */
export function describeReport(report: KeysDoctorReport): string {
  const lines: string[] = [
    `terminal: ${report.term || "(TERM unset)"} · keyboard protocol: ${report.protocol}`,
    `  ${report.protocolDetail}`,
    "",
  ];
  const broken = report.verdicts.filter((v) => v.outcome !== "works");
  for (const verdict of report.verdicts) {
    const mark =
      verdict.outcome === "works"
        ? "ok  "
        : verdict.outcome === "swallowed"
          ? "GONE"
          : verdict.outcome === "undecoded"
            ? "RAW "
            : "WRONG";
    lines.push(`  ${mark} ${verdict.key.padEnd(12)} ${verdict.action}`);
    if (verdict.note) lines.push(`       ${verdict.note}`);
  }
  lines.push("");
  if (broken.length === 0) {
    lines.push(
      `every advertised chord works on this terminal (${report.verdicts.length} checked).`
    );
  } else {
    lines.push(
      `${broken.length} of ${report.verdicts.length} advertised chord(s) do NOT work here:`
    );
    for (const verdict of broken) {
      // THE BYTES, ALWAYS. The closing line promises this output is enough to
      // write a decoder case from — and the first real run shipped a failure
      // whose bytes appeared nowhere, so the promise was false and the next
      // step was another round trip. `sent nothing` is itself the datum when
      // the chord was swallowed.
      const raw = verdict.received === "" ? "sent nothing" : `0x${verdict.received}`;
      lines.push(`  ${verdict.key} — ${verdict.outcome} — ${raw}`);
    }
    lines.push(
      "",
      "A chord MUON advertises and cannot receive is a bug in MUON, not in you.",
      "Send this output (or `--json`) and it becomes a decoder case with a test."
    );
  }
  return lines.join("\n");
}

/** Read the terminal's answer to the protocol query. Bounded, never hangs. */
async function negotiate(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  waitMs: number
): Promise<{ protocol: KeysDoctorReport["protocol"]; detail: string }> {
  let answer = "";
  const onData = (chunk: Buffer) => {
    answer += chunk.toString("utf8");
  };
  stdin.on("data", onData);
  stdout.write(`${REQUEST_KITTY}${QUERY_KITTY}${QUERY_DA}`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  stdin.off("data", onData);

  if (answer.includes(`${ESC}[?`) && answer.includes("u")) {
    const flags = /\[\?(\d+)u/.exec(answer)?.[1] ?? "?";
    return {
      protocol: "kitty",
      detail: `your terminal granted the kitty keyboard protocol (flags ${flags}), so chords arrive as CSI-u sequences rather than control bytes`,
    };
  }
  if (answer.length > 0) {
    return {
      protocol: "legacy",
      detail:
        "your terminal answered the device query but declined the kitty keyboard protocol — chords arrive as legacy control bytes",
    };
  }
  return {
    protocol: "unknown",
    detail:
      "your terminal answered nothing at all; MUON will assume legacy control bytes",
  };
}

/**
 * What to ask the human to press.
 *
 * The keymap already spells a prefix chord as the WHOLE gesture ("ctrl+b s"),
 * so prepending "ctrl+b then" printed `ctrl+b then ctrl+b s` and instructed
 * people to press the prefix twice. The doctor then judged that second ctrl+b —
 * correctly — as a different action and reported `misrouted`, which reads as
 * "your terminal is broken" for a chord nobody had tested yet. A measurement
 * tool that mis-states the input it wants does not measure anything.
 */
export function promptGesture(entry: { key: string; scope: string }): string {
  if (entry.scope !== "prefix") return entry.key;
  return entry.key.replace(/^(\S+)\s+/, "$1 then ");
}

/**
 * `--wait <seconds>` — let a human buy more time per keystroke.
 *
 * Pure and exported so the bound is TESTED rather than trusted: a
 * silently-ignored bad flag would hand someone a fast run they did not ask for
 * and a swallowed verdict they cannot explain, so anything unparseable is an
 * error rather than a fallback to the default.
 */
export function parseWaitFlag(argv: string[]): {
  perKeyMs?: number;
  error?: string;
} {
  const at = argv.findIndex((arg) => arg === "--wait" || arg.startsWith("--wait="));
  if (at === -1) return {};
  const raw = argv[at]!.startsWith("--wait=")
    ? argv[at]!.slice("--wait=".length)
    : argv[at + 1];
  const seconds = Number(raw);
  if (!raw || !Number.isFinite(seconds) || seconds <= 0) {
    return { error: `--wait needs a positive number of seconds (got ${raw ?? "nothing"})` };
  }
  // No upper clamp. A human who wants a minute per key is measuring something
  // real — a flaky chord, or a keyboard layer that needs a deliberate hand.
  return { perKeyMs: Math.round(seconds * 1000) };
}

/** Run the interactive doctor against a real tty. */
export async function runKeysDoctor(io: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /**
   * How long to wait for each KEYSTROKE before calling the chord swallowed.
   *
   * Per keystroke, not per chord: a prefix gesture is two presses, and the
   * window restarts after the prefix lands. Four seconds for the whole gesture
   * meant hurrying `ctrl+b` and the letter into one budget, and a human who
   * paused half a second too long got a "swallowed" verdict for a chord that
   * works — the doctor lying in the same direction as the probe it replaced.
   */
  perKeyMs?: number;
  negotiateMs?: number;
}): Promise<KeysDoctorReport> {
  const { stdin, stdout } = io;
  const perKeyMs = io.perKeyMs ?? DEFAULT_PER_KEY_MS;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const negotiated = await negotiate(stdin, stdout, io.negotiateMs ?? 300);
  const chords = advertisedChords();
  const verdicts: KeyVerdict[] = [];

  stdout.write(
    `\r\nMUON key doctor — press each chord as it is named.\r\n` +
      `Nothing you press is sent anywhere; this only measures your terminal.\r\n` +
      `You have ${Math.round(perKeyMs / 1000)}s per keystroke — take your time. ` +
      `Waiting it out records the chord as SWALLOWED, which is a real answer.\r\n` +
      `Press ctrl+c at any time to stop.\r\n\r\n`
  );

  for (const entry of chords) {
    const gesture = promptGesture(entry);
    stdout.write(`  press ${gesture} … `);
    const received = await captureOne(stdin, perKeyMs, entry.scope === "prefix");
    // ctrl+c aborts the run rather than being recorded as a chord.
    if (received === String.fromCodePoint(3)) {
      stdout.write("stopped.\r\n");
      break;
    }
    const verdict = judge(entry, received);
    verdicts.push(verdict);
    stdout.write(`${verdict.outcome}\r\n`);
  }

  stdout.write(RELEASE_KITTY);
  stdin.setRawMode?.(false);
  stdin.pause();

  return {
    protocol: negotiated.protocol,
    protocolDetail: negotiated.detail,
    term: process.env.TERM ?? "",
    verdicts,
  };
}

/**
 * Capture ONE chord.
 *
 * A prefix gesture is two keystrokes, and only the SECOND is the chord under
 * test — the first is `ctrl+b`, which has its own row. Waiting for two and
 * reporting the second is what makes the verdict about the key the human was
 * asked for.
 *
 * Key RELEASES are dropped: with event reporting on, every press has one, and
 * recording it would classify the release rather than the press.
 */
/**
 * Exported for the timing test. The window policy is the part of this tool
 * most able to produce a CONFIDENT WRONG answer, so it is tested directly
 * rather than through a full interactive run.
 */
export async function captureOne(
  stdin: NodeJS.ReadStream,
  waitMs: number,
  afterPrefix: boolean
): Promise<string> {
  return new Promise((resolve) => {
    // THE DOCTOR MUST READ THE WAY THE DESK READS. A terminal splits its reads
    // wherever the pipe was full, so `ESC[98;5u` can arrive as `ESC[98;` then
    // `5u`. The desk reassembles those (key-stream.ts); this did not, so it
    // would report a chord the desk handles perfectly as `undecoded` or
    // `swallowed` — a diagnostic wrong about exactly the terminal behaviour it
    // exists to investigate.
    const stream = new KeyStreamReader((data) => onKeystroke(data), {
      escDelayMs: Math.min(25, waitMs),
    });
    let sawPrefix = !afterPrefix;
    let timer: NodeJS.Timeout;
    const done = (value: string) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      resolve(value);
    };
    // THE WINDOW RESTARTS AFTER THE PREFIX. A prefix gesture is two presses,
    // and giving both of them one shared budget punished a human who paused
    // between them with a "swallowed" verdict for a chord that works.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => done(""), waitMs);
    };
    const onData = (chunk: string) => stream.push(chunk);
    const onKeystroke = (chunk: string) => {
      if (chunk === String.fromCodePoint(3)) return done(chunk);
      // A chunk carrying ONLY key releases is not a press — keep waiting. The
      // old test looked for ":3" anywhere in the chunk, so a press and its
      // release arriving in one read discarded the press too, turning a
      // working chord into a swallowed one. The decoder already strips
      // releases; if nothing survives, nothing was pressed.
      if (normalizeKeys(chunk) === "") return;
      // Accept the prefix in whatever form this terminal sends it, and give the
      // next keystroke a fresh window. A REPEAT of the prefix re-arms rather
      // than being recorded as the answer: a human who fumbles the gesture and
      // starts over means "restart", and taking their second ctrl+b as the
      // chord produced a `misrouted` verdict that read as a terminal fault.
      // Safe because no prefix chord's second key is itself the prefix — the
      // suite asserts that, so this stays true if the keymap changes.
      if (afterPrefix) {
        const decoded = normalizeKeys(chunk);
        // A COALESCED READ IS STILL TWO KEYSTROKES. `ctrl+b` and its command
        // key are typed a fraction of a second apart, so the terminal often
        // hands both over in one read as `\x02s`. Treating a read as exactly
        // one key meant the prefix went unrecognised, the command key was
        // never recorded, and a chord that WORKS was reported as swallowed —
        // the doctor's one job, failed in its most misleading direction.
        if (decoded.startsWith(DESK_PREFIX) && decoded.length > DESK_PREFIX.length) {
          return done(decoded.slice(DESK_PREFIX.length));
        }
        // The prefix alone: arm, and give the command key a fresh window. This
        // also covers a REPEAT — a human who fumbles and starts the gesture
        // over means "restart", not "the answer is ctrl+b".
        if (decoded === DESK_PREFIX) {
          sawPrefix = true;
          arm();
          return;
        }
        // A stray key before the prefix is not the answer to a prefix chord.
        if (!sawPrefix) return;
      }
      done(chunk);
    };
    arm();
    stdin.on("data", onData);
  });
}

