import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { laneProfileSchema, type LaneEvent } from "@muon/protocol";
import { CodexAdapter } from "../src/codex-adapter.js";

/**
 * The one-shot/loop Codex lane, end to end over PIPES — the transport the
 * founder's `check_repair` child actually ran on.
 *
 * The stand-in binary emits the SAME stream a real `codex exec --json` emits
 * (captured live, 0.145.0) and writes the same `--output-last-message` file, so
 * this exercises the whole seam: the injected flags, the suppression of the raw
 * JSONL, the translated activity, the reconstructed `output`, and the terminal
 * rendering — without spawning the vendor.
 */
const FAKE_CODEX = `
const args = process.argv.slice(2);
const flag = args.indexOf("--output-last-message");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stderr.write("Reading additional input from stdin...\\n");
out({ type: "thread.started", thread_id: "019fa10c-5f2c-7862-8997-f800efbb95b6" });
out({ type: "turn.started" });
out({
  type: "item.started",
  item: { id: "i0", type: "mcp_tool_call", server: "muon", tool: "preflight_edit",
          arguments: { target: "x" }, status: "in_progress" },
});
out({
  type: "item.completed",
  item: { id: "i0", type: "mcp_tool_call", server: "muon", tool: "preflight_edit",
          arguments: { target: "x" }, result: { risk: "LOW" }, status: "completed" },
});
out({
  type: "item.completed",
  item: { id: "i1", type: "command_execution", command: "npm test",
          aggregated_output: "1 passing", exit_code: 0, status: "completed" },
});
out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "GOAL: shipped" } });
out({ type: "turn.completed", usage: {} });
if (flag >= 0) {
  require("node:fs").writeFileSync(args[flag + 1], "GOAL: shipped\\n");
}
`;

class FakeCodexAdapter extends CodexAdapter {
  constructor(
    private readonly script: string,
    guardHome: string
  ) {
    super({ prepareGuardHome: () => ({ home: guardHome, authLinked: false }) });
  }
  override taskCommand(brief: string) {
    // Stands where `codex exec … <brief>` stands: the brief is the sole
    // trailing positional, which is the invariant the flag injection must keep.
    return { command: process.execPath, args: [this.script, brief] };
  }
  protected override assertLaneBinaryAvailable(): void {
    // The stand-in above IS the binary for this test.
  }
}

describe("CodexAdapter pipes run — the vendor's machine stream reaches the feed", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "muon-codex-json-test-"));
    scratchDirs.push(dir);
    return dir;
  }

  async function run(profile?: unknown) {
    const dir = scratch();
    const script = join(dir, "fake-codex.cjs");
    writeFileSync(script, FAKE_CODEX);
    const adapter = new FakeCodexAdapter(script, scratch());
    const events: LaneEvent[] = [];
    const frames: { stream: string; data: string }[] = [];
    let vendorSessionId: string | undefined;
    const result = await adapter.runTask(
      { taskId: "task-1", brief: "fix the thing" },
      (event) => events.push(event),
      {
        cwd: dir,
        onBytes: (frame) => frames.push(frame),
        onVendorSessionId: (id) => {
          vendorSessionId = id;
        },
        ...(profile ? { profile: laneProfileSchema.parse(profile) } : {}),
      }
    );
    return { result, events, frames, vendorSessionId };
  }

  it("puts every tool call the child made into the stream as activity", async () => {
    const { events, result } = await run();
    expect(result.exitCode).toBe(0);
    const activity = events.filter((event) => event.metadata.codexActivity);
    expect(activity.map((event) => event.message)).toEqual([
      "muon.preflight_edit started",
      "muon.preflight_edit completed",
      "Codex command completed",
    ]);
  });

  it("never records the raw JSONL as the agent's words", async () => {
    const { events } = await run();
    const assistantOutput = events.filter(
      (event) =>
        event.kind === "task.progress" && event.metadata.controlPlane !== true
    );
    // Exactly the agent's own message, on the whole-message boundary.
    expect(assistantOutput.map((event) => event.message)).toEqual([
      "GOAL: shipped",
    ]);
    expect(JSON.stringify(events)).not.toContain('"thread.started"');
  });

  it("keeps `output` what every downstream reader expects — the final message", async () => {
    const { result } = await run();
    // Byte-for-byte what this path produced before `--json`: stdout was the
    // agent's final message and nothing else, so the handoff/report parsers
    // see exactly what they saw.
    expect(result.output).toBe("GOAL: shipped");
    expect(result.output).not.toContain("item.completed");
  });

  it("gains the vendor session id on a transport that never had one", async () => {
    const { vendorSessionId } = await run();
    expect(vendorSessionId).toBe("019fa10c-5f2c-7862-8997-f800efbb95b6");
  });

  it("shows the terminal MUON's rendering, not a JSON firehose", async () => {
    const { frames } = await run();
    const stdout = frames
      .filter((frame) => frame.stream === "stdout")
      .map((frame) => frame.data)
      .join("");
    expect(stdout).toContain("[muon] muon.preflight_edit completed");
    expect(stdout).not.toContain('"type":"item.completed"');
    // The vendor's stderr still passes through verbatim — under `--json` that
    // is where a fatal codex failure is written.
    expect(
      frames.filter((frame) => frame.stream === "stderr").map((f) => f.data).join("")
    ).toContain("Reading additional input");
  });

  it("injects --json and --output-last-message, brief still last", async () => {
    const { events } = await run();
    const started = events.find((event) => event.kind === "task.started")!;
    const args = started.metadata.args as string[];
    expect(args).toContain("--json");
    expect(args).toContain("--output-last-message");
    expect(args[args.length - 1]).toBe("fix the thing");
  });

  it("states this child's effective boundary — including that nothing gated it", async () => {
    const { events } = await run({
      sandbox: "workspace-write",
      permissionMode: "default",
      mcpServers: [{ name: "muon", command: "muon-mcp", args: [], env: {} }],
      deniedTools: ["Write", "mcp__muon__memory_delete"],
    });
    const notice = events.find(
      (event) => event.metadata.codexCapabilityDegraded !== undefined
    )!;
    expect(notice.metadata.controlPlane).toBe(true);
    expect(notice.metadata.codexApprovalGate).toBe("none");
    expect(notice.metadata.codexHonoredDenials).toEqual([
      "muon.memory_delete",
    ]);
    expect(notice.message).toContain("NO approval gate");
    expect(notice.message).toContain("sandbox_mode=workspace-write");
    // The native denial codex cannot express is NAMED, not dropped.
    expect(notice.message).toContain("Write");
  });

  it("says nothing about degradation when a run carries no profile at all", async () => {
    // A no-profile run still has no approval gate, so the notice is still owed
    // — what must not happen is a silent run OR a run that invents losses.
    const { events } = await run();
    const notice = events.find(
      (event) => event.metadata.codexCapabilityDegraded !== undefined
    )!;
    expect(notice.metadata.codexCapabilityDegraded).toEqual([]);
    expect(notice.metadata.codexHonoredDenials).toEqual([]);
    expect(notice.message).toContain("NO approval gate");
  });

  it("FIXTURE: a governed codex child on exec must be labelled ungated exactly once, as MUON's own statement, and never as gated", async () => {
    // `codex exec` IGNORES approval_policy: passing `untrusted` still runs
    // `approval: never` (measured live, 0.145.0 — the banner says so). So this
    // transport can never be reported as approval-gated, however the profile
    // was compiled. A silent ungoverned run and a run claiming a gate it does
    // not have are BOTH failures; the honest state is one loud control-plane
    // disclosure per run.
    const { events } = await run({
      permissionMode: "strict",
      sandbox: "workspace-write",
    });
    const gateLabels = events.filter(
      (event) => event.metadata.codexApprovalGate !== undefined
    );
    expect(gateLabels).toHaveLength(1);
    expect(gateLabels[0]!.metadata.codexApprovalGate).toBe("none");
    // MUON's own words, not recorded as the agent's output.
    expect(gateLabels[0]!.metadata.controlPlane).toBe(true);
    expect(gateLabels[0]!.message).toContain("NO approval gate");
    // The gated label belongs to the app-server transport alone.
    expect(
      events.some(
        (event) => event.metadata.codexApprovalGate === "muon-bridge"
      )
    ).toBe(false);
  });
});
