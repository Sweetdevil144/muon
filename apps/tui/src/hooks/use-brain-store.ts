import { useSyncExternalStore } from "react";
import type { BrainSnapshot, BrainStore } from "../lib/brain-store.js";

export function useBrainStore(store: BrainStore): BrainSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}
