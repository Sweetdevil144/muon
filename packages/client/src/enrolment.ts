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

export const enrolmentSchema = z
  .object({
    version: z.literal(1),
    /**
     * The vendors, in the order the human picked them. An EMPTY array is a
     * meaningful answer ("I chose none"), which is why absence of the file and
     * an empty list are different states everywhere below.
     */
    vendors: z.array(z.string().min(1).max(64)).max(32),
    /**
     * The registration mode. `base` is the durable one — no capability file,
     * no token, no lease, so it survives every restart and reboot on its own.
     * `observer` is the read-only variant of the same durability.
     */
    mode: z.enum(["base", "observer"]).default("base"),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Enrolment = z.infer<typeof enrolmentSchema>;

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
    return { ok: true, enrolment: enrolmentSchema.parse(JSON.parse(raw)) };
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
  input: { vendors: readonly string[]; mode?: "base" | "observer" },
  dataDir: string = resolveDataDir(),
  now: Date = new Date()
): Enrolment {
  const enrolment = enrolmentSchema.parse({
    version: 1,
    // De-duplicated, order preserved: the list is a set, and a vendor named
    // twice must not be installed twice or reported as two rows.
    vendors: [...new Set(input.vendors.map((vendor) => vendor.trim()))].filter(
      Boolean
    ),
    mode: input.mode ?? "base",
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
