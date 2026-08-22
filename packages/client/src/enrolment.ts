import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveDataDir } from "./paths.js";

/**
 * WHICH AGENT CLIs THE HUMAN CHOSE TO GIVE MUON TO.
 *
 * The one thing setup produced that nothing wrote down. Every surface could
 * install MUON into a vendor, and none of them remembered having done it — so
 * when a vendor's config drifted (an upgrade rewrote it, a profile moved, a
 * `claude mcp remove` took it out) there was nothing to restore FROM. The user
 * was left to re-derive their own setup, which is the DIY loop this record
 * exists to end.
 *
 * IT IS A RECORD OF A DECISION, NOT A GRANT. Re-applying it (`muon doctor
 * --fix`) re-registers exactly the vendors a human already picked, in the mode
 * they picked, and can do nothing else: it writes vendor config files, mints
 * no credential, and cannot add a vendor the human never chose. That is the
 * property that makes automatic repair safe — repair restores an existing
 * decision rather than making a new one.
 *
 * DELIBERATELY NOT THE ATTACHED-COORDINATOR SEAT. A seat is a session act with
 * a live lease and running children (ADR-0028); it is not a setting, and
 * re-minting one silently would hand out authority nobody asked for at that
 * moment. Only the durable, credential-free registration lives here.
 */
export const ENROLMENT_FILE_NAME = "enrolment.json";

const enrolmentModeSchema = z.enum(["base", "observer"]);

/**
 * v2 (2026-08-20): the MODE lives ON EACH VENDOR, not on the machine.
 *
 * v1 carried one machine-wide mode, and it could not tell the truth about a
 * machine whose vendors were installed differently: a base `muon mcp install
 * codex` on an observer-enrolled machine either had to be dropped from the
 * record (repair then can't restore a successful install) or recorded under a
 * mode it doesn't have (repair then rewrites it). Per-vendor mode is what the
 * record was always claiming to be — the decision as made, per vendor.
 */
export const enrolmentSchema = z
  .object({
    version: z.literal(2),
    /**
     * The vendors, in the order the human picked them, EACH with the mode it
     * was registered in. An EMPTY array is a meaningful answer ("I chose
     * none"), which is why absence of the file and an empty list are
     * different states everywhere below.
     */
    vendors: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            /**
             * `base` is the durable full registration — no capability file,
             * no token, no lease. `observer` is the read-only variant of the
             * same durability.
             */
            mode: enrolmentModeSchema.default("base"),
          })
          .strict()
      )
      .max(32),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** The v1 shape, still READ (and upgraded in memory) — never written. */
const enrolmentV1Schema = z
  .object({
    version: z.literal(1),
    vendors: z.array(z.string().min(1).max(64)).max(32),
    mode: enrolmentModeSchema.default("base"),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Enrolment = z.infer<typeof enrolmentSchema>;
export type EnrolmentVendor = Enrolment["vendors"][number];

/** The ids alone, for every consumer that only asks WHICH vendors. */
export function enrolledVendorIds(enrolment: Enrolment): string[] {
  return enrolment.vendors.map((vendor) => vendor.id);
}

export function enrolmentFilePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, ENROLMENT_FILE_NAME);
}

export type EnrolmentRead =
  | { readonly ok: true; readonly enrolment: Enrolment }
  /** No file: this machine has never been set up. NOT the same as "none chosen". */
  | { readonly ok: false; readonly reason: "absent" }
  /** A file that will not parse. Reported, never silently treated as absent —
   *  the two lead a human to different actions. */
  | { readonly ok: false; readonly reason: "unreadable"; readonly detail: string };

export function readEnrolment(
  dataDir: string = resolveDataDir()
): EnrolmentRead {
  const filePath = enrolmentFilePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, reason: "absent" };
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    // v1 upgrades IN MEMORY: each vendor inherits the machine-wide mode it was
    // recorded under. The file is rewritten as v2 on the next write, not here
    // — a read must never mutate the record it reports on.
    if (parsed?.version === 1) {
      const v1 = enrolmentV1Schema.parse(parsed);
      return {
        ok: true,
        enrolment: enrolmentSchema.parse({
          version: 2,
          vendors: v1.vendors.map((id) => ({ id, mode: v1.mode })),
          updatedAt: v1.updatedAt,
        }),
      };
    }
    return { ok: true, enrolment: enrolmentSchema.parse(parsed) };
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      detail: error instanceof Error ? error.message : "invalid enrolment file",
    };
  }
}

/**
 * Record the human's choice. Written atomically, because a half-written
 * enrolment is exactly the state `--fix` would then restore from.
 */
export function writeEnrolment(
  input: {
    vendors: readonly { id: string; mode?: "base" | "observer" }[];
  },
  dataDir: string = resolveDataDir(),
  now: Date = new Date()
): Enrolment {
  // De-duplicated BY ID, order preserved, LAST mode wins: the list is a set,
  // and a vendor named twice must not be installed twice or reported as two
  // rows — but a re-record of the same vendor in a new mode is an update.
  const byId = new Map<string, "base" | "observer">();
  for (const vendor of input.vendors) {
    const id = vendor.id.trim();
    if (!id) continue;
    byId.set(id, vendor.mode ?? "base");
  }
  const enrolment = enrolmentSchema.parse({
    version: 2,
    vendors: [...byId.entries()].map(([id, mode]) => ({ id, mode })),
    updatedAt: now.toISOString(),
  });
  const filePath = enrolmentFilePath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(enrolment, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
  return enrolment;
}
