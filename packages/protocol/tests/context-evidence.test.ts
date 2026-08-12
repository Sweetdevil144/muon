import { describe, expect, it } from "vitest";
import {
  contextCondensationInputSchema,
  contextExposureInputSchema,
  contextFrameBeginSchema,
  contextFrameDeliveryInputSchema,
} from "../src/context-evidence.js";

describe("context evidence protocol", () => {
  it("keeps eligibility separate from actual inclusion", () => {
    expect(
      contextExposureInputSchema.safeParse({
        artifactKind: "memory_note",
        artifactId: "note-1",
        eligible: false,
        included: true,
        reason: "memory_slice",
      }).success
    ).toBe(false);
    expect(
      contextExposureInputSchema.safeParse({
        artifactKind: "memory_note",
        artifactId: "note-1",
        eligible: true,
        included: false,
        reason: "memory_slice",
      }).success
    ).toBe(true);
    expect(
      contextExposureInputSchema.safeParse({
        artifactKind: "memory_note",
        artifactId: "note-1",
        eligible: true,
        included: true,
        reason: "memory_slice",
      }).success
    ).toBe(false);
  });

  it("bounds and types exact frame content", () => {
    expect(
      contextFrameBeginSchema.safeParse({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        source: "dispatch",
        content: "exact bytes",
      }).success
    ).toBe(true);
    expect(
      contextFrameBeginSchema.safeParse({
        clientRequestId: "not-a-uuid",
        source: "vendor_hidden",
        content: "",
      }).success
    ).toBe(false);
    expect(
      contextFrameBeginSchema.safeParse({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        source: "dispatch",
        content: "exact bytes",
        exposures: [
          {
            artifactKind: "memory_note",
            artifactId: "note-1",
            eligible: true,
            included: true,
            ordinal: 1,
            reason: "memory_slice",
          },
        ],
      }).success
    ).toBe(false);
  });

  it("refuses invented vendor context and incomplete MUON condensations", () => {
    expect(
      contextCondensationInputSchema.safeParse({
        sourceResponseId: "codex:item:1",
        origin: "vendor_reported",
        summary: "not disclosed",
        members: [],
      }).success
    ).toBe(false);
    expect(
      contextCondensationInputSchema.safeParse({
        sourceResponseId: "muon:1",
        origin: "muon",
        inputFrameId: "frame-1",
        outputFrameId: "frame-2",
        summary: "exact summary",
        members: [],
      }).success
    ).toBe(false);
    expect(
      contextCondensationInputSchema.safeParse({
        sourceResponseId: "codex:item:1",
        origin: "vendor_reported",
        members: [],
      }).success
    ).toBe(true);
    expect(
      contextCondensationInputSchema.safeParse({
        sourceResponseId: "muon:2",
        origin: "muon",
        inputFrameId: "frame-1",
        outputFrameId: "frame-2",
        summary: "exact replayable summary",
        summaryOffset: 17,
        members: [
          { artifactKind: "memory_note", artifactId: "note-1" },
        ],
      }).success
    ).toBe(true);
    expect(
      contextCondensationInputSchema.safeParse({
        sourceResponseId: "muon:3",
        origin: "muon",
        inputFrameId: "frame-1",
        outputFrameId: "frame-1",
        summary: "not a new compacted view",
        summaryOffset: 0,
        members: [
          { artifactKind: "memory_note", artifactId: "note-1" },
        ],
      }).success
    ).toBe(false);
  });

  it("requires terminal delivery receipts to explain only failures", () => {
    expect(
      contextFrameDeliveryInputSchema.safeParse({ status: "failed" }).success
    ).toBe(false);
    expect(
      contextFrameDeliveryInputSchema.safeParse({
        status: "delivered",
        failure: "contradiction",
      }).success
    ).toBe(false);
    expect(
      contextFrameDeliveryInputSchema.safeParse({
        status: "failed",
        failure: "transport refused the prompt",
      }).success
    ).toBe(true);
  });
});
