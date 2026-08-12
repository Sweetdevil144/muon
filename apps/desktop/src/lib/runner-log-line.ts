// runner.log is the file a human opens FIRST when a dispatch misbehaves, so
// every line has to answer "when, which job, which vendor" on its own.
//
// The runner loop emits terse, human-readable lines with NO timestamp and only
// an 8-char job id on some of them ("■ job 3b09571a → interrupted"), which made
// correlating a runner event with a backend event in brain.log impossible. This
// formatter is the desktop runner entry's output seam: it stamps every line
// with an ISO timestamp and, when the line belongs to a job, the job's short id
// and vendor — while keeping the original human-readable text intact.
//
// It is deliberately a PURE STRING TRANSFORM over the runner's existing output
// (no runner-side changes, no new env plumbing through the sandbox allowlist).

/** `▶ <vendor> · <kind> · job <id> · task <id>` — the line that opens a job. */
const JOB_START =
  /▶\s+(\S+)\s+·\s+(\S+)\s+·\s+job\s+([0-9a-fA-F][0-9a-fA-F-]{7,})/;

/** `■ job <short> → <status>` — the line that closes one. */
const JOB_END = /■\s+job\s+([0-9a-fA-F]{8})\s*→/;

/** Any bare 8-hex token: the short id shape the loop logs everywhere else. */
const SHORT_ID = /\b([0-9a-fA-F]{8})\b/g;

/**
 * Shapes where a bare 8-hex token is definitely a job id even though we never
 * saw the job open (e.g. a reclaim from a previous runner incarnation).
 */
const JOB_CONTEXT = [
  /\bjob\s+[0-9a-fA-F]{8}\b/,
  /^\s*[0-9a-fA-F]{8}:/,
  /\bfor\s+[0-9a-fA-F]{8}\b/,
];

/** Bound the in-memory job→vendor map; the runner is long-lived. */
const MAX_TRACKED_JOBS = 64;

export type RunnerLineFormatter = (line: string) => string;

function shortId(id: string): string {
  return id.slice(0, 8).toLowerCase();
}

/**
 * Build a formatter that prefixes `<ISO timestamp> [runner] ` and, when the
 * line is attributable to a dispatch job, `job=<short> vendor=<vendor> · `.
 *
 * The vendor is learned from the job's own `▶` line and forgotten when the job
 * goes terminal, so the map stays bounded across a long-lived runner.
 */
export function createRunnerLineFormatter(
  now: () => Date = () => new Date()
): RunnerLineFormatter {
  const vendors = new Map<string, string>();

  const remember = (id: string, vendor: string): void => {
    if (vendors.size >= MAX_TRACKED_JOBS) {
      const oldest = vendors.keys().next();
      if (!oldest.done) {
        vendors.delete(oldest.value);
      }
    }
    vendors.set(id, vendor);
  };

  const attribute = (
    text: string
  ): { id: string; vendor: string | null } | null => {
    const start = JOB_START.exec(text);
    if (start) {
      const id = shortId(start[3]);
      remember(id, start[1]);
      return { id, vendor: start[1] };
    }
    SHORT_ID.lastIndex = 0;
    const candidates = [...text.matchAll(SHORT_ID)].map((match) =>
      match[1].toLowerCase()
    );
    for (const candidate of candidates) {
      const vendor = vendors.get(candidate);
      if (vendor) {
        return { id: candidate, vendor };
      }
    }
    if (candidates.length > 0 && JOB_CONTEXT.some((shape) => shape.test(text))) {
      return { id: candidates[0]!, vendor: null };
    }
    return null;
  };

  return (line: string): string =>
    line
      .split("\n")
      .map((segment) => {
        // Preserve the loop's deliberate blank separator lines verbatim.
        if (segment.trim().length === 0) {
          return segment;
        }
        const stamp = now().toISOString();
        // The runner already prefixes `[runner] `; keep exactly one.
        const body = segment.replace(/^\[runner\]\s?/, "");
        const job = attribute(segment);
        const end = JOB_END.exec(segment);
        if (end) {
          vendors.delete(end[1].toLowerCase());
        }
        const tag = job
          ? `job=${job.id} vendor=${job.vendor ?? "unknown"} · `
          : "";
        return `${stamp} [runner] ${tag}${body}`;
      })
      .join("\n");
}
