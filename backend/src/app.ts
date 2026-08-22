import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { redactForLog } from "@muon/core";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  agentJobRouteAllowed,
  bearerToken,
  classifyToken,
  resolveAgentJobCapability,
  resolveAuthTokens,
} from "./lib/auth.js";
// `env.js` MUST be imported before anything that pulls in `@prisma/client`
// (attached-coordinator.js and every routes/*.js below do): the generated
// Prisma client auto-loads backend/.env on import, unconditionally, bypassing
// env.ts's own NODE_ENV==="test" dotenv guard. If that import ran first,
// env.ts's later `envSchema.parse(process.env)` would capture whatever Prisma
// just reloaded from disk (e.g. a stray MUON_API_TOKEN) instead of the test's
// own hermetic values. See lib/db.ts's identical ordering comment.
import { env } from "./lib/env.js";
import { readRefusal } from "./lib/refusal-http.js";
import { registerAttachedCoordinatorRoutes } from "./lib/attached-coordinator.js";
import { MuonLogController, resolveLogLevel } from "./lib/request-log.js";
import { registerA2ARoutes } from "./routes/a2a.js";
import { registerQuestionRoutes } from "./routes/questions.js";
import { registerReviewThreadRoutes } from "./routes/review-thread.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerChatRoutes } from "./routes/chats.js";
import { registerCompatibilityRoutes } from "./routes/compatibility.js";
import { registerCrewRoutes } from "./routes/crew.js";
import {
  registerDispatchRoutes,
  registerRunnerRoutes,
} from "./routes/dispatch.js";
import { registerEventRoutes } from "./routes/events.js";
// IMPORT ORDER IS LOAD-BEARING HERE (see the env hazard note in this file):
// `@prisma/client` auto-loads `backend/.env`, so any module that reaches it
// must be imported AFTER `env.ts` has parsed, or the wrong operator token is
// captured and every authenticated request 401s. Placed among the other route
// modules for exactly that reason — not alphabetised to the top.
import { registerAttendanceRoutes } from "./routes/attendance.js";
import { registerDigestRoutes } from "./routes/digest.js";
import { registerFleetRoutes } from "./routes/fleet.js";
import { registerGitHubRoutes } from "./routes/github.js";
import { registerHarnessRoutes } from "./routes/harnesses.js";
import { registerLaneProfileRoutes } from "./routes/lane-profiles.js";
import { registerLaneRoutes } from "./routes/lanes.js";
import { registerLoopRoutes } from "./routes/loops.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerPolicyProfileRoutes } from "./routes/policy-profiles.js";
import { registerReceiptRoutes } from "./routes/receipts.js";
import { registerGrantRoutes } from "./routes/grants.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerRoutingRoutes } from "./routes/routing.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerStreamRoutes } from "./routes/streams.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerWorkflowRunRoutes } from "./routes/workflow-runs.js";
import { registerWorkflowTemplateRoutes } from "./routes/workflows.js";

function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

export function buildApp() {
  // Log level is operator-controlled via MUON_LOG_LEVEL (debug mode sets it to
  // `debug`); request logging is OURS, not Fastify's two-lines-per-request
  // default, so the 2-second poll traffic stops burying real events at info.
  // See backend/src/lib/request-log.ts.
  const app = Fastify({
    logger: env.NODE_ENV !== "test" ? { level: resolveLogLevel() } : false,
    logController: new MuonLogController(),
  });

  app.register(sensible);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: "validation_error",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const code = prismaErrorCode(error);
    if (code === "P2025") {
      reply.code(404).send({
        error: "not_found",
        message: "The requested record does not exist.",
      });
      return;
    }

    if (code === "P2003") {
      reply.code(400).send({
        error: "invalid_reference",
        message: "A referenced record (task or lane) does not exist.",
      });
      return;
    }

    const httpError = error as { statusCode?: number; message?: string };
    if (httpError.statusCode && httpError.statusCode < 500) {
      // ADR-0033: a refusal the enforcement site typed rides alongside the
      // message. It was already projected to the caller's audience when it was
      // thrown — the serializer does not know the tier and must not guess.
      const refusal = readRefusal(error);
      reply.code(httpError.statusCode).send({
        error: "request_error",
        message: httpError.message ?? "Request failed.",
        ...(refusal ? { refusal } : {}),
      });
      return;
    }

    // TODO 7.1: redact before the logger serializes the error object.
    app.log.error({ err: redactForLog(error) }, "internal error");
    reply.code(500).send({
      error: "internal_error",
      message: "Unexpected server error.",
    });
  });
  app.register(cors, {
    origin: env.FRONTEND_ORIGIN,
    credentials: false,
  });

  // Two-tier capability gate (P3-A). Every /api/* request is classified by WHICH
  // token it presents: the OPERATOR token (human / govern authority, advertised
  // to local human surfaces via the lockfile) sets request.tier="operator"; the
  // AGENT token (injected into dispatched sub-agents + the orchestrator, reads +
  // agent-writes only) sets "agent". Unknown/missing → 401 (fail closed). GOVERN
  // routes additionally call requireOperator(). Constant-time compares (L1).
  // Health stays open for probes. See backend/src/lib/auth.ts + docs/adr/0008.
  const tokens = resolveAuthTokens(env);
  app.decorateRequest("tier", "operator");
  app.decorateRequest("agentJobCapability");
  if (tokens.operator || tokens.agent) {
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/api/")) {
        return;
      }
      const presented = bearerToken(request.headers.authorization);
      const tier = classifyToken(presented, tokens);
      if (tier) {
        request.tier = tier;
        // ADR-0040 D3a — attendance is NOT recorded here, deliberately. An
        // earlier version counted every operator-tier request, and that is
        // exactly the definition review rejected: the desktop polls with the
        // operator token while every window is shut, so a daemon nobody was
        // watching read as attended. Presence is asserted by a surface at
        // `POST /api/attendance`, never inferred from ambient traffic.
        return;
      }
      // ONE resolution pass, with the reason attached. This used to call the
      // resolver and then a second helper that re-implemented the same hash,
      // grant lookup and horizon guard — two copies of a security check, and
      // two extra queries on every failed auth.
      const resolved = await resolveAgentJobCapability(presented);
      if (!resolved.ok) {
        // A RECOGNISED TOKEN WITH NO ACTIVE JOB IS A SCOPE REFUSAL, NOT A
        // BAD CREDENTIAL. Both used to answer 401 "Missing or invalid API
        // token", which sends an agent hunting a fault that does not exist:
        // the token is fine, the session simply has no job, so memory and crew
        // routes have no partition to answer in. Measured live — a Claude
        // session the human started got 401 plus a "check muon doctor" hint,
        // and doctor was entirely green.
        //
        // `remedyFor()` in @muon/mcp already matches "exact active job
        // capability" and answers correctly ("a SCOPE refusal, not a fault …
        // retrying will fail identically"). That machinery was unreachable
        // because this branch never produced the phrase it looks for.
        //
        // 403 only when MUON ISSUED the token — an unrecognised one stays 401,
        // because a genuinely bad credential must not read as a scope problem.
        // Only the 403 names the capability. Putting that phrase on the 401
        // too would make `remedyFor()` answer "this is a SCOPE refusal, not a
        // fault" for a genuinely wrong token — advice that is false there, and
        // that tells someone to stop retrying a credential they could fix.
        if (resolved.refusal === "inactive") {
          reply.code(403).send({
            error: "forbidden",
            message:
              "This route requires the exact active job capability. The token was issued by MUON but its job is no longer active, so memory and crew routes have no partition to answer in. Start governed work with `muon chat`, or use an operator surface (CLI/TUI/desktop).",
          });
          return;
        }
        reply.code(401).send({
          error: "unauthorized",
          message: "Missing or invalid API token.",
        });
        return;
      }

      request.tier = "agent";
      request.agentJobCapability = resolved.capability;
    });
    app.addHook("preHandler", async (request) => {
      if (
        request.agentJobCapability &&
        !agentJobRouteAllowed(request)
      ) {
        throw app.httpErrors.forbidden(
          "The active job capability is not authorized for this control-plane route."
        );
      }
    });
  }
  // No tokens configured is a deliberate LOCAL dev/test choice: the API is open
  // and every caller is treated as the operator tier (request.tier default),
  // the same permissiveness as before P3-A. PRODUCTION never reaches this branch:
  // embedded boot always mints BOTH tokens, and a hosted non-loopback bind
  // refuses to start without them (index.ts, H3 fail-closed).

  app.get("/health", async () => ({
    status: "ok",
    service: "muon-backend",
    timestamp: new Date().toISOString(),
  }));

  // A content-free authentication probe for local transports. It lets the
  // loopback HTTP MCP listener prove that a bearer is AGENT-tier before it
  // allocates a session, instead of accepting any non-empty string (or the
  // operator credential). Exact-job capabilities expose no coordinates here.
  app.get("/api/auth/session", async (request) => ({
    authenticated: true,
    tier: request.tier,
    jobScoped: Boolean(request.agentJobCapability),
  }));

  app.register(registerLaneRoutes, { prefix: "/api/lanes" });
  app.register(registerLaneProfileRoutes, { prefix: "/api/lanes" });
  app.register(registerTaskRoutes, { prefix: "/api/tasks" });
  app.register(registerApprovalRoutes, { prefix: "/api/approvals" });
  app.register(registerPolicyProfileRoutes, { prefix: "/api/policy" });
  app.register(registerReceiptRoutes, { prefix: "/api/receipts" });
  // ADR-0056 — the `always` grade: chat-scoped, policy-fingerprinted, revocable.
  app.register(registerGrantRoutes, { prefix: "/api/grants" });
  app.register(registerEventRoutes, { prefix: "/api/events" });
  // ADR-0040 D3a — a surface asserts human presence here; the horizon reads it.
  app.register(registerAttendanceRoutes, { prefix: "/api/attendance" });
  app.register(registerDigestRoutes, { prefix: "/api/digest" });
  app.register(registerMetricsRoutes, { prefix: "/api/metrics" });
  app.register(registerGitHubRoutes, { prefix: "/api/github" });
  app.register(registerMemoryRoutes, { prefix: "/api/memory" });
  app.register(registerRoutingRoutes, { prefix: "/api/routing" });
  app.register(registerScheduleRoutes, { prefix: "/api/schedules" });
  app.register(registerSessionRoutes, { prefix: "/api/sessions" });
  app.register(registerHarnessRoutes, { prefix: "/api/harnesses" });
  app.register(registerWorkflowTemplateRoutes, { prefix: "/api/workflows" });
  app.register(registerWorkflowRunRoutes, { prefix: "/api/workflow-runs" });
  app.register(registerLoopRoutes, { prefix: "/api/loops" });
  app.register(registerStreamRoutes, { prefix: "/api/streams" });
  app.register(registerFleetRoutes, { prefix: "/api/fleet" });
  app.register(registerChatRoutes, { prefix: "/api/chats" });
  app.register(registerDispatchRoutes, { prefix: "/api/dispatch" });
  // ADR-0028 Tier C: mounted under the SAME prefix so the resulting paths are
  // `/api/dispatch/attached`, `/api/dispatch/attached/:jobId/heartbeat`, and
  // `DELETE /api/dispatch/attached/:jobId` — exactly what the capability
  // route allowlist (lib/auth.ts) and the CLI expect.
  app.register(registerAttachedCoordinatorRoutes, { prefix: "/api/dispatch" });
  app.register(registerRunnerRoutes, { prefix: "/api/runner" });
  app.register(registerCrewRoutes, { prefix: "/api/crew" });
  app.register(registerA2ARoutes, { prefix: "/api/a2a" });
  // ADR-0043 blocking questions (event-spine; agent asks, operator answers).
  app.register(registerQuestionRoutes, { prefix: "/api/questions" });
  app.register(registerReviewThreadRoutes, { prefix: "/api/review-thread" });
  // ADR-0038 D1 slice 1: DISCOVER only — a read of the vendor configs the user
  // already has. There is no enable route here and adding one needs that ADR's
  // two open questions answered first.
  app.register(registerCompatibilityRoutes, { prefix: "/api/compatibility" });

  return app;
}
