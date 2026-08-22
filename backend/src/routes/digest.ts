import { classifyHandoffPacket } from "@muon/client";
import {
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_CREW_CONTEXT_EVENT_KIND,
  QUESTION_PREANSWER_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
} from "@muon/protocol";
import type { FastifyInstance } from "fastify";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import {
  daemonAttachState,
  previousSessionEnd,
} from "../lib/surface-attendance.js";

/**
 * ADR-0085 — the desk digests since you last looked.
 *
 * ONE derived read over ledgers that already exist, anchored on the
 * PREVIOUS absence boundary (`previousSessionEndedAt` — the ended
 * session's last look, rolled atomically by the presence stamp). No digest
 * table, no cursor state beyond the two attendance fields, and no event
 * bus: the digest is evidence enumerated at read time, never a summary.
 *
 * D3 — every section is honest about its window: it carries the TOTAL
 * count and a truncation flag beside its bounded items, so "3 gates
 * (complete)" and "41 events (truncated)" can never read as the same
 * sentence. Items are chronological (oldest first): the digest replays the
 * absence in order.
 *
 * The digest is NAVIGATION (D2): ids + coordinates + classification
 * words, never a second rendering of the objects themselves. The one
 * bounded exception is a short subject slice on findings — the inbox
 * already renders subjects to this same operator tier.
 */

/** Per-section item bound. The count beside it is always the full total. */
const DIGEST_SECTION_LIMIT = 20;

/** The fork section filters chat roots in application memory, so its SCAN
 *  is bounded too (review finding: every other section bounds its query).
 *  Hitting this cap marks the section truncated — honesty over precision. */
const FORK_SCAN_CAP = 200;

const QUESTION_EVENT_KINDS = [
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
  QUESTION_PREANSWER_EVENT_KIND,
  QUESTION_CREW_CONTEXT_EVENT_KIND,
];

type DigestSection<T> = {
  count: number;
  truncated: boolean;
  items: T[];
};

function section<T>(count: number, items: T[]): DigestSection<T> {
  return { count, truncated: count > items.length, items };
}

export async function registerDigestRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    requireOperator(app, request);
    const boundary = previousSessionEnd();
    const state = daemonAttachState();
    if (boundary === null) {
      // No previous session is recorded — say so rather than inventing a
      // boundary (an absent anchor digested as "everything ever" would be
      // the fabricated-zero shape, inverted).
      return {
        since: null,
        lastSeenAt: state.lastAttachedAt,
        note: "No previous session boundary is recorded yet — the digest starts after your first return from an absence.",
        sections: null,
      };
    }
    const since = new Date(boundary);

    const [
      gatesOpenedCount,
      gatesOpened,
      gatesDecidedCount,
      gatesDecided,
      packetsCount,
      packets,
      questionEventsCount,
      questionEvents,
      forkCandidates,
      findingsCount,
      findings,
      contradictionsCount,
      contradictions,
      // ONE read snapshot (review finding): counts and items must not be
      // able to disagree about the same window under concurrent writes —
      // a batch transaction reads them atomically. The chat-root lookup
      // below stays outside deliberately: its race direction is a fork
      // honestly missing, never a fabricated one.
    ] = await prisma.$transaction([
      prisma.approvalRequest.count({ where: { createdAt: { gt: since } } }),
      prisma.approvalRequest.findMany({
        where: { createdAt: { gt: since } },
        orderBy: { createdAt: "asc" },
        take: DIGEST_SECTION_LIMIT,
        select: { id: true, taskId: true, kind: true, createdAt: true },
      }),
      prisma.approvalRequest.count({
        where: { decidedAt: { gt: since } },
      }),
      prisma.approvalRequest.findMany({
        where: { decidedAt: { gt: since } },
        orderBy: { decidedAt: "asc" },
        take: DIGEST_SECTION_LIMIT,
        select: {
          id: true,
          taskId: true,
          kind: true,
          status: true,
          decidedAt: true,
        },
      }),
      prisma.handoff.count({ where: { createdAt: { gt: since } } }),
      prisma.handoff.findMany({
        where: { createdAt: { gt: since } },
        orderBy: { createdAt: "asc" },
        take: DIGEST_SECTION_LIMIT,
        select: { id: true, taskId: true, packetJson: true, createdAt: true },
      }),
      prisma.event.count({
        where: {
          kind: { in: QUESTION_EVENT_KINDS },
          timestamp: { gt: since },
        },
      }),
      prisma.event.findMany({
        where: {
          kind: { in: QUESTION_EVENT_KINDS },
          timestamp: { gt: since },
        },
        orderBy: { timestamp: "asc" },
        take: DIGEST_SECTION_LIMIT,
        select: { taskId: true, kind: true, timestamp: true },
      }),
      // Fork MISSIONS, not inherited crew tasks: a mission root is the task
      // its own chat anchors on; filtered below against the chat rows.
      prisma.task.findMany({
        where: {
          forkSourceTaskId: { not: null },
          createdAt: { gt: since },
        },
        orderBy: { createdAt: "asc" },
        take: FORK_SCAN_CAP,
        select: {
          id: true,
          title: true,
          chatId: true,
          forkSourceTaskId: true,
          createdAt: true,
        },
      }),
      prisma.peerMessage.count({
        where: { kind: "finding", createdAt: { gt: since } },
      }),
      prisma.peerMessage.findMany({
        where: { kind: "finding", createdAt: { gt: since } },
        orderBy: { createdAt: "asc" },
        take: DIGEST_SECTION_LIMIT,
        select: {
          id: true,
          missionId: true,
          subject: true,
          memoryNoteId: true,
          createdAt: true,
        },
      }),
      prisma.memoryEdge.count({
        where: { kind: "contradicts", at: { gt: since } },
      }),
      prisma.memoryEdge.findMany({
        where: { kind: "contradicts", at: { gt: since } },
        orderBy: { at: "asc" },
        take: DIGEST_SECTION_LIMIT,
        select: { fromId: true, toId: true, at: true },
      }),
    ] as const);

    const forkChatRoots = new Map(
      (
        await prisma.orchestratorChat.findMany({
          where: {
            id: { in: forkCandidates.flatMap((t) => (t.chatId ? [t.chatId] : [])) },
          },
          select: { id: true, taskId: true },
        })
      ).map((chat) => [chat.id, chat.taskId])
    );
    const forkMissions = forkCandidates.filter(
      (task) => task.chatId && forkChatRoots.get(task.chatId) === task.id
    );

    // Receipts ride the wrap packet (0062); a packet's classification is
    // THE shared classifier's word, never re-derived here — a schema
    // fragment reads `packet_parse_failed`, as loudly as the desk says it.
    let receiptsMinted = 0;
    const packetItems = packets.map((row) => {
      const classified = classifyHandoffPacket(row.packetJson);
      if (classified.packet?.brainReceipt) receiptsMinted += 1;
      return {
        id: row.id,
        taskId: row.taskId,
        classification: classified.contract,
        at: row.createdAt,
      };
    });

    return {
      since: boundary,
      lastSeenAt: state.lastAttachedAt,
      sections: {
        gatesOpened: section(gatesOpenedCount, gatesOpened),
        gatesDecided: section(gatesDecidedCount, gatesDecided),
        packets: {
          ...section(packetsCount, packetItems),
          /** Counted over the WINDOW items only — the bounded view; the
           *  flag beside it says when the window clipped. */
          receiptsMinted,
        },
        questions: section(questionEventsCount, questionEvents),
        forks: {
          count: forkMissions.length,
          // Truncated when the display clipped OR the scan hit its cap —
          // at the cap the count itself may understate, and D3 forbids
          // letting that read as complete.
          truncated:
            forkMissions.length > DIGEST_SECTION_LIMIT ||
            forkCandidates.length === FORK_SCAN_CAP,
          // At the cap the count is a FLOOR, not a total (review finding:
          // a truncation flag alone does not stop "N total" from being
          // materially false); the pane renders "≥N" when this is false.
          countExact: forkCandidates.length < FORK_SCAN_CAP,
          items: forkMissions.slice(0, DIGEST_SECTION_LIMIT).map((task) => ({
            taskId: task.id,
            title: task.title,
            forkSourceTaskId: task.forkSourceTaskId,
            at: task.createdAt,
          })),
        },
        findings: section(
          findingsCount,
          findings.map((row) => ({
            id: row.id,
            missionId: row.missionId,
            subject: row.subject.slice(0, 80),
            memoryNoteId: row.memoryNoteId,
            at: row.createdAt,
          }))
        ),
        contradictions: section(contradictionsCount, contradictions),
      },
    };
  });
}
