import { describe, expect, it } from "vitest";
import {
  citationsByNote,
  describeCitation,
  orderForInjection,
  partitionCited,
  type CitationSource,
} from "../src/lib/cited-findings.js";

// ADR-0035. The load-bearing property is structural: this module is handed the
// notes the reader's own governed read returned and only reorders them, so a
// citation cannot promote a tier or reach across a partition. The tests below
// pin the behaviour that could erode that if someone "improved" it.

function message(over: Partial<CitationSource> = {}): CitationSource {
  return {
    id: "msg-1",
    fromJobId: "job-reviewer",
    fromRole: "reviewer",
    kind: "review_verdict",
    createdAt: "2026-08-07T10:00:00.000Z",
    refs: { noteIds: ["note-1"] },
    ...over,
  };
}

describe("which messages carry a finding", () => {
  it("accepts the finding kinds", () => {
    for (const kind of ["review_verdict", "constraint", "blocked"]) {
      const found = citationsByNote([message({ kind })], "job-impl");
      expect(found.has("note-1"), kind).toBe(true);
    }
  });

  it("ignores chatter kinds — a status ping is not a finding", () => {
    for (const kind of ["status", "question", "answer", "review_request"]) {
      const found = citationsByNote([message({ kind })], "job-impl");
      expect(found.size, kind).toBe(0);
    }
  });

  it("ignores a message that cites nothing", () => {
    expect(citationsByNote([message({ refs: null })], "job-impl").size).toBe(0);
    expect(
      citationsByNote([message({ refs: { noteIds: [] } })], "job-impl").size
    ).toBe(0);
  });

  it("drops a self-citation", () => {
    // A lane pointing at its own note has learned nothing from the crew, and
    // labelling it as a peer finding would be a lie.
    const found = citationsByNote(
      [message({ fromJobId: "job-impl" })],
      "job-impl"
    );
    expect(found.size).toBe(0);
  });

  it("keeps the most recent citation when several peers cite one note", () => {
    const found = citationsByNote(
      [
        message({
          id: "old",
          fromJobId: "job-a",
          fromRole: "qa",
          createdAt: "2026-08-07T09:00:00.000Z",
        }),
        message({
          id: "new",
          fromJobId: "job-b",
          fromRole: "reviewer",
          createdAt: "2026-08-07T11:00:00.000Z",
        }),
      ],
      "job-impl"
    );
    expect(found.get("note-1")?.messageId).toBe("new");
    expect(found.get("note-1")?.role).toBe("reviewer");
  });

  it("accepts a Date as well as an ISO string", () => {
    const found = citationsByNote(
      [message({ createdAt: new Date("2026-08-07T10:00:00.000Z") })],
      "job-impl"
    );
    expect(found.get("note-1")?.createdAt).toBe("2026-08-07T10:00:00.000Z");
  });
});

describe("ADR-0035 D1 — a citation cannot surface what the reader could not see", () => {
  it("silently ignores a citation to a note not in the candidate set", () => {
    // The candidates ARE the reader's governed read. A note the reader cannot
    // reach is simply absent, and the citation does nothing — no error, no
    // hint that the id resolved to anything anywhere (that would be an
    // existence oracle, ADR-0033 D2a).
    const citations = citationsByNote(
      [message({ refs: { noteIds: ["note-elsewhere"] } })],
      "job-impl"
    );
    const { cited, uncited } = partitionCited(
      [{ id: "note-mine" }],
      citations
    );
    expect(cited).toEqual([]);
    expect(uncited).toEqual([{ id: "note-mine" }]);
  });

  it("never invents a note — output length always equals input length", () => {
    const citations = citationsByNote(
      [
        message({ refs: { noteIds: ["note-1", "note-2", "note-ghost"] } }),
      ],
      "job-impl"
    );
    const candidates = [{ id: "note-1" }, { id: "note-3" }];
    const ordered = orderForInjection(candidates, citations);
    expect(ordered).toHaveLength(candidates.length);
    expect(ordered.map((e) => e.note.id).sort()).toEqual(["note-1", "note-3"]);
  });
});

describe("ADR-0035 D4 — one shared budget, findings first", () => {
  it("puts cited findings ahead of standing notes", () => {
    const citations = citationsByNote(
      [message({ refs: { noteIds: ["note-cited"] } })],
      "job-impl"
    );
    const ordered = orderForInjection(
      [{ id: "note-standing" }, { id: "note-cited" }],
      citations
    );
    expect(ordered.map((e) => e.note.id)).toEqual([
      "note-cited",
      "note-standing",
    ]);
    expect(ordered[0]!.citedBy?.role).toBe("reviewer");
    expect(ordered[1]!.citedBy).toBeUndefined();
  });

  it("preserves the incoming order within each group", () => {
    const citations = citationsByNote(
      [message({ refs: { noteIds: ["c1", "c2"] } })],
      "job-impl"
    );
    const ordered = orderForInjection(
      [{ id: "s1" }, { id: "c1" }, { id: "s2" }, { id: "c2" }],
      citations
    );
    expect(ordered.map((e) => e.note.id)).toEqual(["c1", "c2", "s1", "s2"]);
  });

  it("is a no-op ordering when nothing is cited", () => {
    const ordered = orderForInjection(
      [{ id: "a" }, { id: "b" }],
      new Map()
    );
    expect(ordered.map((e) => e.note.id)).toEqual(["a", "b"]);
    expect(ordered.every((e) => e.citedBy === undefined)).toBe(true);
  });
});

describe("ADR-0035 D2 — the label carries coordinates, never prose", () => {
  it("names the role and the message kind and nothing else", () => {
    const citations = citationsByNote([message()], "job-impl");
    const label = describeCitation(citations.get("note-1")!);
    expect(label).toBe("cited by reviewer (review_verdict)");
  });

  it("has no field that could carry a message body", () => {
    const citations = citationsByNote([message()], "job-impl");
    const citation = citations.get("note-1")!;
    expect(Object.keys(citation).sort()).toEqual([
      "createdAt",
      "jobId",
      "kind",
      "messageId",
      "role",
    ]);
  });
});

describe("refs arrives as arbitrary stored JSON", () => {
  // It comes out of the database as JsonValue, so it is narrowed rather than
  // trusted: a malformed refs must yield no citations, never throw inside a
  // gate read. A finding that cannot be parsed is a finding not delivered.
  it("survives every shape a JSON column can hold", () => {
    for (const refs of [
      null,
      undefined,
      "a string",
      42,
      true,
      [],
      ["note-1"],
      {},
      { noteIds: null },
      { noteIds: "note-1" },
      { noteIds: 7 },
      { other: ["note-1"] },
    ]) {
      const label = JSON.stringify(refs) ?? "undefined";
      expect(() => citationsByNote([message({ refs })], "job-impl"), label).not.toThrow();
      expect(citationsByNote([message({ refs })], "job-impl").size, label).toBe(0);
    }
  });

  it("takes only the string ids out of a mixed array", () => {
    const found = citationsByNote(
      [message({ refs: { noteIds: ["note-1", 7, null, "", "note-2"] } })],
      "job-impl"
    );
    expect([...found.keys()].sort()).toEqual(["note-1", "note-2"]);
  });
});

describe("slice 3 — the finding kind joins the citation channel", () => {
  it("a publish_finding message cites its own note", () => {
    // Slice 2 built the atomic publish with `refs.noteIds` carrying the note
    // id — made for this join and then never added to FINDING_KINDS, so the
    // one kind NAMED "finding" was the one kind the citation channel ignored.
    // The label matters on the day the note is human-confirmed: the gate then
    // carries "cited by reviewer (finding)" instead of an unlabeled note.
    const citations = citationsByNote(
      [
        {
          id: "msg-1",
          fromJobId: "job-finder",
          fromRole: "reviewer",
          kind: "finding",
          createdAt: "2026-08-11T00:00:00.000Z",
          refs: { files: [], symbols: [], noteIds: ["note-1"] },
        },
      ],
      "job-editor"
    );
    const citation = citations.get("note-1");
    expect(citation, "the finding kind produces a citation").toBeTruthy();
    expect(citation!.kind).toBe("finding");
    expect(citation!.role).toBe("reviewer");
  });

  it("chatter kinds still do not cite", () => {
    const citations = citationsByNote(
      [
        {
          id: "msg-2",
          fromJobId: "job-finder",
          fromRole: "reviewer",
          kind: "status",
          createdAt: "2026-08-11T00:00:00.000Z",
          refs: { noteIds: ["note-2"] },
        },
      ],
      "job-editor"
    );
    expect(citations.get("note-2")).toBeUndefined();
  });
});
