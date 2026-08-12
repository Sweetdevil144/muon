import type { LaneAdapter } from "@muon/protocol";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CursorAdapter } from "./cursor-adapter.js";
import { FakeLaneAdapter, fakeVendorEnabled } from "./fake-lane-adapter.js";
import { OpencodeAdapter } from "./opencode-adapter.js";

export function createDefaultAdapters(): LaneAdapter[] {
  const adapters: LaneAdapter[] = [
    new ClaudeAdapter(),
    new CodexAdapter(),
    // Cursor is managed for READ-ONLY review roles only; its own
    // `supportedRoles` is the ceiling and its argv can never widen (see
    // cursor-adapter.ts). Registering it makes that slice reachable at all.
    new CursorAdapter(),
    // OpenCode is managed for READ-ONLY reconnaissance only (`scout`). Its
    // permission table lives in a CONFIG FILE rather than on argv, so the lane
    // owns that file and the env that makes it the last word — see
    // opencode-adapter.ts for what was proven live about re-widening.
    new OpencodeAdapter(),
  ];
  // DEV/TEST seam (P7): the deterministic fake vendor is only ever registered
  // when MUON_FAKE_VENDOR=1, so a normal production dispatch can never route to
  // it. The real vendors above are unaffected either way.
  if (fakeVendorEnabled()) {
    adapters.push(new FakeLaneAdapter());
  }
  return adapters;
}

export function adapterById(adapters: LaneAdapter[], laneId: string) {
  return adapters.find((adapter) => adapter.id === laneId);
}
