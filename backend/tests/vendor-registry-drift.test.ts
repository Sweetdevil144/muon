import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_VENDOR_KEYS,
  VENDOR_CAPABILITY_DESCRIPTORS,
  VENDOR_KEYS,
  VENDOR_LABELS,
  VENDOR_READINESS_PROBES,
  modelIdMatchesShape,
  validateModelForVendor,
} from "@muon/adapters";
import {
  ONBOARDING_VENDORS,
  ONBOARDING_VENDOR_LABELS,
  VENDOR_DISPATCH_ROLES,
  VENDOR_EXECUTION_MODES,
} from "@muon/client";
import {
  VENDOR_IDS,
  VENDOR_REGISTRY,
  capabilityVendorSchema,
  coordinatorVendorIds,
  dispatchableVendorIds,
  evaluatorSpecSchema,
  evaluatorVendorIds,
  VENDOR_ROUTING_POLICY,
  coordinatorPreference,
  fleetVendorIds,
  plannerVendorIds,
  publicVendorIds,
  vendorRoutingLines,
  terminalTakeoverVendorIds,
  vendorsWhere,
  type VendorId,
} from "@muon/protocol";

// Route modules pull in the Prisma client; stub it so this pure drift-lock
// test never touches a database.
vi.mock("../src/lib/db.js", () => ({ prisma: {} }));

import { COORDINATOR_VENDORS, FLEET_VENDORS } from "../src/routes/fleet.js";

/**
 * ADR-0022 Wave A7 — the drift-lock.
 *
 * Wave A lands the vendor registry as PURE DATA that nothing reads for
 * behaviour. This file is the point of the wave: it asserts the registry's
 * projections equal EVERY existing copy of a vendor set in the tree, so the
 * later waves that delete those copies are provably behaviour-preserving.
 *
 * Any disagreement this file surfaces is a bug in a COPY, to be fixed there —
 * never papered over by weakening an assertion here. The disagreements that
 * exist TODAY are named, dated and scoped in `KNOWN_DIVERGENCES` below, so this
 * lock still fails on any NEW one. Wave F (the Ollama→OpenCode swap) closed one
 * of the three outright and TRANSFERRED the other two to the new vendor; each
 * entry says which it is.
 *
 * WAVES C2/C3/C4 DELETED several of the copies this file was written against
 * (`BASE_DISPATCH_VENDORS`, the delegate vendor enum, both mcp `VENDORS`,
 * `ORCHESTRATOR_LANE_KEYS`'s literal, `COORDINATOR_VENDOR`/`COORDINATOR_NAME`,
 * `VENDOR_SESSION_RESUME`, and every `=== "claude-code"` capability branch).
 * A deleted copy does NOT retire its assertion — that would make "delete the
 * copy" the way to escape the lock. Each one became an
 * `expectRegistryProjection`: the declaration may no longer be a literal list of
 * vendor names, AND the file must still name the registry column it derives
 * from. A re-introduced enum fails the first half; a projection re-pointed at
 * the wrong column fails the second.
 *
 * WHY IT LIVES IN `backend/tests`: it must import protocol, client, adapters and
 * backend routes at once. Putting it inside `packages/protocol` would invert the
 * layering — protocol depends on nothing.
 *
 * WHY SOME COPIES ARE READ FROM SOURCE TEXT: several of them are module-private
 * (`const`, not `export const`) or live in a package this one cannot resolve
 * (`@muon/orchestrator`, `@muon/mcp`, `apps/desktop`). Exporting them purely to
 * be testable would change a production module's public surface for a test's
 * convenience, and adding a package edge to reach them is exactly what ADR-0022
 * §2 refuses to do. So the lock reads their literal out of the source file. The
 * extractor throws loudly if the declaration moves or is renamed — a rename is
 * a drift signal too, and a silent green here would defeat the whole file.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The disagreements that exist RIGHT NOW between the registry and a copy.
 *
 * Each is a real pre-existing bug with a named owner wave. They are encoded as
 * exact expectations rather than as a loosened assertion, so the copy still
 * cannot drift any FURTHER without failing.
 */
const KNOWN_DIVERGENCES = {
  /**
   * ADR-0022 §1.2(a) — CLOSED BY TODO 3.3, and the empty array is the proof.
   *
   * `VendorKey` was `"claude-code" | "codex" | "cursor" | "fake"`, a second
   * vendor enum that omitted the fourth managed lane, so `opencode` had no
   * `VENDOR_CAPABILITY_DESCRIPTORS` row and could not reach the model picker at
   * all. Wave F transferred this hole from `ollama` rather than closing it, and
   * argued the absence was a DELIBERATE POSTURE — which was true of the
   * catalogue and the action set, but was being enforced by the wrong mechanism:
   * a missing type member, which no test could distinguish from someone
   * forgetting to extend a union.
   *
   * `VendorKey` is now `VendorId` itself, so the descriptor table is total over
   * the registry, and the two refusals were repointed at the facts they claim:
   * `assertVendorHasModelCatalog` reads `entry.models !== null`, and the action
   * gate reads `descriptor.actions.length > 0`. Both still answer 400 for
   * opencode (see the two assertions at the end of this file), so the posture
   * survived the collapse — it is now stated rather than implied by an omission.
   */
  vendorKeyMissing: [] as const,
  /**
   * WAVE F — GENUINELY CLOSED, and the empty array is the proof.
   *
   * `AGENT_VENDORS` (packages/client/src/agent-preedit-context.ts) validates an
   * agent-supplied pre-edit context's vendor. It omitted `ollama`, so that
   * lane's workers had their context rejected as malformed. `opencode` was added
   * to it in this wave, so the copy now covers every registry id and this
   * assertion degenerates to "AGENT_VENDORS === VENDOR_IDS".
   *
   * Adding it grants NOTHING: the field is a shape check on data the agent
   * supplies about its own edit, not an authority gate. Left empty rather than
   * deleted so the assertion below keeps proving the two agree.
   */
  agentVendorsMissing: [] as const,
  /**
   * WAVE E — CLOSED, and the empty array is the proof.
   *
   * `capabilityVendorSchema` (packages/protocol/src/capability.ts) is the wire
   * enum for an ADR-0019 capability attestation. It named the original trio, so
   * across two vendor swaps the ids MISSING from it simply changed while the
   * hole stayed the same size. It is `vendorIdSchema` now.
   *
   * Widening it GRANTS NOTHING: an attestation is bound to its own manifest's
   * vendor and `finalizeCapabilityAttestation` throws on a mismatch, so naming a
   * vendor here only makes an attestation for that vendor expressible. Left
   * empty rather than deleted so the assertion below keeps proving the two
   * agree.
   */
  capabilityVendorMissing: [] as const,
} as const;

// ─────────────────────────── source-literal reader ───────────────────────────

/** Strip comments so a `//` note inside a literal region is never scanned. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The balanced `[...]`/`{...}` initialiser of `const <name> = ...`, with a
 * `new Set(` wrapper unwrapped. Throws when the declaration is absent, which is
 * itself a drift signal — see the file header.
 */
function declarationBody(relativePath: string, constName: string): string {
  // Comments come out BEFORE the brace scan, not after. The scanner treats `'`
  // as opening a string, so an ordinary apostrophe in an explanatory comment
  // inside a tracked literal ("the operator's own shell") used to swallow the
  // rest of the file and throw "unbalanced literal" — a drift-lock that fails on
  // good prose teaches authors to write worse prose. Stripping first cannot hide
  // a declaration, because the regex below matches code, never a comment.
  const source = stripComments(readFileSync(`${REPO_ROOT}${relativePath}`, "utf8"));
  // `[^=]*?` spans a multi-line type annotation but can never cross into the
  // NEXT declaration, because reaching one would require passing its `=`.
  const declaration = new RegExp(
    `\\bconst\\s+${constName}\\b[^=]*?=\\s*`
  ).exec(source);
  if (!declaration) {
    throw new Error(
      `vendor drift-lock: '${constName}' no longer declared in ${relativePath}. ` +
        "If it moved or was renamed, update this lock rather than deleting the assertion."
    );
  }
  let cursor = declaration.index + declaration[0].length;
  const setWrapper = /^new\s+Set\s*(?:<[^>]*>)?\s*\(\s*/.exec(source.slice(cursor));
  if (setWrapper) {
    cursor += setWrapper[0].length;
  }
  const open = source[cursor];
  if (open !== "[" && open !== "{") {
    throw new Error(
      `vendor drift-lock: '${constName}' in ${relativePath} is no longer an array/object literal.`
    );
  }
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let quote: string | undefined;
  for (let index = cursor; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(cursor + 1, index);
      }
    }
  }
  throw new Error(
    `vendor drift-lock: unbalanced literal for '${constName}' in ${relativePath}.`
  );
}

/** Every string literal in a declaration's body, in order. */
function sourceStringList(relativePath: string, constName: string): string[] {
  const body = stripComments(declarationBody(relativePath, constName));
  return [...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (match) => match[1] ?? match[2] ?? ""
  );
}

/** A `{ key: [ "a", "b" ] }` (or `key: new Set([...])`) table, as a record. */
function sourceStringRecord(
  relativePath: string,
  constName: string
): Record<string, string[]> {
  const body = stripComments(declarationBody(relativePath, constName));
  const entries = body.matchAll(
    /(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*(?:new\s+Set\s*\(\s*)?\[([^\]]*)\]/g
  );
  const table: Record<string, string[]> = {};
  for (const entry of entries) {
    const key = entry[1] ?? entry[2] ?? entry[3]!;
    table[key] = [...entry[4]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
      (value) => value[1] ?? value[2] ?? ""
    );
  }
  return table;
}

/** The TOP-LEVEL keys of a `{ key: … }` declaration, in order. */
function sourceObjectKeys(relativePath: string, constName: string): string[] {
  const body = stripComments(declarationBody(relativePath, constName));
  const keys: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let token = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      token = "";
      continue;
    }
    if (char === "[" || char === "{" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "]" || char === "}" || char === ")") {
      depth -= 1;
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (char === ":") {
      const key = token.trim();
      if (key) {
        keys.push(key);
      }
      token = "";
      continue;
    }
    if (char === ",") {
      token = "";
      continue;
    }
    token += char;
  }
  return keys;
}

/** Ids from the registry that satisfy a positive predicate, as plain strings. */
const ids = (list: readonly VendorId[]): string[] => [...list];

/**
 * A file's source with comments stripped. Every NEGATIVE assertion below runs
 * against this: the comments at the swapped sites deliberately QUOTE the branch
 * they replaced ("this used to read `this.id === \"claude-code\"`"), and a
 * lock that could not tell a quotation from a live branch would either fail on
 * good prose or force the prose to be vague.
 */
function sourceCode(relativePath: string): string {
  return stripComments(readFileSync(`${REPO_ROOT}${relativePath}`, "utf8"));
}

/**
 * WHERE THE VENDOR TAB TABLE ACTUALLY LIVES.
 *
 * It was `apps/desktop/src/lib/terminal-vendor-tabs.ts` until 2026-08-08, when
 * it moved into `@muon/client` so the TUI's vendor-tab layer and the desktop's
 * are the SAME code — numbering, labels, the spawn allowlist and the menu
 * builder cannot drift between surfaces. The desktop path is now a one-line
 * re-export shim.
 *
 * Four assertions in this file kept reading the shim and therefore threw
 * "'VENDOR_TERMINAL_COMMANDS' no longer declared", which is this lock working:
 * its own error text says to follow the declaration rather than delete the
 * assertion. Hoisted to a constant so the NEXT move is one line, and so a
 * silently-passing lock cannot be the way a table escapes it.
 */
const VENDOR_TAB_SOURCE = "packages/client/src/terminal-vendor-tabs.ts";

/**
 * A copy Wave C DELETED, replaced by a registry read.
 *
 * The lock does NOT stop guarding a surface once its copy is gone — that would
 * make deleting a copy the way to escape the lock. It changes what it guards:
 * the declaration must no longer be a literal LIST OF VENDOR NAMES (it may be a
 * projection call, or absent entirely), AND the file must still name the
 * registry predicate it now derives from. A re-introduced hand-written enum
 * fails the first assertion; a projection quietly re-pointed at the wrong column
 * fails the second.
 */
function expectRegistryProjection(
  relativePath: string,
  constName: string,
  derivedFrom: string
): void {
  let literal: string[] | undefined;
  try {
    literal = sourceStringList(relativePath, constName);
  } catch {
    // Absent, or no longer an array/object literal — both are the post-Wave-C
    // shape. `declarationBody` throws loudly for each.
    literal = undefined;
  }
  if (literal) {
    expect(
      literal.filter((value) => (VENDOR_IDS as readonly string[]).includes(value)),
      `${constName} in ${relativePath} is a hand-written vendor list again`
    ).toEqual([]);
  }
  expect(
    sourceCode(relativePath),
    `${relativePath} no longer derives from '${derivedFrom}'`
  ).toContain(derivedFrom);
}

const PUBLIC_DISPATCHABLE = ids(
  vendorsWhere(
    (entry) => entry.visibility === "public" && entry.authority.dispatchable
  )
);
const PUBLIC_DELEGATABLE = ids(
  vendorsWhere(
    (entry) => entry.visibility === "public" && entry.authority.delegatable
  )
);

describe("vendor registry drift-lock — the managed fleet", () => {
  it("backend FLEET_VENDORS === fleetVendorIds()", () => {
    expect([...FLEET_VENDORS]).toEqual(ids(fleetVendorIds()));
  });

  it("client ONBOARDING_VENDORS === fleetVendorIds()", () => {
    expect([...ONBOARDING_VENDORS]).toEqual(ids(fleetVendorIds()));
  });

  it("desktop FLEET_VENDORS is a projection of fleetVendorIds()", () => {
    // WAVE D: the desktop's third hand-written mirror of the fleet set is gone.
    expectRegistryProjection(
      "apps/desktop/src/lib/fleet.ts",
      "FLEET_VENDORS",
      "fleetVendorIds()"
    );
  });

  it("backend dispatch admission is a projection of authority.dispatchable", () => {
    // WAVE C2: `BASE_DISPATCH_VENDORS` is DELETED. `allowedDispatchVendors()`
    // now reads the registry, with the `fake` seam admitted by the SECOND,
    // independent condition — a LIVE `MUON_FAKE_VENDOR` read — which is why the
    // public slice below is still the right expectation for the enum shape.
    expectRegistryProjection(
      "backend/src/routes/dispatch.ts",
      "BASE_DISPATCH_VENDORS",
      "entry.authority.dispatchable"
    );
    expect(PUBLIC_DISPATCHABLE).toEqual([
      ...vendorsWhere(
        (entry) => entry.visibility === "public" && entry.authority.dispatchable
      ),
    ]);
  });

  it("backend delegate admission is a projection of authority.delegatable", () => {
    // WAVE C2 also closed the asymmetry ADR-0022 §1.1 names: the delegate
    // schema used to hardcode its own enum and OMITTED the `fake` seam that the
    // create route admits. Both routes now read the same registry column
    // through the same two-condition seam.
    expectRegistryProjection(
      "backend/src/routes/dispatch.ts",
      "delegateDispatchSchema",
      "entry.authority.delegatable"
    );
  });

  it("mcp orchestrator-tools VENDORS is a projection of authority.dispatchable", () => {
    expectRegistryProjection(
      "packages/mcp/src/orchestrator-tools.ts",
      "VENDORS",
      "entry.authority.dispatchable"
    );
  });

  it("mcp delegate-tools VENDORS is a projection of authority.delegatable", () => {
    expectRegistryProjection(
      "packages/mcp/src/delegate-tools.ts",
      "VENDORS",
      "entry.authority.delegatable"
    );
    expect(PUBLIC_DELEGATABLE).toEqual([
      ...vendorsWhere(
        (entry) => entry.visibility === "public" && entry.authority.delegatable
      ),
    ]);
  });
});

describe("vendor registry drift-lock — the coordinator seat", () => {
  it("backend COORDINATOR_VENDORS === coordinatorVendorIds()", () => {
    expect([...COORDINATOR_VENDORS]).toEqual(ids(coordinatorVendorIds()));
  });

  it("orchestrator ORCHESTRATOR_LANE_KEYS is a projection of coordinatorVendorIds()", () => {
    // WAVE C3: the copy is gone; the constant IS the projection. Its default
    // (`CHAT_LANE_KEY`) is the head of that list rather than a fourth spelling
    // of `claude-code`.
    expectRegistryProjection(
      "packages/orchestrator/src/chat.ts",
      "ORCHESTRATOR_LANE_KEYS",
      "coordinatorVendorIds()"
    );
    // WAVE E: the head is now the OPERATOR preference, intersected with that
    // same projection — so it can be reordered but never widened.
    expectRegistryProjection(
      "packages/orchestrator/src/chat.ts",
      "CHAT_LANE_KEY",
      "defaultCoordinatorVendor()"
    );
  });

  it("bootstrap seeds ordinal-0 seats from the projection, not from a literal", () => {
    // WAVE C3: `ensureCoordinatorAgent` iterates `COORDINATOR_VENDORS`, which is
    // now `coordinatorVendorIds()`. Seat CAPACITY (G4) follows the registry with
    // no second edit — the seat REFUSAL still lives in the role ceiling.
    const bootstrap = sourceCode("backend/src/lib/bootstrap.ts");
    expect(bootstrap).toContain("for (const vendor of COORDINATOR_VENDORS)");
    expectRegistryProjection(
      "backend/src/routes/fleet.ts",
      "COORDINATOR_VENDORS",
      "coordinatorVendorIds()"
    );
  });

  it("the dead coordinator constants are gone and stay gone", () => {
    // WAVE C3: `COORDINATOR_VENDOR` / `COORDINATOR_NAME` were exported and
    // referenced nowhere (ADR-0022 §1.1). A dead export that names ONE vendor is
    // how a per-vendor default gets resurrected by autocomplete, so the lock
    // keeps them deleted rather than trusting that nobody re-adds them.
    const source = sourceCode("backend/src/routes/fleet.ts");
    expect(source).not.toMatch(/\bCOORDINATOR_VENDOR\b(?!S)/);
    expect(source).not.toMatch(/\bCOORDINATOR_NAME\b/);
  });

  it("desktop ORCHESTRATOR_VENDORS is a projection of coordinatorVendorIds()", () => {
    // WAVE D. The Crew tab's two hardcoded <option>s went with it — the picker
    // maps over the same projection now (`sidebar.tsx`), so a vendor that earns
    // a seat appears in the UI without a second edit.
    expectRegistryProjection(
      "apps/desktop/src/lib/crew-config.ts",
      "ORCHESTRATOR_VENDORS",
      "coordinatorVendorIds()"
    );
    expect(sourceCode("apps/desktop/src/renderer/sidebar.tsx")).toContain(
      "coordinatorVendorIds()"
    );
  });

  it("backend PLANNER_LANE_PREFERENCE is coordinatorPreference() ∩ plannerVendorIds()", () => {
    // WAVE E: the literal is gone. It is the operator preference INTERSECTED
    // with the planner authority — intersected, never unioned, so an operator
    // naming an unauthorized vendor cannot thereby make it a planner.
    expectRegistryProjection(
      "backend/src/lib/workflow-planner.ts",
      "PLANNER_LANE_PREFERENCE",
      "plannerVendorIds()"
    );
    expect(sourceCode("backend/src/lib/workflow-planner.ts")).toContain(
      "coordinatorPreference()"
    );
    // …and the intersection still resolves to the planner set today.
    expect(
      coordinatorPreference().filter((vendor) =>
        plannerVendorIds().includes(vendor)
      )
    ).toEqual(ids(plannerVendorIds()));
  });

  it("a coordinator preference can NEVER grant a seat (ADR-0022 §4)", () => {
    // The intersection, asserted from the backend side too: this is the wiring
    // that would turn an operator settings file into an authority grant if it
    // were ever unioned.
    const ineligible = VENDOR_IDS.filter(
      (id) => !VENDOR_REGISTRY[id].authority.coordinatorSeat
    );
    expect(ineligible.length).toBeGreaterThan(0);
    expect([...coordinatorPreference(ineligible)]).toEqual(
      ids(coordinatorVendorIds())
    );
  });
});

describe("vendor registry drift-lock — the role ceiling", () => {
  it("client VENDOR_DISPATCH_ROLES covers exactly the public vendors", () => {
    expect(Object.keys(VENDOR_DISPATCH_ROLES).sort()).toEqual(
      ids(publicVendorIds()).sort()
    );
  });

  it("client VENDOR_DISPATCH_ROLES === authority.supportedRoles", () => {
    for (const [vendor, roles] of Object.entries(VENDOR_DISPATCH_ROLES)) {
      expect([...roles]).toEqual([
        ...VENDOR_REGISTRY[vendor as VendorId].authority.supportedRoles,
      ]);
    }
  });

  it("adapters VENDOR_READINESS_PROBES.dispatchRoles === authority.supportedRoles", () => {
    for (const probe of VENDOR_READINESS_PROBES) {
      expect([...probe.dispatchRoles]).toEqual([
        ...VENDOR_REGISTRY[probe.vendor as VendorId].authority.supportedRoles,
      ]);
    }
  });
});

describe("vendor registry drift-lock — execution and readiness", () => {
  it("client VENDOR_EXECUTION_MODES === execution.modes", () => {
    expect(Object.keys(VENDOR_EXECUTION_MODES).sort()).toEqual(
      ids(publicVendorIds()).sort()
    );
    for (const [vendor, modes] of Object.entries(VENDOR_EXECUTION_MODES)) {
      expect([...modes]).toEqual([
        ...VENDOR_REGISTRY[vendor as VendorId].execution.modes,
      ]);
    }
  });

  it("adapters VENDOR_READINESS_PROBES covers exactly the public vendors", () => {
    expect(VENDOR_READINESS_PROBES.map((probe) => probe.vendor)).toEqual(
      ids(publicVendorIds())
    );
  });

  it("adapters VENDOR_READINESS_PROBES === readiness", () => {
    for (const probe of VENDOR_READINESS_PROBES) {
      const entry = VENDOR_REGISTRY[probe.vendor as VendorId];
      expect(probe.displayName).toBe(entry.displayName);
      expect([...probe.installedCandidates]).toEqual([
        ...entry.readiness.installedCandidates,
      ]);
      expect([...probe.authCandidates]).toEqual([
        ...entry.readiness.authCandidates,
      ]);
      expect([...probe.authArgs]).toEqual([...entry.readiness.authArgs]);
      expect([...probe.versionArgs]).toEqual([...entry.readiness.versionArgs]);
      expect(probe.installHint).toBe(entry.readiness.installHint);
      // `{bin}` is the registry's placeholder for the probe's `(bin) => …`.
      const bin = probe.authCandidates[0] ?? "";
      expect(probe.loginHint(bin)).toBe(
        entry.readiness.loginHint.replaceAll("{bin}", bin)
      );
    }
  });

  it("adapters runtimeRequirement === execution.runtimeRequirement", () => {
    for (const probe of VENDOR_READINESS_PROBES) {
      const expected =
        VENDOR_REGISTRY[probe.vendor as VendorId].execution.runtimeRequirement;
      if (!expected) {
        expect(probe.runtimeRequirement).toBeUndefined();
        continue;
      }
      expect(probe.runtimeRequirement).toBeDefined();
      expect([...probe.runtimeRequirement!.candidates]).toEqual([
        ...expected.candidates,
      ]);
      expect(probe.runtimeRequirement!.detail).toBe(expected.detail);
      expect(probe.runtimeRequirement!.fixHint).toBe(expected.fixHint);
    }
  });

  it("desktop TERMINAL_COMMANDS === terminalTakeoverVendorIds()", () => {
    // A renderer-driven binary spawn (ADR-0022 G6). `shell` is the non-vendor
    // login-shell entry and is excluded by name, not by subtraction of a
    // vendor set — it never was one.
    //
    // WAVE C5: the vendor half moved into `VENDOR_TERMINAL_COMMANDS`, a TOTAL
    // `Record<VendorId, … | null>`, and `TERMINAL_COMMANDS` now spreads only the
    // takeover-authorized slice of it. The terminal-native wave then moved the
    // table itself into `terminal-vendor-tabs.ts` (renderer-safe) so the vendor
    // tab bar and the spawn host read ONE record — the lock follows the
    // declaration to its home. Three things must hold: the table must still
    // state an answer for EVERY vendor (a new one cannot slip in by omission),
    // the host must still gate on the authority column, and the spawn file
    // must not have regrown its own vendor table.
    const keys = sourceObjectKeys(
      "apps/desktop/src/lib/terminal-spawn.ts",
      "TERMINAL_COMMANDS"
    );
    expect(keys).toContain("shell");
    expect(keys.filter((key) => (VENDOR_IDS as readonly string[]).includes(key))).toEqual(
      []
    );
    expect(
      sourceObjectKeys(
        VENDOR_TAB_SOURCE,
        "VENDOR_TERMINAL_COMMANDS"
      )
    ).toEqual([...VENDOR_IDS]);
    expect(sourceCode("apps/desktop/src/lib/terminal-spawn.ts")).toContain(
      "terminalTakeoverVendorIds"
    );
    // The spawn file consumes the shared table rather than declaring a rival.
    expect(sourceCode("apps/desktop/src/lib/terminal-spawn.ts")).toContain(
      'from "./terminal-vendor-tabs.js"'
    );
    expect(sourceCode("apps/desktop/src/lib/terminal-spawn.ts")).not.toMatch(
      /\bconst\s+VENDOR_TERMINAL_COMMANDS\b/
    );
  });

  it("desktop terminal binaries are SPAWNABLE candidates, never merely installed", () => {
    // The cursor trap (ADR-0022 §6.7): the bare `cursor` IDE launcher counts as
    // INSTALLED and must never be spawned. A terminal command sourced from the
    // readiness list would spawn the IDE, so the lock reads the binaries out of
    // the desktop table and checks each against `execution.commandCandidates`.
    const body = sourceStringList(
      VENDOR_TAB_SOURCE,
      "VENDOR_TERMINAL_COMMANDS"
    );
    const binaries = body.filter(
      (value) => !(VENDOR_IDS as readonly string[]).includes(value)
    );
    expect(binaries.length).toBeGreaterThan(0);
    const spawnable = new Set(
      VENDOR_IDS.flatMap((id) => [
        ...VENDOR_REGISTRY[id].execution.commandCandidates,
      ])
    );
    for (const binary of binaries) {
      expect(spawnable, `${binary} is not a spawnable candidate`).toContain(
        binary
      );
    }
  });

  it("desktop vendor tab bar is a projection of terminalTakeoverVendorIds()", () => {
    // TERMINAL-NATIVE: the strip's vendor tab bar is a NEW enumeration surface
    // — a registry vendor missing from it is exactly the silent-omission drift
    // this file exists to catch. The picker must derive from the takeover
    // projection ∩ the total command table (both live in the registry's
    // orbit), never from a hand-written vendor list, and the renderer must
    // build its buttons from that one builder.
    const tabs = sourceCode(VENDOR_TAB_SOURCE);
    expect(tabs).toContain("terminalTakeoverVendorIds().filter");
    expect(tabs).toContain("spawnableTerminalVendorIds().map");
    expect(sourceCode("apps/desktop/src/renderer/app.tsx")).toContain(
      "buildTerminalVendorMenu("
    );
  });

  it("every terminalTakeover vendor APPEARS in the bar (grant ⇒ command)", () => {
    // The bar is takeover ∩ command-declared, so a takeover grant whose table
    // row is `null` would vanish from the UI silently — a registry statement
    // with no surface. Hold the conjunction: a future vendor flipped to
    // `terminalTakeover: true` must declare its interactive command in the
    // same change, or this fails.
    const body = stripComments(
      declarationBody(
        VENDOR_TAB_SOURCE,
        "VENDOR_TERMINAL_COMMANDS"
      )
    );
    for (const id of terminalTakeoverVendorIds()) {
      expect(
        new RegExp(`(?:"${id}"|'${id}'|\\b${id})\\s*:\\s*null`).test(body),
        `${id} has terminalTakeover but a null terminal command — it would silently miss the vendor bar`
      ).toBe(false);
    }
  });

  it("the attach-label namespace and the registry keyspace stay DISJOINT (ADR-0022 §8)", () => {
    // The hazard that kept opencode's takeover false for a slice: the SAME id
    // living in the desktop's attach-label table AND the registry would let
    // the two namespaces merge by accident (an attach-only label acquiring a
    // spawn affordance, or a registry lane mislabelled by the attach table).
    // Wave F resolved the one collision by removing `opencode` from the
    // attach table; this pins the resolution as an invariant — an id may live
    // in ONE keyspace, never both.
    const attachIds = sourceObjectKeys(
      "apps/desktop/src/renderer/session-workspace.tsx",
      "ATTACH_NAMESPACE_LABELS"
    );
    expect(attachIds.length).toBeGreaterThan(0);
    expect(
      attachIds.filter((id) => (VENDOR_IDS as readonly string[]).includes(id))
    ).toEqual([]);
  });
});

describe("vendor registry drift-lock — sessions", () => {
  it("the client resume hint is a projection of session.canResume", () => {
    // WAVE C4: `VENDOR_SESSION_RESUME` is DELETED. It was a hand-maintained
    // table carrying a "KEEP IN SYNC with the session drivers" comment, and a
    // vendor missing from it read as non-resumable by ACCIDENT rather than by
    // statement. Both call sites now ask the registry.
    for (const relativePath of [
      "packages/client/src/run-bundle.ts",
      "packages/client/src/run-resume.ts",
    ]) {
      const source = sourceCode(relativePath);
      expect(source).not.toContain("VENDOR_SESSION_RESUME");
      expect(source).toContain("sessionCapability(job.vendor).canResume");
    }
    // …and the column it now reads is still the one-vendor answer the deleted
    // table spelled out.
    expect(ids(vendorsWhere((entry) => entry.session.canResume))).toEqual([
      "claude-code",
    ]);
  });

  it("the chat-continuity binding is exactly the persistsSessionHandle set", () => {
    // WAVE C4: `backend/src/routes/chats.ts` and the three dispatch resume
    // equality checks used to hardcode `claude-code` (ADR-0022 G7); they now
    // read this column. The set itself is unchanged, which is the proof the
    // swap widened nothing.
    expect(
      ids(vendorsWhere((entry) => entry.session.persistsSessionHandle))
    ).toEqual(["claude-code"]);
    const chats = sourceCode("backend/src/routes/chats.ts");
    // A POSITIVE capability refine, never a bare widening to `vendorIdSchema`.
    expect(chats).toContain("session.persistsSessionHandle");
    expect(chats).not.toContain('z.enum(["claude-code"])');
  });

  it("the steer contract is a projection of session.canSend", () => {
    // WAVE C4 / G8: both `canSend` lookups read the ADAPTER descriptor table and
    // treated ABSENCE as steerable, so cursor/opencode/fake fell through. Both
    // now read the registry, where absence is `false` by construction.
    for (const [relativePath, expression] of [
      ["backend/src/routes/dispatch.ts", "!sessionCapability(controlled.vendor).canSend"],
      ["packages/runner/src/execute.ts", "sessionCapability(vendor).canSend"],
      ["apps/tui/src/lib/session-controller.ts", "sessionCapability(input.lane.key).canSend"],
    ] as const) {
      const source = sourceCode(relativePath);
      expect(source).toContain(expression);
      expect(source).not.toContain("sessionCaps.canSend === false");
    }
    expect(ids(vendorsWhere((entry) => entry.session.canSend))).toEqual([
      "codex",
    ]);
  });

  it("the interactive determination is ONE registry lookup, not two names", () => {
    // ADR-0022 §1.2(c): `kind === "auto" && (vendor === "claude-code" || vendor
    // === "codex")` was spelled in the runner AND in the dispatch route.
    for (const relativePath of [
      "packages/runner/src/execute.ts",
      "backend/src/routes/dispatch.ts",
    ]) {
      expect(sourceCode(relativePath)).toContain("vendorSupportsInteractive(");
    }
    expect(
      ids(vendorsWhere((entry) => entry.session.driver !== "none"))
    ).toEqual(["claude-code", "codex"]);
  });

  it("the strict-mcp-config guard is a projection of execution.guards", () => {
    // ADR-0022 §1.2(f) / G9: `this.id === "claude-code"` decided whether MUON's
    // own governed MCP server could be evicted.
    const source = sourceCode("packages/adapters/src/base-lane-adapter.ts");
    expect(source).toContain("execution.guards.strictMcpConfigFlag");
    expect(source).not.toContain('this.id === "claude-code"');
    expect(
      ids(vendorsWhere((entry) => entry.execution.guards.strictMcpConfigFlag))
    ).toEqual(["claude-code"]);
  });
});

describe("vendor registry drift-lock — evaluator lanes", () => {
  it("core EVALUATOR_LANES is a projection of evaluatorVendorIds()", () => {
    // WAVE E: the hand-written pair that had to agree with
    // `evaluatorSpecSchema` by hand is gone; both read the same column now.
    expectRegistryProjection(
      "packages/core/src/loop-evaluator.ts",
      "EVALUATOR_LANES",
      "evaluatorVendorIds()"
    );
  });

  it("protocol evaluatorSpecSchema.laneKey === evaluatorVendorIds()", () => {
    for (const id of VENDOR_IDS) {
      const accepted = evaluatorSpecSchema.safeParse({
        laneKey: id,
        criteria: "x",
      }).success;
      expect(accepted).toBe(
        VENDOR_REGISTRY[id].authority.evaluator
      );
    }
  });
});

describe("vendor registry drift-lock — credentials (BYO-auth blast radius)", () => {
  // WAVE C5 deleted all three copies below. Per the file header, a deleted copy
  // does not retire its assertion — it becomes an `expectRegistryProjection`, so
  // a re-introduced hand-written credential table fails just as loudly as a
  // drifted one. This is the G5 surface, where the failure mode is silent.
  it("adapters lane env keys are a projection of credentials.envKeys", () => {
    expectRegistryProjection(
      "packages/adapters/src/lane-runner.ts",
      "VENDOR_ENV_KEYS",
      "vendorCredentialEnvKeys"
    );
    expect(sourceCode("packages/adapters/src/lane-runner.ts")).toContain(
      "allVendorCredentialEnvKeys"
    );
  });

  it("adapters owned credential keys are a projection of credentials.ownedKeys", () => {
    expectRegistryProjection(
      "packages/adapters/src/provider-credentials.ts",
      "VENDOR_OWNED_CREDENTIAL_KEYS",
      "credentials.ownedKeys"
    );
  });

  it("adapters RUNNER_VENDOR_CREDENTIALS is a projection of credentials.forwardToRunner", () => {
    expectRegistryProjection(
      "packages/adapters/src/sandbox/launcher.ts",
      "RUNNER_VENDOR_CREDENTIALS",
      "credentials.forwardToRunner"
    );
  });

  it("the runner allowlist's vendor slice is the registry union, not a copy", () => {
    // `RUNNER_ENV_ALLOWLIST` is a mixed list (runtime discovery + vendor keys),
    // so it can never be asserted "contains no vendor name". What it must not
    // contain is a hand-written copy of the credential KEYS, which is what the
    // union spread replaced.
    const source = sourceCode("packages/adapters/src/sandbox/launcher.ts");
    expect(source).toContain("...allVendorCredentialEnvKeys()");
    for (const id of VENDOR_IDS) {
      for (const key of VENDOR_REGISTRY[id].credentials.envKeys) {
        expect(
          source,
          `${key} is spelled literally in launcher.ts again`
        ).not.toContain(`"${key}"`);
      }
    }
  });

  it("the profile compiler routes on execution.compiler, not on the lane id", () => {
    expect(
      sourceCode("packages/adapters/src/profile-compiler.ts")
    ).toContain("execution.compiler");
  });
});

describe("vendor registry drift-lock — routing prose is generated (Wave E)", () => {
  it("both routing surfaces render from the registry rather than naming vendors", () => {
    // ADR-0022 §1.2(i): these two statements DISAGREED, and the MCP one was
    // contradicted by the role ceiling. Neither may name a vendor by hand again.
    for (const relativePath of [
      "packages/mcp/src/orchestrator-tools.ts",
      "packages/orchestrator/src/system-prompt.ts",
    ]) {
      const source = sourceCode(relativePath);
      expect(source).toMatch(/vendorRouting(Brief|Lines)/);
      expect(
        source,
        `${relativePath} still names a vendor as a routing default`
      ).not.toMatch(/loops? → claude-code|triage → cursor/);
    }
  });

  it("the rendered policy sentence names no vendor at all", () => {
    for (const id of VENDOR_IDS) {
      expect(VENDOR_ROUTING_POLICY).not.toContain(id);
    }
  });

  it("every public vendor appears in the rendered lines, with its real ceiling", () => {
    const lines = vendorRoutingLines();
    expect(lines).toHaveLength(publicVendorIds().length);
    for (const id of publicVendorIds()) {
      const line = lines.find((candidate) => candidate.startsWith(`${id} `));
      expect(line, `${id} is missing from the rendered routing lines`).toBeDefined();
      for (const role of VENDOR_REGISTRY[id].authority.supportedRoles) {
        expect(line).toContain(role);
      }
    }
  });
});

describe("vendor registry drift-lock — labels", () => {
  it("adapters VENDOR_LABELS === displayName", () => {
    for (const [vendor, label] of Object.entries(VENDOR_LABELS)) {
      expect(label).toBe(VENDOR_REGISTRY[vendor as VendorId].displayName);
    }
  });

  it("client ONBOARDING_VENDOR_LABELS === displayName", () => {
    for (const [vendor, label] of Object.entries(ONBOARDING_VENDOR_LABELS)) {
      expect(label).toBe(VENDOR_REGISTRY[vendor as VendorId].displayName);
    }
  });
});

describe("vendor registry drift-lock — persisted lanes and seats", () => {
  it("the available-lane read is a projection of visibility, not a lane table", () => {
    // The persisted side (Lane / Agent rows) was the LAST place that could still
    // answer "which lanes exist" on its own, because bootstrap only ever ADDS:
    // a vendor removed from the registry kept its seeded rows and kept showing
    // up wherever a surface enumerated them. `availableLaneKeys()` is what every
    // such read now filters through, so it has to stay a registry projection.
    expectRegistryProjection(
      "backend/src/lib/vendor-lanes.ts",
      "availableLaneKeys",
      'entry.visibility === "public"'
    );
    // Rule 2 again, at the query layer: the AVAILABLE set is always the positive
    // `in`. The retire pass is the ONLY complement allowed in this module, and
    // it is the safe direction — it derives the FORBIDDEN set, so an unknown or
    // newly-added row lands on the retired side, never the available one.
    const source = sourceCode("backend/src/lib/vendor-lanes.ts");
    expect(source).toContain("key: { in: [...availableLaneKeys()] }");
    expect(source.match(/notIn/g) ?? []).toHaveLength(1);
  });

  it("every read that enumerates lanes or seats filters through the registry", () => {
    for (const file of [
      "backend/src/routes/lanes.ts",
      "backend/src/routes/routing.ts",
      "backend/src/routes/workflow-runs.ts",
    ]) {
      expect(sourceCode(file), `${file} enumerates lanes unfiltered again`).toContain(
        "availableLaneWhere()"
      );
    }
    // The fleet snapshot filters seats by the SAME set the claim route admits,
    // so `agents` and `counts` can never disagree the way they did when a
    // removed vendor's seats survived in one and not the other.
    expect(sourceCode("backend/src/routes/fleet.ts")).toContain(
      "vendor: { in: [...claimableVendors()] }"
    );
  });
});

describe("vendor registry drift-lock — the known divergences", () => {
  it("adapters VendorKey covers every registry id (divergence closed)", () => {
    expect(KNOWN_DIVERGENCES.vendorKeyMissing).toEqual([]);
    expect([...VENDOR_KEYS].sort()).toEqual([...VENDOR_IDS].sort());
  });

  it("VendorKey is the registry id, not a second union that agrees with it", () => {
    // TODO 3.3. The equality above can be satisfied by a hand-written union
    // that happens to be complete TODAY — which is exactly the state this
    // divergence was in for three waves. Hold the mechanism, not just the
    // outcome: the type must be the alias, and the descriptor table must be
    // total over the registry so `tsc` (not a reviewer) catches the next vendor.
    const source = sourceCode("packages/adapters/src/vendor-capabilities.ts");
    expect(source).toMatch(/export type VendorKey = VendorId\b/);
    expect(
      sourceObjectKeys(
        "packages/adapters/src/vendor-capabilities.ts",
        "VENDOR_CAPABILITY_DESCRIPTORS"
      )
    ).toEqual([...VENDOR_IDS]);
  });

  it("adapters PUBLIC_VENDOR_KEYS is a projection of publicVendorIds()", () => {
    expect([...PUBLIC_VENDOR_KEYS].sort()).toEqual(ids(publicVendorIds()).sort());
    expectRegistryProjection(
      "packages/adapters/src/vendor-capabilities.ts",
      "PUBLIC_VENDOR_KEYS",
      "publicVendorIds()"
    );
  });

  it("there is ONE model catalogue, and the adapters' copy is a projection of it", () => {
    // TODO 3.3: `CLAUDE_MODELS` / `CODEX_MODELS` / `CURSOR_MODELS` /
    // `FAKE_MODELS` were a second hand-edited spelling of `entry.models`, kept
    // married to it by review alone. The descriptor now DERIVES, so the two can
    // no longer disagree — assert both the derivation and the absence of a
    // re-introduced rival literal.
    const source = sourceCode("packages/adapters/src/vendor-capabilities.ts");
    expect(source).toContain("VENDOR_REGISTRY[vendor].models");
    expect(
      source,
      "a per-vendor model literal is declared in the adapters again"
    ).not.toMatch(/\bconst\s+[A-Z_]+_MODELS\b/);
    for (const id of VENDOR_IDS) {
      const registry = VENDOR_REGISTRY[id].models;
      const descriptor = VENDOR_CAPABILITY_DESCRIPTORS[id].models;
      if (!registry) {
        expect(descriptor, `${id} claims a catalogue the registry denies`).toBeUndefined();
        continue;
      }
      expect(descriptor).toEqual({
        known: [...registry.known],
        allowCustom: registry.allowCustom,
        idShape: registry.idShape,
      });
    }
  });

  it("every `known` id satisfies its own vendor's declared idShape", () => {
    // TODO 3.4: the form check fires BEFORE membership, so a `known` entry that
    // violates its own declared shape would be permanently unreachable — the
    // registry would advertise a model no caller could ever pass. It is the one
    // way the two halves of a policy can contradict each other.
    //
    // THIS ASSERTION IS VACUOUS TODAY and says so out loud rather than looking
    // like coverage: the only shaped vendor is opencode, whose `known` is empty
    // BY CONSTRUCTION, so the inner loop runs zero times. The pairing counter is
    // what keeps that honest — the moment a shaped vendor gains a `known` id the
    // loop starts biting, and until then the expectation below states the true
    // reason the check is empty instead of implying it ran.
    let checked = 0;
    const shaped: string[] = [];
    for (const id of VENDOR_IDS) {
      const policy = VENDOR_REGISTRY[id].models;
      if (!policy?.idShape) continue;
      shaped.push(id);
      for (const known of policy.known) {
        checked += 1;
        expect(
          modelIdMatchesShape(policy.idShape, known),
          `${id} lists '${known}' as known but it fails the declared ${policy.idShape} shape`
        ).toBe(true);
      }
    }
    expect(shaped, "no vendor declares an idShape at all").not.toEqual([]);
    expect(
      checked,
      `expected 0 shaped known-ids (every shaped vendor has an unenumerable catalogue); got ${checked} — the loop now bites, drop this guard`
    ).toBe(0);
  });

  it("modelIdMatchesShape('provider-qualified') accepts vendor ids and refuses the rest", () => {
    // The shape function is the WHOLE security surface of TODO 3.4, so it gets a
    // direct table rather than only being exercised through the route.
    for (const ok of [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5",
      "opencode/big-pickle",
      // Aggregator re-exports are multi-segment; refusing these would refuse
      // ids the vendor's own `models` command prints.
      "openrouter/qwen/qwen3-coder",
      "a/b",
    ]) {
      expect(modelIdMatchesShape("provider-qualified", ok), ok).toBe(true);
    }
    for (const bad of [
      // Bare slugs — the case the lift had to keep refusing, since `sonnet` is a
      // plausible CLAUDE id and not an opencode one.
      "sonnet",
      "opus",
      // Empty segments.
      "anthropic/",
      "/gpt-5",
      "a//b",
      "/",
      // Whitespace, including the two that `\s` does NOT cover.
      "a b/c",
      "a\tb/c",
      "a\nb/c",
      "\u00a0/x",
      "a\u0000b/c",
      "a\u200bb/c",
      // Path-shaped: every one of these satisfies "≥2 non-empty segments".
      "../../etc/passwd",
      "a/../../etc/passwd",
      "./x",
      "~/x",
      "$HOME/x",
      "",
    ]) {
      expect(modelIdMatchesShape("provider-qualified", bad), bad).toBe(false);
    }
  });

  it("the vendors recorded as models: null are the ones the override gate refuses", () => {
    // TODO 3.4 emptied this set, and an EMPTY set is the strongest form of the
    // assertion rather than the absence of one: every registered lane can now
    // validate a per-dispatch override, so any future `null` is a deliberate
    // "MUON can check nothing here" that has to be argued for in review — not a
    // slot someone forgot to fill. The gate below still reads the column, so a
    // re-introduced `null` still 400s instead of being waved through.
    expect(ids(vendorsWhere((entry) => entry.models === null))).toEqual([]);
    const dispatch = sourceCode("backend/src/routes/dispatch.ts");
    expect(dispatch).toContain("entry.models !== null");
    // …and the action gate asks about ACTIONS, not about descriptor membership,
    // so an empty action set cannot read as "unrestricted".
    expect(dispatch).toContain(
      "VENDOR_CAPABILITY_DESCRIPTORS[entry.id].actions.length > 0"
    );
    expect(
      dispatch,
      "the model/action gates are back to standing on VendorKey membership"
    ).not.toMatch(/\bvendorsWithCapabilityDescriptor\b/);
    // The catalogue lift (TODO 3.4) must not have leaked into the ACTION set:
    // the two gates were split precisely so one could open without the other,
    // and G10's full-auto gate rides on this emptiness.
    expect(VENDOR_CAPABILITY_DESCRIPTORS.opencode.actions).toEqual([]);
  });

  it("opencode's catalogue verifies FORM and says so, never membership", () => {
    // TODO 3.4's whole claim in one place. `known: []` is load-bearing: it is
    // what makes the warning say "form verified, membership not" instead of
    // blaming the operator for an id MUON never enumerated.
    const policy = VENDOR_REGISTRY.opencode.models;
    expect(policy).not.toBeNull();
    expect(policy?.known).toEqual([]);
    expect(policy?.allowCustom).toBe(true);
    expect(policy?.idShape).toBe("provider-qualified");

    // A bare slug is refused on FORM — the point of the lift, since this is the
    // value that used to be impossible to send and would now fail at the vendor.
    const bare = validateModelForVendor("opencode", "sonnet");
    expect(bare.ok).toBe(false);
    expect(bare.reason).toContain("provider/model");

    // A well-formed id passes, with a warning that names the residual risk.
    const qualified = validateModelForVendor("opencode", "anthropic/claude-sonnet-5");
    expect(qualified.ok).toBe(true);
    expect(qualified.warning).toContain("configured providers");
    expect(
      qualified.warning,
      "the warning blames the operator for MUON's own silence"
    ).not.toContain("is not a known");

    // The categorical net still fires first, and with its own reason.
    expect(validateModelForVendor("opencode", "-o/evil").ok).toBe(false);
    expect(
      validateModelForVendor("opencode", "--strict-mcp-config").reason
    ).toContain("guarded value");
    // Aggregator ids are multi-segment; the form must not demand exactly one `/`.
    expect(
      validateModelForVendor("opencode", "openrouter/qwen/qwen3-coder").ok
    ).toBe(true);
    // …but an empty segment is malformed.
    expect(validateModelForVendor("opencode", "anthropic/").ok).toBe(false);
  });

  it("client AGENT_VENDORS now covers every registry id (divergence closed)", () => {
    // WAVE D: the copy that used to omit a managed lane is now `VENDOR_IDS`
    // itself, which is why `agentVendorsMissing` is empty. The projection form
    // keeps the assertion honest: a re-introduced literal fails the first half.
    expect(KNOWN_DIVERGENCES.agentVendorsMissing).toEqual([]);
    expectRegistryProjection(
      "packages/client/src/agent-preedit-context.ts",
      "AGENT_VENDORS",
      "VENDOR_IDS"
    );
  });

  it("protocol capabilityVendorSchema is still the original trio", () => {
    for (const id of VENDOR_IDS) {
      const accepted = capabilityVendorSchema.safeParse(id).success;
      expect(accepted).toBe(
        !(KNOWN_DIVERGENCES.capabilityVendorMissing as readonly string[]).includes(id)
      );
    }
  });
});

describe("vendor registry drift-lock — no set is derived by subtraction", () => {
  it("every projection is reachable from a positive predicate alone", () => {
    // Guards rule 2 of ADR-0022 §0: a set that was computed as
    // `SUPERSET − FORBIDDEN` would admit a brand-new vendor by default. Every
    // projection below must be exactly the vendors that opted IN.
    const projections: [string, readonly string[], (id: VendorId) => boolean][] =
      [
        ["fleet", ids(fleetVendorIds()), (id) =>
          VENDOR_REGISTRY[id].visibility === "public" &&
          VENDOR_REGISTRY[id].authority.fleetSizeable],
        ["dispatchable", ids(dispatchableVendorIds()), (id) =>
          VENDOR_REGISTRY[id].authority.dispatchable],
        ["coordinator", ids(coordinatorVendorIds()), (id) =>
          VENDOR_REGISTRY[id].authority.coordinatorSeat],
        ["evaluator", ids(evaluatorVendorIds()), (id) =>
          VENDOR_REGISTRY[id].authority.evaluator],
        ["planner", ids(plannerVendorIds()), (id) =>
          VENDOR_REGISTRY[id].authority.planner],
        ["terminalTakeover", ids(terminalTakeoverVendorIds()), (id) =>
          VENDOR_REGISTRY[id].authority.terminalTakeover],
      ];
    for (const [name, actual, opted] of projections) {
      expect({ [name]: actual }).toEqual({
        [name]: [...VENDOR_IDS].filter(opted),
      });
    }
  });
});
