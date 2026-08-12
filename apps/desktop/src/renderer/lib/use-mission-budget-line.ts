import { useEffect, useState } from "react";
import {
  buildBudgetLineView,
  pollFailBudgetLine,
  type BudgetLineView,
} from "@muon/client/budget-view";

/**
 * Poll the active mission root's S9 budget for composer preconditions.
 * Keeps the previous numbers on refresh; clears them on poll failure.
 */
export function useMissionBudgetLine(
  rootJobId: string | null | undefined,
  refreshKey: string
): BudgetLineView | null {
  const [view, setView] = useState<BudgetLineView | null>(null);

  useEffect(() => {
    if (!rootJobId || typeof window.muon?.getDispatchBudget !== "function") {
      setView(null);
      return;
    }
    let alive = true;
    window.muon
      .getDispatchBudget(rootJobId)
      .then((budget) => {
        if (alive) {
          setView(buildBudgetLineView(budget));
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setView(
            pollFailBudgetLine(
              cause instanceof Error ? cause.message : String(cause)
            )
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [rootJobId, refreshKey]);

  return view;
}
