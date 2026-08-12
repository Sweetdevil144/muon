import { DEFAULT_EMBEDDED_BRAIN_PORT } from "@muon/protocol";

/**
 * WHICH PORT the embedded brain asks for, and whether it may take another.
 *
 * Pulled out of `index.ts` because it is a RULE, not a line: three inputs with
 * three different intents, and getting any of them backwards is invisible
 * until someone's brain is somewhere they did not expect.
 */
export type BrainListenPlan = {
  /** The port to try first. */
  readonly port: number;
  /**
   * May an EADDRINUSE be answered by taking an OS-assigned port instead?
   *
   * Only for the DEFAULT. An operator who named a port is told it was
   * unavailable — silently binding a different one turns their configuration
   * into a suggestion. And `0` is already a request for an ephemeral port, so
   * there is nothing to fall back FROM.
   */
  readonly mayFallBack: boolean;
};

export function resolveBrainListenPlan(
  configuredPort: number | undefined
): BrainListenPlan {
  if (configuredPort === undefined) {
    return { port: DEFAULT_EMBEDDED_BRAIN_PORT, mayFallBack: true };
  }
  return { port: configuredPort, mayFallBack: false };
}
