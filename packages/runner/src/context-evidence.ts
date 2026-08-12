import { randomUUID } from "node:crypto";
import type {
  ContextCondensationInput,
  ContextExposureInput,
  ContextFrameSource,
} from "@muon/protocol";
import { redactForLog } from "@muon/core";
import type {
  ContextCondensationRecord,
  ContextFrameRecord,
} from "@muon/client";

export type ContextEvidenceLease = { host: string; leaseToken: string };

export type ContextEvidenceClient = {
  beginContextFrameForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
    clientRequestId: string;
    source: ContextFrameSource;
    content: string;
    exposures?: ContextExposureInput[];
  }): Promise<ContextFrameRecord>;
  completeContextFrameForLease(input: {
    jobId: string;
    frameId: string;
    host: string;
    leaseToken: string;
    status: "delivered" | "failed";
    sessionId?: string;
    vendorSessionId?: string;
    failure?: string;
  }): Promise<ContextFrameRecord>;
  recordContextCondensationForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
  } & ContextCondensationInput): Promise<ContextCondensationRecord>;
};

export type ContextEvidenceRecorder = {
  begin(input: {
    source: ContextFrameSource;
    content: string;
    exposures?: ContextExposureInput[];
  }): Promise<ContextFrameRecord>;
  delivered(
    frame: ContextFrameRecord,
    destination?: { sessionId?: string; vendorSessionId?: string }
  ): Promise<ContextFrameRecord>;
  failed(frame: ContextFrameRecord, error: unknown): Promise<ContextFrameRecord>;
  vendorCompacted(input: {
    sourceResponseId: string;
    inputFrameId?: string;
  }): Promise<ContextCondensationRecord>;
  latestDeliveredFrameId(): string | undefined;
};

function boundedFailure(error: unknown): string {
  return redactForLog(error, 2_000) || "vendor delivery failed";
}

/**
 * Durable evidence at MUON's transport boundary. A frame proves only that MUON
 * supplied exact bytes to a delivery attempt; the append-only receipt records
 * whether the transport accepted them. Neither claim says the model attended
 * to, retained, or used those bytes.
 */
export function createContextEvidenceRecorder(input: {
  client: ContextEvidenceClient;
  jobId: string;
  lease: ContextEvidenceLease;
}): ContextEvidenceRecorder {
  let latestDelivered: string | undefined;
  const base = {
    jobId: input.jobId,
    host: input.lease.host,
    leaseToken: input.lease.leaseToken,
  };
  return {
    async begin(frame) {
      return input.client.beginContextFrameForLease({
        ...base,
        clientRequestId: randomUUID(),
        ...frame,
      });
    },
    async delivered(frame, destination = {}) {
      const completed = await input.client.completeContextFrameForLease({
        ...base,
        frameId: frame.id,
        status: "delivered",
        ...destination,
      });
      latestDelivered = frame.id;
      return completed;
    },
    async failed(frame, error) {
      return input.client.completeContextFrameForLease({
        ...base,
        frameId: frame.id,
        status: "failed",
        failure: boundedFailure(error),
      });
    },
    vendorCompacted(marker) {
      return input.client.recordContextCondensationForLease({
        ...base,
        origin: "vendor_reported",
        sourceResponseId: marker.sourceResponseId,
        ...(marker.inputFrameId
          ? { inputFrameId: marker.inputFrameId }
          : latestDelivered
            ? { inputFrameId: latestDelivered }
            : {}),
        members: [],
      });
    },
    latestDeliveredFrameId() {
      return latestDelivered;
    },
  };
}

/** Test doubles predating the evidence API stay valid; production clients ship all three. */
export function supportsContextEvidence(
  client: object
): client is ContextEvidenceClient {
  const candidate = client as Partial<ContextEvidenceClient>;
  return (
    typeof candidate.beginContextFrameForLease === "function" &&
    typeof candidate.completeContextFrameForLease === "function" &&
    typeof candidate.recordContextCondensationForLease === "function"
  );
}
