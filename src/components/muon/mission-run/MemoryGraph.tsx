"use client";

import Link from "next/link";

import { MEMORY_EDGES, MEMORY_NODES, TRUST_CHIP } from "@/lib/demo-run/script";
import { useDemoRun } from "@/lib/demo-run/store";
import type { MemoryNode, MemoryTrust } from "@/lib/demo-run/types";

export function trustOf(node: MemoryNode, memory: Record<string, string>): MemoryTrust {
  const d = memory[node.id];
  if (d === "confirmed") return "confirmed";
  if (d === "rejected") return "rejected";
  return node.trust;
}

function fillFor(trust: MemoryTrust) {
  switch (trust) {
    case "confirmed":
      return "var(--trust-human)";
    case "corroborated":
    case "unconfirmed":
      return "var(--trust-stale)";
    case "rejected":
      return "var(--trust-unconfirmed)";
    default:
      return "var(--muted-foreground)";
  }
}

export function MemoryGraph({ compact = false }: { compact?: boolean }) {
  const { state, frame, reduced, dispatch } = useDemoRun();

  const nodes = MEMORY_NODES.filter((n) => !n.appearsAt || frame.tMs >= n.appearsAt);

  const svg = (
    <svg
      viewBox="0 0 620 250"
      className={compact ? "h-[110px] w-full" : "h-[300px] w-full"}
      role="img"
      aria-label="Shared memory graph: confirmed notes, unconfirmed agent proposals, a corroborated proposal, a superseded note and a rejected note, all kept with their provenance."
    >
      {MEMORY_EDGES.map(([a, b]) => {
        const from = nodes.find((n) => n.id === a);
        const to = nodes.find((n) => n.id === b);
        if (!from || !to) return null;
        return (
          <line
            key={`${a}${b}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="oklch(1 0 0 / 18%)"
            strokeWidth="1"
          />
        );
      })}

      {nodes.map((n) => {
        const trust = trustOf(n, state.memory);
        const fill = fillFor(trust);
        const hollow = trust === "unconfirmed" || trust === "corroborated";
        const faded = trust === "superseded" || trust === "rejected";
        const pulsing = !reduced && (trust === "unconfirmed" || trust === "corroborated");
        return (
          <g
            key={n.id}
            opacity={faded ? 0.45 : 1}
            tabIndex={compact ? -1 : 0}
            role={compact ? undefined : "button"}
            aria-label={`${n.label} — ${TRUST_CHIP[trust]!.text}`}
            className="cursor-pointer focus:outline-none [&:focus-visible>circle:first-child]:stroke-[var(--muon-blue)] [&:focus-visible>circle:first-child]:stroke-2"
            onClick={() => !compact && dispatch({ type: "select", id: n.id })}
            onKeyDown={(e) => {
              if (!compact && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                dispatch({ type: "select", id: n.id });
              }
            }}
          >
            <circle cx={n.x} cy={n.y} r={n.r + 6} fill={fill} opacity="0.12" />
            {trust === "corroborated" ? (
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r + 4}
                fill="none"
                stroke="var(--trust-crew)"
                strokeWidth="1.5"
              />
            ) : null}
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={hollow ? "transparent" : fill}
              stroke={fill}
              strokeWidth={trust === "confirmed" ? 2 : 1}
              strokeDasharray={hollow ? "3 2" : undefined}
              className={pulsing ? "animate-gate-pulse" : undefined}
            />
            {trust === "rejected" ? (
              <text
                x={n.x}
                y={n.y + 3}
                textAnchor="middle"
                fontSize="9"
                fill="var(--trust-unconfirmed)"
              >
                ×
              </text>
            ) : null}
            {!compact ? (
              <text
                x={n.x + n.r + 8}
                y={n.y + 3}
                fill="oklch(0.72 0.005 285)"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
                textDecoration={trust === "superseded" ? "line-through" : undefined}
              >
                {n.label}
                {n.expires && trust === "unconfirmed" ? " · expires unless confirmed" : ""}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );

  if (compact) {
    return (
      <Link href="/product/shared-memory" className="block" aria-label="Explore shared memory">
        {svg}
      </Link>
    );
  }

  return svg;
}
