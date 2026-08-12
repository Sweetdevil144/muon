import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVASION_CORPUS,
  evasionPayloads,
  isDangerousCodePoint,
  residualDanger,
  type EvasionClass,
} from "../src/evasion-corpus.js";
import { blockingQuestionAskSchema } from "../src/blocking-question.js";
import { peerMessageSendSchema } from "../src/a2a.js";

// Round-3 #8. Two jobs here: prove the corpus is a real corpus (it carries
// live payloads, covers every class, and does not smuggle hostile bytes into
// its own source), and replay it against the protocol-layer surfaces that are
// supposed to REFUSE — the schemas.

const ALL_CLASSES: EvasionClass[] = [
  "invisible-directive",
  "reorder",
  "repaint",
  "row-forgery",
  "homoglyph",
  "normalization",
];

describe("the corpus is a corpus", () => {
  it("carries every declared class, with unique ids and a stated threat", () => {
    const ids = EVASION_CORPUS.map((payload) => payload.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const attack of ALL_CLASSES) {
      expect(
        EVASION_CORPUS.some((payload) => payload.attack === attack),
        `no payload covers ${attack}`
      ).toBe(true);
    }
    for (const payload of EVASION_CORPUS) {
      expect(payload.threat.length, payload.id).toBeGreaterThan(20);
      expect(payload.text.length, payload.id).toBeGreaterThan(0);
    }
  });

  it("every payload really carries what it claims to carry", () => {
    // A corpus of inert strings is worse than no corpus: it makes every
    // surface look hardened. Each payload must contain a code point its
    // class is actually about.
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      expect(
        residualDanger(payload.text).length,
        `${payload.id} carries nothing dangerous`
      ).toBeGreaterThan(0);
    }
    // The confusable/normalization classes are printable by nature — they are
    // dangerous by MEANING, not by code point — so they assert differently.
    //
    // The old assertion here was `not.toMatch(/^[\x20-\x7e]*$/)`, which any
    // non-ASCII byte satisfies: "café" and an emoji both passed. It asserted
    // nothing about CONFUSABILITY, which is the whole class. The real
    // property is that the payload NFKC-folds onto the trusted label it
    // impersonates while not already being that label.
    for (const payload of evasionPayloads("homoglyph")) {
      // The MECHANISM is a code point from a confusable script block sitting
      // in a Latin word. NFKC folding is NOT the shared property — it folds
      // the fullwidth payload onto "MUON" but leaves Cyrillic untouched,
      // because Cyrillic M is a different letter, not a compatibility form.
      const confusable = [...payload.text].some((character) => {
        const code = character.codePointAt(0)!;
        return (
          (code >= 0x0370 && code <= 0x03ff) || // Greek
          (code >= 0x0400 && code <= 0x04ff) || // Cyrillic
          (code >= 0xff00 && code <= 0xffef) // fullwidth forms
        );
      });
      expect(
        confusable,
        `${payload.id} carries no confusable-script code point`
      ).toBe(true);
      expect(
        payload.text.toUpperCase().includes("MUON"),
        `${payload.id} is literally the label, so it confuses nothing`
      ).toBe(false);
    }
    for (const payload of evasionPayloads("normalization")) {
      // The shared property is a COMBINING MARK: the rendered glyph is not
      // what the code points spell.
      expect(payload.text, `${payload.id} carries no combining mark`).toMatch(
        /\p{Mn}/u
      );
    }
    // Each normalization payload pins its OWN documented behaviour, because
    // the two differ: an overlay has no precomposed twin (NFC-stable) while
    // the decomposed form does. One rule for both would be satisfied by
    // either and prove neither.
    const overlay = EVASION_CORPUS.find(
      (payload) => payload.id === "combining-overlay"
    )!;
    expect(overlay.text.normalize("NFC")).toBe(overlay.text);
    // The decomposed payload additionally has to be NFC-UNSTABLE — that is
    // its stated threat (an allowlist comparing NFC forms misses it).
    const decomposed = EVASION_CORPUS.find(
      (payload) => payload.id === "decomposed-form"
    )!;
    expect(decomposed.text.normalize("NFC")).not.toBe(decomposed.text);
  });

  it("its own source file contains no literal control byte", () => {
    // The first draft of this module was written with escape sequences and
    // the bytes landed RAW in the file. The corpus that exists to keep
    // hostile characters out of trusted frames must not smuggle them into
    // its own diff, review dialog, or git history.
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "evasion-corpus.ts"
      ),
      "utf8"
    );
    // \r is subtracted so a CRLF checkout does not false-fail; the point is
    // hostile characters, not line endings.
    expect(residualDanger(source, ["\n", "\t", "\r"])).toEqual([]);
  });

  it("residualDanger subtracts exactly what a surface says it preserves", () => {
    const withNewline = `a${String.fromCodePoint(0x0a)}b`;
    expect(residualDanger(withNewline)).toEqual(["U+000A"]);
    expect(residualDanger(withNewline, ["\n"])).toEqual([]);
    expect(isDangerousCodePoint(0x1b)).toBe(true);
    expect(isDangerousCodePoint(0x9b)).toBe(true);
    expect(isDangerousCodePoint(0x41)).toBe(false);
  });

  it("filtering by class returns that class, and no args returns everything", () => {
    expect(evasionPayloads()).toHaveLength(EVASION_CORPUS.length);
    const reorder = evasionPayloads("reorder");
    expect(reorder.length).toBeGreaterThan(0);
    expect(reorder.every((payload) => payload.attack === "reorder")).toBe(true);
  });
});

describe("replay: the schemas that REFUSE (ADR-0043 questions)", () => {
  it("a question SUBJECT refuses every control-carrying payload", () => {
    // The subject is one row on an operator surface, so it admits no control
    // character at all — including the invisible-directive and bidi classes
    // that a naive C0-only filter would pass.
    for (const payload of evasionPayloads(
      "repaint",
      "row-forgery",
      "reorder",
      "invisible-directive"
    )) {
      const parsed = blockingQuestionAskSchema.safeParse({
        subject: payload.text,
        body: "b",
      });
      expect(parsed.success, `subject accepted ${payload.id}`).toBe(false);
    }
  });

  it("a question BODY refuses repaint payloads but keeps legitimate newlines", () => {
    for (const payload of evasionPayloads("repaint")) {
      const parsed = blockingQuestionAskSchema.safeParse({
        subject: "s",
        body: payload.text,
      });
      expect(parsed.success, `body accepted ${payload.id}`).toBe(false);
    }
    expect(
      blockingQuestionAskSchema.safeParse({
        subject: "s",
        body: "line one\n\tline two",
      }).success
    ).toBe(true);
  });

  it("a peer message is LENGTH-bounded only — it is the sanitizer's job, and the corpus says so", () => {
    // Deliberately documented rather than "fixed": peer bodies are rendered
    // through terminalSafe/terminalSafeBlock at every surface, and narrowing
    // the schema here would silently drop a peer's legitimate multi-line
    // report. The replay proves the boundary is where the docs claim.
    const accepted = peerMessageSendSchema.safeParse({
      to: { kind: "crew" },
      kind: "status",
      subject: "status",
      body: evasionPayloads("repaint")[0]!.text,
      refs: { files: [], symbols: [] },
    });
    expect(accepted.success).toBe(true);
  });
});
