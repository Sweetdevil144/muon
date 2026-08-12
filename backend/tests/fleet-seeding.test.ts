import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELEGATION_MAX_CHILDREN } from "@muon/protocol";

/**
 * F1(a) — the fleet must SEAT enough workers that a same-vendor fan-out runs
 * concurrently instead of queueing behind itself.
 *
 * The founder's run dispatched three implementers, two of them claude-code. The
 * fleet held exactly ONE dispatchable claude-code seat (ordinal 0 is the
 * reserved coordinator), so the second implementer started 117 ms after the
 * first ENDED. These tests pin both halves of the fix: the seat count, and the
 * migration safety that lets an existing install reach it without disturbing a
 * single row it already has.
 */

const prismaMock = vi.hoisted(() => ({
  agent: {
    findMany: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  },
  operatorSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));

const { ensureDefaultFleet } = await import("../src/lib/bootstrap.js");
const { FLEET_SEATS_PER_VENDOR, FLEET_MAX_PER_VENDOR, FLEET_VENDORS } =
  await import("../src/routes/fleet.js");

type SeededAgent = { vendor: string; ordinal: number; name: string };

/**
 * Drive `ensureDefaultFleet` against a fake agent table.
 *
 * `existing` is the DB as it stands before boot (worker rows only — the mock's
 * findMany applies the same `ordinal >= 1` filter the real query does, so a
 * coordinator row supplied here is correctly invisible to seeding).
 *
 * `baseline` is the stored watermark: a number (recorded), null/undefined (no
 * row yet), a string (a corrupt/hand-edited value), or an Error (the settings
 * read itself fails). The last two are the ones that used to read as "already
 * seeded to the target".
 */
async function runSeeding(input: {
  existing: SeededAgent[];
  baseline?: number | string | Error | null;
}): Promise<{ created: SeededAgent[]; baselineWrites: unknown[] }> {
  const created: SeededAgent[] = [];
  const rows = [...input.existing];

  prismaMock.agent.findMany.mockImplementation(
    async (args: { where: { vendor: string; ordinal: { gte: number } } }) =>
      rows
        .filter(
          (row) =>
            row.vendor === args.where.vendor &&
            row.ordinal >= args.where.ordinal.gte
        )
        .map((row) => ({ ordinal: row.ordinal }))
        .sort((a, b) => a.ordinal - b.ordinal)
  );
  prismaMock.agent.create.mockImplementation(
    async (args: { data: SeededAgent }) => {
      // A real @@unique([vendor, ordinal]) violation must surface as a test
      // failure, not as a silently duplicated seat.
      if (
        rows.some(
          (row) =>
            row.vendor === args.data.vendor && row.ordinal === args.data.ordinal
        )
      ) {
        throw new Error(
          `duplicate seat ${args.data.vendor}-${args.data.ordinal}`
        );
      }
      rows.push(args.data);
      created.push(args.data);
      return args.data;
    }
  );
  prismaMock.agent.upsert.mockResolvedValue({});
  if (input.baseline instanceof Error) {
    prismaMock.operatorSetting.findUnique.mockRejectedValue(input.baseline);
  } else {
    prismaMock.operatorSetting.findUnique.mockResolvedValue(
      input.baseline === undefined || input.baseline === null
        ? null
        : { key: "fleetSeatBaseline", value: String(input.baseline) }
    );
  }
  prismaMock.operatorSetting.upsert.mockResolvedValue({});

  await ensureDefaultFleet();

  return {
    created,
    baselineWrites: prismaMock.operatorSetting.upsert.mock.calls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("default fleet seating (F1a)", () => {
  it("seats as many workers per vendor as one parent may fan out to", () => {
    // Not "3": the number is the delegation fan-out cap, so raising that cap
    // can never silently leave the fleet unable to honour it.
    expect(FLEET_SEATS_PER_VENDOR).toBe(DELEGATION_MAX_CHILDREN);
    // …and it can never exceed what an operator resize is allowed to reach.
    expect(FLEET_SEATS_PER_VENDOR).toBeLessThanOrEqual(FLEET_MAX_PER_VENDOR);
  });

  it("a FRESH database gets a full-width fleet for every sizeable vendor", async () => {
    const { created } = await runSeeding({ existing: [] });

    for (const vendor of FLEET_VENDORS) {
      const seats = created
        .filter((row) => row.vendor === vendor)
        .map((row) => row.ordinal)
        .sort((a, b) => a - b);
      expect(seats).toEqual([1, 2, 3]);
    }
    // Worker ordinals only: seeding never creates an ordinal-0 row here — the
    // reserved coordinator seat is `ensureCoordinatorAgent`'s upsert alone.
    expect(created.every((row) => row.ordinal >= 1)).toBe(true);
  });

  it("TOPS UP the founder's install without renumbering or duplicating a row", async () => {
    // Exactly the founder's DB: an ordinal-0 coordinator plus one worker seat
    // per vendor, seeded under the old one-seat default (no watermark).
    const existing: SeededAgent[] = [
      { vendor: "claude-code", ordinal: 0, name: "claude-code-coordinator" },
      { vendor: "codex", ordinal: 0, name: "codex-coordinator" },
      ...FLEET_VENDORS.map((vendor) => ({
        vendor,
        ordinal: 1,
        name: `${vendor}-1`,
      })),
      // The retired lane, which is NOT in the registry.
      { vendor: "ollama", ordinal: 1, name: "ollama-1" },
    ];

    const { created } = await runSeeding({ existing, baseline: null });

    for (const vendor of FLEET_VENDORS) {
      const added = created
        .filter((row) => row.vendor === vendor)
        .map((row) => row.ordinal)
        .sort((a, b) => a - b);
      // The pre-existing `-1` row is kept exactly as it is (id, name, and any
      // live claim survive); only the missing seats are added.
      expect(added).toEqual([2, 3]);
    }
    // The retired lane is never visited: no seat is created for it.
    expect(created.some((row) => row.vendor === "ollama")).toBe(false);
    // The reserved coordinator ordinal is never re-created either.
    expect(created.some((row) => row.ordinal === 0)).toBe(false);
  });

  it("is IDEMPOTENT: a second boot at the watermark writes nothing", async () => {
    const existing = FLEET_VENDORS.flatMap((vendor) =>
      [1, 2, 3].map((ordinal) => ({
        vendor,
        ordinal,
        name: `${vendor}-${ordinal}`,
      }))
    );

    const { created } = await runSeeding({
      existing,
      baseline: FLEET_SEATS_PER_VENDOR,
    });

    expect(created).toEqual([]);
  });

  it("never overrides an operator resize once the watermark is set", async () => {
    // The human deliberately sized claude-code down to one seat AFTER the
    // migration. Boot must leave that alone — "top up to N" is a one-time
    // migration, not a policy that fights the operator every restart.
    const existing = [
      { vendor: "claude-code", ordinal: 1, name: "claude-code-1" },
      ...FLEET_VENDORS.filter((vendor) => vendor !== "claude-code").flatMap(
        (vendor) =>
          [1, 2, 3].map((ordinal) => ({
            vendor,
            ordinal,
            name: `${vendor}-${ordinal}`,
          }))
      ),
    ];

    const { created } = await runSeeding({
      existing,
      baseline: FLEET_SEATS_PER_VENDOR,
    });

    expect(created).toEqual([]);
  });

  it("fills the smallest UNUSED ordinal rather than colliding after a gap", async () => {
    // A scale-down leaves gaps (a working agent survives a resize), so a blind
    // `length + 1` would violate @@unique([vendor, ordinal]).
    const existing = [
      { vendor: "claude-code", ordinal: 2, name: "claude-code-2" },
    ];

    const { created } = await runSeeding({ existing, baseline: null });

    const claude = created
      .filter((row) => row.vendor === "claude-code")
      .map((row) => row.ordinal)
      .sort((a, b) => a - b);
    expect(claude).toEqual([1, 3]);
  });

  it("records the watermark AFTER seeding, so a crashed boot retries the migration", async () => {
    const { baselineWrites } = await runSeeding({ existing: [] });
    expect(baselineWrites).toHaveLength(1);
    expect(baselineWrites[0]).toMatchObject([
      {
        where: { key: "fleetSeatBaseline" },
        create: {
          key: "fleetSeatBaseline",
          value: String(FLEET_SEATS_PER_VENDOR),
        },
        update: { value: String(FLEET_SEATS_PER_VENDOR) },
      },
    ]);
  });

  it("an UNREADABLE watermark never re-widens an operator's fleet, and records NOTHING", async () => {
    // Fail-safe in the non-widening direction: a settings hiccup must not be
    // read as licence to re-seat agents the human removed.
    prismaMock.operatorSetting.findUnique.mockRejectedValueOnce(
      new Error("settings unavailable")
    );
    const rows = [{ vendor: "claude-code", ordinal: 1, name: "claude-code-1" }];
    const created: SeededAgent[] = [];
    prismaMock.agent.findMany.mockImplementation(
      async (args: { where: { vendor: string } }) =>
        rows
          .filter((row) => row.vendor === args.where.vendor)
          .map((row) => ({ ordinal: row.ordinal }))
    );
    prismaMock.agent.create.mockImplementation(
      async (args: { data: SeededAgent }) => {
        rows.push(args.data);
        created.push(args.data);
        return args.data;
      }
    );
    prismaMock.agent.upsert.mockResolvedValue({});
    prismaMock.operatorSetting.upsert.mockResolvedValue({});

    await ensureDefaultFleet();

    // claude-code already had a seat and the watermark could not be read, so it
    // is left alone; the vendors with NO seats are still seeded (a first run
    // must survive a settings outage).
    expect(created.some((row) => row.vendor === "claude-code")).toBe(false);
    expect(created.some((row) => row.vendor === "codex")).toBe(true);
    // THE HALF THAT WAS MISSING: this pass skipped claude-code's top-up, so it
    // did NOT reach the floor and must not durably claim it did. Recording the
    // watermark here marks the database fully seeded while it still holds one
    // claude-code seat — no later boot tops it up, and same-vendor fan-out
    // serializes forever with nothing surfaced.
    expect(prismaMock.operatorSetting.upsert).not.toHaveBeenCalled();
  });

  it("a GARBAGE watermark value is treated as unreadable, not as 'already seeded'", async () => {
    // A hand-edited/corrupt row is evidence of nothing. It must not license a
    // re-widen, and it must not be laundered into a recorded floor either.
    const { created, baselineWrites } = await runSeeding({
      existing: [{ vendor: "claude-code", ordinal: 1, name: "claude-code-1" }],
      baseline: "not-a-number",
    });

    expect(created.some((row) => row.vendor === "claude-code")).toBe(false);
    expect(baselineWrites).toEqual([]);
  });

  it("a boot that could not read the watermark leaves the top-up for the NEXT boot", async () => {
    // The end-to-end shape of the regression: hiccup, then a healthy boot. The
    // second boot must still find the install below the floor and migrate it.
    const founderInstall: SeededAgent[] = FLEET_VENDORS.map((vendor) => ({
      vendor,
      ordinal: 1,
      name: `${vendor}-1`,
    }));

    const hiccup = await runSeeding({
      existing: founderInstall,
      baseline: new Error("settings unavailable"),
    });
    expect(hiccup.created).toEqual([]);
    expect(hiccup.baselineWrites).toEqual([]);

    // Nothing was recorded, so the healthy boot still sees an unseeded install.
    const healthy = await runSeeding({ existing: founderInstall, baseline: null });
    for (const vendor of FLEET_VENDORS) {
      const added = healthy.created
        .filter((row) => row.vendor === vendor)
        .map((row) => row.ordinal)
        .sort((a, b) => a - b);
      expect(added).toEqual([2, 3]);
    }
    expect(healthy.baselineWrites).toHaveLength(1);
  });

  it("honours a deliberate resize to ZERO once the watermark is set", async () => {
    // The operator emptied claude-code on purpose. "The human's fleet sizing
    // (0–3 per vendor) is never overridden" includes 0 — re-seating three
    // agents is the same override as re-seating one, three times over.
    const existing = FLEET_VENDORS.filter(
      (vendor) => vendor !== "claude-code"
    ).flatMap((vendor) =>
      [1, 2, 3].map((ordinal) => ({
        vendor,
        ordinal,
        name: `${vendor}-${ordinal}`,
      }))
    );

    const { created } = await runSeeding({
      existing,
      baseline: FLEET_SEATS_PER_VENDOR,
    });

    expect(created).toEqual([]);
  });
});
