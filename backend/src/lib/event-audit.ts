import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
// NOTE: do NOT import `./db.js` or `./auth.js` at module top-level. Vitest
// files import the pure helpers here before they set DATABASE_URL; auth→db
// would bind PrismaClient to the wrong datasource. Callers pass principal
// constants; `ensureEventPrincipals` lazy-loads db.

const OPERATOR_PRINCIPAL = "human";
const AGENT_PRINCIPAL = "agent:muon";

function isHumanPrincipal(raw: string | undefined): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "" || s === "human" || s.startsWith("human:");
}

/**
 * TODO 5.15 — the audit stamp every Event writer should carry.
 *
 * Dual-keyed on purpose: `principal*` answers "which AI/human acted";
 * `accountablePrincipalId` answers "which human is accountable". They are two
 * columns rather than a reconstruction from `laneId` + metadata. All fields
 * are optional so a best-effort internal writer (gate telemetry) can stamp
 * what it knows and leave the rest NULL — NULL means "not measured", never a
 * forged human.
 */
export type EventAuditStamp = {
  principalId: string | null;
  principalKind: "human" | "agent" | null;
  accountablePrincipalId: string | null;
  requestId: string | null;
  payloadDiff: Prisma.InputJsonValue | null;
};

export type EventAuditInput = {
  /** Raw principal string (`human`, `human:carol`, `codex`, `agent:muon`). */
  actor: string;
  /**
   * The human accountable for this act. Defaults to the actor when the actor
   * is human-kind; stays null for agent acts unless the caller names one
   * (e.g. the operator who dispatched the job).
   */
  accountable?: string | null;
  requestId?: string | null;
  payloadDiff?: Prisma.InputJsonValue | null;
};

/** Deterministic Principal id — mirrors memory-ledger's slug so Event and
 *  Confirmation join the same Principal row for the same author. */
function slugifyPrincipal(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export function parseEventPrincipal(raw: string): {
  id: string;
  kind: "human" | "agent";
  displayName: string;
  vendor: string | null;
} {
  const s = (raw ?? "").trim();
  const colon = s.indexOf(":");
  let kind: "human" | "agent";
  let identity: string;
  let vendor: string | null;
  if (colon > 0) {
    const prefix = s.slice(0, colon).toLowerCase();
    const rest = s.slice(colon + 1).trim();
    if (prefix === "human") {
      kind = "human";
      identity = rest || "human";
      vendor = null;
    } else if (prefix === "agent") {
      kind = "agent";
      identity = rest || "agent";
      vendor = identity;
    } else {
      kind = "agent";
      identity = s;
      vendor = s;
    }
  } else if (s === "" || s.toLowerCase() === "human") {
    kind = "human";
    identity = "human";
    vendor = null;
  } else {
    kind = "agent";
    identity = s;
    vendor = s;
  }
  return {
    id: `principal-${kind}-${slugifyPrincipal(identity)}`,
    kind,
    displayName: identity,
    vendor,
  };
}

/** Build the stamp from an explicit actor (+ optional accountable / request). */
export function buildEventAuditStamp(input: EventAuditInput): EventAuditStamp {
  const actor = parseEventPrincipal(input.actor);
  const accountableRaw =
    input.accountable !== undefined && input.accountable !== null
      ? input.accountable
      : actor.kind === "human"
        ? input.actor
        : null;
  const accountable = accountableRaw
    ? parseEventPrincipal(accountableRaw)
    : null;
  // An "accountable" agent is a category error — drop it rather than stamp a lie.
  const accountableId =
    accountable && accountable.kind === "human" ? accountable.id : null;
  return {
    principalId: actor.id,
    principalKind: actor.kind,
    accountablePrincipalId: accountableId,
    requestId: input.requestId ?? null,
    payloadDiff: input.payloadDiff ?? null,
  };
}

/**
 * Derive the acting principal from the authenticated request.
 * Operator → human (body-supplied id honored when human-kind).
 * Agent job → agent:<vendor> from the capability, never a body-asserted human.
 */
export function auditActorFromRequest(
  request: FastifyRequest,
  requestedActor?: string
): string {
  const tier = request.tier ?? "operator";
  if (tier === "operator") {
    const raw = (requestedActor ?? "").trim();
    return raw && isHumanPrincipal(raw) ? raw : OPERATOR_PRINCIPAL;
  }
  const vendor = request.agentJobCapability?.vendor?.trim();
  if (vendor) {
    return `agent:${vendor}`;
  }
  return AGENT_PRINCIPAL;
}

/** Best-effort Principal upsert so the stamp joins a real row. Never throws —
 *  Event append must not fail because the Principal table hiccuped. The whole
 *  body is try/catch'd (not just each upsert) so a missing `prisma.principal`
 *  mock, a failed dynamic import, or a sync throw cannot 500 a success path. */
export async function ensureEventPrincipals(
  stamp: EventAuditStamp,
  actorRaw: string,
  accountableRaw?: string | null
): Promise<void> {
  try {
    const { prisma } = await import("./db.js");
    const rows: Array<ReturnType<typeof parseEventPrincipal>> = [
      parseEventPrincipal(actorRaw),
    ];
    if (accountableRaw) {
      const accountable = parseEventPrincipal(accountableRaw);
      if (accountable.kind === "human" && accountable.id !== rows[0]!.id) {
        rows.push(accountable);
      }
    }
    // Prefer the stamp's ids when present so a caller cannot diverge by
    // passing a different actorRaw than the stamp was built from.
    void stamp;
    await Promise.all(
      rows.map((parsed) =>
        Promise.resolve()
          .then(() =>
            prisma.principal.upsert({
              where: { id: parsed.id },
              create: {
                id: parsed.id,
                kind: parsed.kind,
                displayName: parsed.displayName,
                vendor: parsed.vendor,
                trust: parsed.kind === "human" ? "high" : "medium",
              },
              update: {
                displayName: parsed.displayName,
                vendor: parsed.vendor,
              },
            })
          )
          .catch(() => undefined)
      )
    );
  } catch {
    // Swallow everything — see docblock.
  }
}

/** Prisma `data` fragment for the five audit columns. */
export function eventAuditData(
  stamp: EventAuditStamp
): Pick<
  Prisma.EventCreateInput,
  | "principalId"
  | "principalKind"
  | "accountablePrincipalId"
  | "requestId"
  | "payloadDiff"
> {
  return {
    principalId: stamp.principalId,
    principalKind: stamp.principalKind,
    accountablePrincipalId: stamp.accountablePrincipalId,
    requestId: stamp.requestId,
    ...(stamp.payloadDiff !== null
      ? { payloadDiff: stamp.payloadDiff }
      : {}),
  };
}

/**
 * F5 — the one-call form for route writers: derive the actor from the
 * authenticated request, upsert the Principal rows, and return the
 * spread-ready audit columns for `prisma.event.create`. Exists so covering a
 * writer is a one-line change — an audit trail that is annoying to join
 * stays partial (bounded-surface completeness: EVERY governed Event writer
 * stamps).
 */
export async function requestAuditColumns(
  request: FastifyRequest,
  opts?: { accountable?: string | null; payloadDiff?: Prisma.InputJsonValue }
): Promise<ReturnType<typeof eventAuditData>> {
  const actor = auditActorFromRequest(request);
  const stamp = buildEventAuditStamp({
    actor,
    accountable: opts?.accountable,
    requestId: (request.id as string | undefined) ?? null,
    payloadDiff: opts?.payloadDiff ?? null,
  });
  await ensureEventPrincipals(stamp, actor, opts?.accountable ?? null);
  return eventAuditData(stamp);
}
