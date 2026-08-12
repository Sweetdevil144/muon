import { z } from "zod";

/**
 * Exact MUON-supplied prompt bytes are retained so a later audit can replay
 * what crossed MUON's delivery boundary. This is also a hard prompt bound: a
 * frame that cannot be recorded whole is refused instead of stored as a lie.
 */
export const CONTEXT_FRAME_CONTENT_CHARS = 256 * 1024;
export const CONTEXT_FRAME_EXPOSURES_MAX = 256;
export const CONTEXT_CONDENSATION_MEMBERS_MAX = 2_048;

export const contextFrameSourceSchema = z.enum([
  "dispatch",
  "loop",
  "steer",
  "tool_result",
]);
export type ContextFrameSource = z.infer<typeof contextFrameSourceSchema>;

export const contextArtifactKindSchema = z.enum([
  "memory_note",
  "peer_message",
  "event",
  "stream_chunk",
  "condensation_summary",
]);
export type ContextArtifactKind = z.infer<typeof contextArtifactKindSchema>;

export const contextExposureInputSchema = z
  .object({
    artifactKind: contextArtifactKindSchema,
    artifactId: z.string().min(1).max(512),
    eligible: z.boolean(),
    included: z.boolean(),
    reason: z.string().min(1).max(80),
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(CONTEXT_FRAME_EXPOSURES_MAX - 1)
      .optional(),
    charCount: z.number().int().min(0).max(CONTEXT_FRAME_CONTENT_CHARS).optional(),
    trustTier: z
      .enum(["human_confirmed", "crew_vouched", "trust_floor"])
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.included && !value.eligible) {
      ctx.addIssue({
        code: "custom",
        message: "An included artifact must also be prompt-eligible.",
        path: ["included"],
      });
    }
    if (value.included !== (value.ordinal !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Only included artifacts carry a render ordinal.",
        path: ["ordinal"],
      });
    }
  });
export type ContextExposureInput = z.infer<typeof contextExposureInputSchema>;

export const contextFrameBeginSchema = z
  .object({
    clientRequestId: z.uuid(),
    source: contextFrameSourceSchema,
    content: z.string().min(1).max(CONTEXT_FRAME_CONTENT_CHARS),
    exposures: z
      .array(contextExposureInputSchema)
      .max(CONTEXT_FRAME_EXPOSURES_MAX)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const identities = new Set<string>();
    for (const [index, exposure] of value.exposures.entries()) {
      const identity = `${exposure.artifactKind}\0${exposure.artifactId}\0${exposure.reason}`;
      if (identities.has(identity)) {
        ctx.addIssue({
          code: "custom",
          message: "A frame may evaluate one artifact/reason pair only once.",
          path: ["exposures", index],
        });
      }
      identities.add(identity);
    }
    const ordinals = value.exposures
      .filter((exposure) => exposure.included)
      .map((exposure) => exposure.ordinal!)
      .sort((a, b) => a - b);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      ctx.addIssue({
        code: "custom",
        message: "Included exposure ordinals must be unique and contiguous from zero.",
        path: ["exposures"],
      });
    }
  });
export type ContextFrameBegin = z.infer<typeof contextFrameBeginSchema>;

export const contextFrameDeliveryStatusSchema = z.enum(["delivered", "failed"]);
export type ContextFrameDeliveryStatus = z.infer<
  typeof contextFrameDeliveryStatusSchema
>;

export const contextFrameDeliveryInputSchema = z
  .object({
    status: contextFrameDeliveryStatusSchema,
    sessionId: z.string().min(1).max(512).optional(),
    vendorSessionId: z.string().min(1).max(512).optional(),
    failure: z.string().min(1).max(2_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "failed" && value.failure === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A failed context delivery requires a bounded failure reason.",
        path: ["failure"],
      });
    }
    if (value.status === "delivered" && value.failure !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A delivered context frame cannot also claim failure.",
        path: ["failure"],
      });
    }
  });
export type ContextFrameDeliveryInput = z.infer<
  typeof contextFrameDeliveryInputSchema
>;

export const contextCondensationOriginSchema = z.enum([
  "muon",
  "vendor_reported",
]);
export type ContextCondensationOrigin = z.infer<
  typeof contextCondensationOriginSchema
>;

export const contextCondensationMemberSchema = z.object({
  artifactKind: contextArtifactKindSchema,
  artifactId: z.string().min(1).max(512),
});
export type ContextCondensationMember = z.infer<
  typeof contextCondensationMemberSchema
>;

export const contextCondensationInputSchema = z
  .object({
    sourceResponseId: z.string().min(1).max(512),
    origin: contextCondensationOriginSchema,
    inputFrameId: z.string().min(1).max(512).optional(),
    outputFrameId: z.string().min(1).max(512).optional(),
    summary: z.string().min(1).max(CONTEXT_FRAME_CONTENT_CHARS).optional(),
    // UTF-8 byte offset in the output frame. Byte offsets are stable across
    // JavaScript, SQLite, and exported trajectory readers; string indexes are not.
    summaryOffset: z
      .number()
      .int()
      .min(0)
      .max(CONTEXT_FRAME_CONTENT_CHARS * 4)
      .optional(),
    members: z
      .array(contextCondensationMemberSchema)
      .max(CONTEXT_CONDENSATION_MEMBERS_MAX)
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (value.origin === "muon") {
      if (
        !value.inputFrameId ||
        !value.outputFrameId ||
        !value.summary ||
        value.summaryOffset === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "A MUON condensation requires input/output frames, the exact summary, and its insertion byte offset.",
        });
      }
      if (value.members.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "A MUON condensation must identify every forgotten artifact.",
          path: ["members"],
        });
      }
      if (
        value.inputFrameId !== undefined &&
        value.outputFrameId !== undefined &&
        value.inputFrameId === value.outputFrameId
      ) {
        ctx.addIssue({
          code: "custom",
          message: "A MUON condensation must produce a distinct output frame.",
          path: ["outputFrameId"],
        });
      }
    }
    if (
      value.origin === "vendor_reported" &&
      (value.summary !== undefined || value.members.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Vendor-reported compaction may not invent a summary or forgotten members the vendor did not disclose.",
      });
    }
  });
export type ContextCondensationInput = z.infer<
  typeof contextCondensationInputSchema
>;
