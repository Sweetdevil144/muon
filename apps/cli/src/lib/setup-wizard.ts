import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  INSTALLABLE_VENDORS,
  readVendorEntry,
  vendorHoldsCoordinatorSeat,
  type InstallableVendorSpec,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";
import { readEnrolment } from "@muon/client/enrolment";
import { readIdentityCredential } from "@muon/client/github-identity-gate";
import {
  attachedCoordinatorCapabilityFilePath,
  readAttachedCoordinatorCapabilityFile,
} from "@muon/client/attached-coordinator-capability";
import { resolveDataDir } from "@muon/client/paths";

/**
 * THE RESUMABLE SETUP WIZARD (founder, 2026-08-20): one guided flow —
 * sign in → choose agent CLIs → install into them → optional coordinator
 * seat — that a person can quit at any point and re-run without losing a
 * completed step.
 *
 * RESUME IS DERIVED FROM REALITY, NOT FROM A STORED CURSOR. Every step has a
 * PROBE that reads the artifact the step exists to produce (the credential
 * file, the enrolment record, the vendor configs, the attach capability
 * file). A re-run starts at the first step whose artifact is missing — so a
 * completed step stays completed by construction, and a cursor can never
 * claim a step the world contradicts. The ONE thing reality cannot answer is
 * a deliberate "no": skipping the optional attach step is a choice, not an
 * artifact, so it alone is journaled (`setup-progress.json`) — and even that
 * journal only suppresses a nag, it never suppresses a step whose artifact
 * is missing when the user asks for it with `--attach`.
 */

export type SetupStepId = "login" | "choose" | "install" | "attach";

export type SetupStepState =
  | { readonly kind: "satisfied"; readonly detail: string }
  | { readonly kind: "pending"; readonly detail: string }
  | { readonly kind: "skipped"; readonly detail: string };

export type SetupProbeInput = {
  readonly io: McpVendorIo;
  readonly dataDir: string;
};

/** The journal for choices reality cannot express. Deliberately tiny. */
export type SetupProgress = {
  readonly version: 1;
  /** The user chose "skip" on the optional attach step. */
  readonly attachSkipped?: boolean;
};

export function setupProgressFilePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, "setup-progress.json");
}

export function readSetupProgress(dataDir: string = resolveDataDir()): SetupProgress {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(setupProgressFilePath(dataDir), "utf8")
    ) as SetupProgress;
    return parsed && parsed.version === 1 ? parsed : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

export function writeSetupProgress(
  progress: SetupProgress,
  dataDir: string = resolveDataDir()
): void {
  // Atomic for the same reason the enrolment writer is: a half-written journal
  // is exactly the state the next run would resume FROM.
  const target = setupProgressFilePath(dataDir);
  const temporary = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** Step 1 probe: a stored, readable identity credential. */
export function probeLogin(input: SetupProbeInput): SetupStepState {
  const read = readIdentityCredential(input.dataDir);
  return read.ok
    ? {
        kind: "satisfied",
        detail: `signed in as ${read.credential.github.login}`,
      }
    : { kind: "pending", detail: "not signed in on this machine" };
}

/** Step 2 probe: the enrolment record — the human's answer to "which CLIs". */
export function probeChoice(input: SetupProbeInput): SetupStepState {
  const stored = readEnrolment(input.dataDir);
  if (!stored.ok) {
    return {
      kind: "pending",
      detail:
        stored.reason === "absent"
          ? "no agent CLIs chosen yet"
          : `the recorded choice could not be read (${stored.detail})`,
    };
  }
  return stored.enrolment.vendors.length === 0
    ? { kind: "pending", detail: "the recorded choice names no CLI" }
    : {
        kind: "satisfied",
        detail: `chosen: ${stored.enrolment.vendors
          .map((vendor) => vendor.id)
          .join(", ")}`,
      };
}

/**
 * Step 3 probe: every ENROLLED vendor actually holds a registration. Probed
 * against the vendor's own config file — the artifact — never against the
 * outcome of a previous run.
 */
export function probeInstall(input: SetupProbeInput): SetupStepState {
  const stored = readEnrolment(input.dataDir);
  if (!stored.ok || stored.enrolment.vendors.length === 0) {
    return { kind: "pending", detail: "waiting on the CLI choice" };
  }
  const missing: string[] = [];
  for (const vendor of stored.enrolment.vendors) {
    const spec = INSTALLABLE_VENDORS.find(
      (candidate) => candidate.id === vendor.id
    );
    if (!spec) continue;
    const entry = readVendorEntry(spec, spec.defaultScope, input.io.roots);
    if (entry.kind !== "present") missing.push(vendor.id);
  }
  return missing.length === 0
    ? { kind: "satisfied", detail: "every chosen CLI holds a registration" }
    : { kind: "pending", detail: `not yet installed into: ${missing.join(", ")}` };
}

/**
 * Step 4 probe: an attach capability file for ANY seat-holding vendor. The
 * journal's `attachSkipped` reads as skipped — a deliberate "no" must not nag
 * on every re-run — but only when no seat exists; a real seat outranks it.
 */
export function probeAttach(input: SetupProbeInput): SetupStepState {
  for (const spec of INSTALLABLE_VENDORS) {
    if (!vendorHoldsCoordinatorSeat(spec.id)) continue;
    const file = attachedCoordinatorCapabilityFilePath(spec.id, input.dataDir);
    if (!fs.existsSync(file)) continue;
    // FAIL-CLOSED, like every other consumer of this file: a seat is a
    // session-scoped LEASE, and `existsSync` alone read a leftover, expired
    // or malformed file as "attached" — the wizard then skipped the step and
    // the recap reported a seat that no longer exists.
    const read = readAttachedCoordinatorCapabilityFile(file);
    if (read.ok) {
      return { kind: "satisfied", detail: `coordinator seat attached (${spec.id})` };
    }
  }
  if (readSetupProgress(input.dataDir).attachSkipped) {
    return { kind: "skipped", detail: "skipped by choice (re-run with --attach to add one)" };
  }
  return { kind: "pending", detail: "no coordinator seat attached" };
}

export type SetupPlanStep = {
  readonly id: SetupStepId;
  readonly title: string;
  readonly state: SetupStepState;
};

/** The whole plan, probed fresh. This is what "resumable" is made of. */
export function probeSetupPlan(input: SetupProbeInput): SetupPlanStep[] {
  return [
    { id: "login", title: "GitHub sign-in", state: probeLogin(input) },
    { id: "choose", title: "Choose your agent CLIs", state: probeChoice(input) },
    { id: "install", title: "Install MUON into them", state: probeInstall(input) },
    { id: "attach", title: "Coordinator seat (optional)", state: probeAttach(input) },
  ];
}

// ---------------------------------------------------------------------------
// Prompts — dependency-free, injectable for tests, and honest about non-TTY.
// ---------------------------------------------------------------------------

export type SetupPrompter = {
  /** Free-form line; returns "" on EOF. */
  readonly ask: (question: string) => Promise<string>;
  readonly isInteractive: boolean;
};

export function defaultPrompter(
  // Injectable ONLY so a test can drive the real readline path over a real
  // stream — the fake-prompter tests proved they cannot catch a bug here.
  streams: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {}
): SetupPrompter {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const interactive =
    Boolean((input as NodeJS.ReadStream).isTTY) &&
    Boolean((output as NodeJS.WriteStream).isTTY);
  return {
    isInteractive: interactive,
    ask: (question: string) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({
          input,
          output,
        });
        // SETTLED ONCE, answer first. The first version resolved "" from the
        // 'close' handler unconditionally — and close can beat the question
        // callback, so EVERY typed answer resolved as the default: the vendor
        // multi-select ignored what was typed, and the two y/N prompts were
        // unanswerable. The fake test prompter hid it; caught by review
        // running the real code on a real stdin. 'close' now only stands in
        // for EOF (ctrl-D) — an answer that already settled wins.
        let settled = false;
        const settle = (value: string) => {
          if (settled) return;
          settled = true;
          resolve(value.trim());
        };
        rl.question(question, (answer) => {
          settle(answer);
          rl.close();
        });
        rl.on("close", () => settle(""));
      }),
  };
}

/** y/N with an explicit default — Enter takes the default, everything else is read. */
export async function confirm(
  prompter: SetupPrompter,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await prompter.ask(`${question} ${suffix} `)).toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/**
 * The CLI multi-select, without a dependency: a numbered list with the
 * detected vendors pre-selected; Enter takes the default, or the user types
 * numbers/ids (comma-separated). An id the machine does not have is allowed
 * WITH a warning — the config is written for a tool that will read it on
 * arrival — because refusing it outright turned "I'm installing codex right
 * after this" into an error.
 */
export async function chooseVendors(
  prompter: SetupPrompter,
  detected: readonly InstallableVendorSpec[],
  all: readonly InstallableVendorSpec[] = INSTALLABLE_VENDORS
): Promise<InstallableVendorSpec[]> {
  const lines = all.map((spec, index) => {
    const has = detected.some((candidate) => candidate.id === spec.id);
    return `  ${index + 1}. ${spec.id}${has ? "  (detected)" : "  (not detected on PATH)"}`;
  });
  const defaults = detected.length > 0 ? detected : [];
  process.stdout.write(`${lines.join("\n")}\n`);
  const defaultLabel =
    defaults.length > 0 ? defaults.map((spec) => spec.id).join(", ") : "none detected";
  const answer = await prompter.ask(
    `Which agent CLIs should hold MUON? Numbers or ids, comma-separated [${defaultLabel}]: `
  );
  if (answer === "") return [...defaults];
  const chosen: InstallableVendorSpec[] = [];
  for (const token of answer.split(",").map((piece) => piece.trim()).filter(Boolean)) {
    const byIndex = /^\d+$/.test(token) ? all[Number(token) - 1] : undefined;
    const byId = all.find(
      (spec) => spec.id === token || spec.aliases?.includes(token)
    );
    const spec = byIndex ?? byId;
    if (!spec) {
      throw new Error(
        `'${token}' is not an agent CLI MUON can install into (expected one of: ${all
          .map((candidate) => candidate.id)
          .join(", ")}).`
      );
    }
    if (!chosen.includes(spec)) chosen.push(spec);
  }
  return chosen;
}

/** One rendered line per step — the wizard's recap and the resume banner. */
export function renderPlan(plan: readonly SetupPlanStep[]): string {
  return plan
    .map((step, index) => {
      const mark =
        step.state.kind === "satisfied"
          ? "✓"
          : step.state.kind === "skipped"
            ? "·"
            : "○";
      return `  ${mark} [${index + 1}/${plan.length}] ${step.title} — ${step.state.detail}`;
    })
    .join("\n");
}
