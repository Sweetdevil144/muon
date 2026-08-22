/**
 * The device-flow moment, done the way `gh auth login` does it (founder
 * request, 2026-08-19): copy the one-time code to the clipboard, say so, and
 * offer "press Enter to open github.com" — instead of printing a URL and a
 * code and leaving the transcription to the human.
 *
 * Everything here is BEST-EFFORT CONVENIENCE around a flow that already works:
 * a machine with no clipboard tool, no browser, or no TTY gets exactly the old
 * behavior (code + URL printed, polling proceeds). Nothing in this file may
 * fail a sign-in — every helper resolves rather than throws.
 *
 * Shared by `muon login` (the durable identity gate sign-in) and
 * `muon github login` (the live-brain connection): one presenter, so the two
 * flows cannot drift apart in feel.
 */
import { spawn } from "node:child_process";

type ClipboardCandidate = { readonly command: string; readonly args: readonly string[] };

/**
 * Which clipboard writers to try, in order, for a platform. A LIST, not a
 * single answer, because Linux genuinely has three ecosystems: Wayland
 * (wl-copy), X11 (xclip, xsel) — and a headless box has none, which is the
 * empty-handed case the caller's fallback copy handles.
 */
export function clipboardCandidates(
  platform: string = process.platform
): readonly ClipboardCandidate[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/** Pipe `text` into one clipboard candidate. Resolves false on ANY failure —
 *  a missing binary (ENOENT) is the ordinary case, not an error. */
function tryClipboardWrite(
  candidate: ClipboardCandidate,
  text: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(candidate.command, [...candidate.args], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
      child.stdin?.on("error", () => done(false));
      child.stdin?.end(text);
      // A clipboard write is instantaneous; anything still running after 3s is
      // wedged (e.g. xclip with no display server holding the pipe open).
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        done(false);
      }, 3_000).unref();
    } catch {
      done(false);
    }
  });
}

/** Copy `text` to the system clipboard. True only when a writer accepted it. */
export async function copyToClipboard(
  text: string,
  platform: string = process.platform,
  tryWrite: (c: ClipboardCandidate, t: string) => Promise<boolean> = tryClipboardWrite
): Promise<boolean> {
  if (!text) return false;
  for (const candidate of clipboardCandidates(platform)) {
    if (await tryWrite(candidate, text)) return true;
  }
  return false;
}

/** Open `url` in the default browser. Detached: the sign-in must not wait on
 *  (or die with) the browser process. True when the opener spawned cleanly. */
export function openInBrowser(
  url: string,
  platform: string = process.platform
): Promise<boolean> {
  // Only ever called with a verification URI the brain validated, but the
  // guard costs nothing and keeps a shell-adjacent opener boring.
  if (!/^https:\/\//.test(url)) return Promise.resolve(false);
  const opener: ClipboardCandidate | null =
    platform === "darwin"
      ? { command: "open", args: [url] }
      : platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(opener.command, [...opener.args], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.on("error", () => done(false));
      child.unref();
      // `open`/`xdg-open` exit immediately after handing off; not waiting for
      // exit keeps a slow browser launch from delaying the poll loop.
      setTimeout(() => done(true), 150).unref();
    } catch {
      done(false);
    }
  });
}

/** How long the Enter prompt waits before the flow proceeds on its own.
 *  Bounded because "is a TTY" is not "a human is watching": a pty-driven
 *  session, `script`, or a detached tmux pane is a TTY nobody will press
 *  Enter in, and an unbounded wait there hangs a sign-in that used to start
 *  polling immediately. One minute is enough for a human reading the prompt
 *  and a rounding error against the code's own 15-minute expiry. */
export const ENTER_PROMPT_TIMEOUT_MS = 60_000;

/** Wait for one Enter on stdin (bounded), then release stdin so the process
 *  can exit normally when polling finishes. Resolves `true` when a keypress
 *  arrived, `false` on timeout — the caller skips the browser open on a
 *  timeout, because opening a browser in a session nobody is watching is
 *  worse than printing the URL. */
export function waitForEnter(
  input: NodeJS.ReadStream = process.stdin,
  timeoutMs: number = ENTER_PROMPT_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (pressed: boolean) => {
      if (timer) clearTimeout(timer);
      input.off("data", onData);
      input.pause();
      resolve(pressed);
    };
    const onData = () => finish(true);
    input.resume();
    input.on("data", onData);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

export type DeviceCodePresentation = {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
};

export type DeviceCodePresenterDeps = {
  readonly write?: (line: string) => void;
  readonly isTTY?: boolean;
  readonly copy?: typeof copyToClipboard;
  readonly open?: typeof openInBrowser;
  readonly waitEnter?: typeof waitForEnter;
};

/**
 * Present the device code and get the human to GitHub.
 *
 * TTY:      code copied → "Press Enter to open github.com in your browser…"
 *           → Enter → browser opens (or the URL is printed when it cannot).
 * Non-TTY:  exactly the old behavior — code + URL printed, nothing waits.
 *           A pipe cannot press Enter, and blocking a script on stdin forever
 *           would be strictly worse than the transcription it replaces.
 */
export async function presentDeviceCode(
  flow: DeviceCodePresentation,
  deps: DeviceCodePresenterDeps = {}
): Promise<void> {
  const write =
    deps.write ?? ((line: string) => process.stderr.write(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const copy = deps.copy ?? copyToClipboard;
  const open = deps.open ?? openInBrowser;
  const waitEnter = deps.waitEnter ?? waitForEnter;

  const copied = await copy(flow.userCode);
  write(
    copied
      ? `Your one-time code ${flow.userCode} is on your clipboard.\n`
      : `Your one-time code:\n\n    ${flow.userCode}\n\n`
  );

  if (!isTTY) {
    write(
      `Open ${flow.verificationUri} and enter the code.\n` +
        `Waiting for authorization (code expires ${flow.expiresAt})…\n`
    );
    return;
  }

  write(`Press Enter to open ${flow.verificationUri} in your browser…\n`);
  const pressed = await waitEnter();
  if (pressed) {
    const opened = await open(flow.verificationUri);
    if (!opened) {
      write(
        `Could not open a browser here — visit ${flow.verificationUri} yourself and enter the code.\n`
      );
    }
  } else {
    // Timed out: nobody is at this TTY. No browser is opened into a session
    // nobody is watching; the URL stands and polling proceeds.
    write(
      `No keypress — continuing without opening a browser. Visit ${flow.verificationUri} and enter the code.\n`
    );
  }
  write(`Waiting for authorization (code expires ${flow.expiresAt})…\n`);
}
