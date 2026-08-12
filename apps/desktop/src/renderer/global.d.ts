import type { MuonBridge } from "../shared/ipc.js";

declare global {
  interface Window {
    muon: MuonBridge;
  }
}

export {};
