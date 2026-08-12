import type { FastifyInstance } from "fastify";
import {
  buildRefusal,
  projectRefusal,
  renderRefusalLine,
  type Refusal,
  type RefusalAction,
  type RefusalAudience,
  type RefusalFact,
  type RefusalRule,
} from "@muon/protocol";

/**
 * ADR-0033 over HTTP.
 *
 * A route that refuses throws a normal fastify error whose `message` is what
 * every existing client already renders — nothing about today's behaviour
 * changes. The typed refusal rides ALONGSIDE it, projected to the caller's
 * audience at throw time, so the error serializer never has to decide what a
 * caller may see.
 *
 * Projecting HERE rather than in the serializer is deliberate: the audience is
 * known at the enforcement site (the request's tier) and nowhere else, and a
 * serializer that guesses is a serializer that eventually guesses wrong.
 */

/** The error shape the app's serializer looks for. */
export type RefusalCarryingError = Error & {
  statusCode: number;
  muonRefusal?: Refusal;
};

export function attachRefusal<E extends Error>(
  error: E,
  refusal: Refusal,
  audience: RefusalAudience
): E {
  (error as E & { muonRefusal?: Refusal }).muonRefusal = projectRefusal(
    refusal,
    audience
  );
  return error;
}

export function readRefusal(error: unknown): Refusal | undefined {
  if (!error || typeof error !== "object") return undefined;
  const carried = (error as { muonRefusal?: Refusal }).muonRefusal;
  return carried && typeof carried === "object" ? carried : undefined;
}

/**
 * Throw a 400 that carries its refusal.
 *
 * The thrown `message` is the rendered line for the audience, so a client that
 * knows nothing about ADR-0033 still gets the rule, the disclosed evidence and
 * the next action as prose — the typed block is an upgrade, never a
 * precondition.
 */
export function refuseBadRequest(
  app: FastifyInstance,
  audience: RefusalAudience,
  input: {
    rule: RefusalRule;
    summary: string;
    surface: string;
    evidence?: readonly RefusalFact[];
    nextAction?: RefusalAction;
  }
): never {
  const refusal = buildRefusal(input);
  const error = app.httpErrors.badRequest(
    renderRefusalLine(refusal, audience)
  );
  throw attachRefusal(error, refusal, audience);
}

/** Throw a 403 that carries its refusal. */
export function refuseForbidden(
  app: FastifyInstance,
  audience: RefusalAudience,
  input: {
    rule: RefusalRule;
    summary: string;
    surface: string;
    evidence?: readonly RefusalFact[];
    nextAction?: RefusalAction;
  }
): never {
  const refusal = buildRefusal(input);
  const error = app.httpErrors.forbidden(renderRefusalLine(refusal, audience));
  throw attachRefusal(error, refusal, audience);
}

/** Throw a 409 that carries its refusal. */
export function refuseConflict(
  app: FastifyInstance,
  audience: RefusalAudience,
  input: {
    rule: RefusalRule;
    summary: string;
    surface: string;
    evidence?: readonly RefusalFact[];
    nextAction?: RefusalAction;
  }
): never {
  const refusal = buildRefusal(input);
  const error = app.httpErrors.conflict(renderRefusalLine(refusal, audience));
  throw attachRefusal(error, refusal, audience);
}
