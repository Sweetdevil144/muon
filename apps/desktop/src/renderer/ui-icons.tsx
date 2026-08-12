import type { CSSProperties, ReactNode } from "react";
import type { NavTarget } from "./lib/workspace-layout.js";

type IconProps = {
  size?: number;
  className?: string;
  title?: string;
};

function StrokeIcon(
  props: IconProps & { children: ReactNode; label?: string }
) {
  const size = props.size ?? 15;
  const style: CSSProperties = { width: size, height: size };
  return (
    <svg
      aria-hidden={props.title ? undefined : true}
      className={props.className}
      fill="none"
      height={size}
      role={props.title ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      {props.title ? <title>{props.title}</title> : null}
      {props.children}
    </svg>
  );
}

export function IconMission(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 3l7 4v6c0 4-3 7-7 8-4-1-7-4-7-8V7l7-4z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </StrokeIcon>
  );
}

export function IconCrew(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5S14 16 14.5 19" />
      <path d="M14.5 14.2c1.4-.5 3-.4 4.5.8.8.6 1.4 1.5 1.7 2.5" />
    </StrokeIcon>
  );
}

export function IconMemory(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </StrokeIcon>
  );
}

export function IconEvidence(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M8 4h7l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path d="M15 4v4h4M9 13h6M9 17h4" />
    </StrokeIcon>
  );
}

export function IconControl(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 9h8M8 13h5" />
    </StrokeIcon>
  );
}

export function IconTimeline(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M5 7h14M5 12h14M5 17h10" />
    </StrokeIcon>
  );
}

export function IconGraph(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="6.5" cy="7" r="2.2" />
      <circle cx="17.5" cy="8" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
      <circle cx="16.5" cy="16" r="2.2" />
      <path d="M8.4 8.7l6.5-0.4M8.2 15.2l6.4-5.6M10.8 16.4l3.8-0.6" />
    </StrokeIcon>
  );
}

/**
 * Crew topology — a hub with three spokes. Deliberately distinct from
 * IconGraph (a loose mesh of symbol nodes): this one reads as ONE center
 * with lanes hanging off it, which is exactly what the panel renders.
 */
export function IconTopology(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="2.6" />
      <circle cx="12" cy="4.2" r="1.8" />
      <circle cx="18.8" cy="16" r="1.8" />
      <circle cx="5.2" cy="16" r="1.8" />
      <path d="M12 6v3.4M13.8 13.4l3.3 1.9M10.2 13.4l-3.3 1.9" />
    </StrokeIcon>
  );
}

/** Cog — not a sun. The old rays-around-a-circle read as the theme toggle. */
export function IconSettings(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </StrokeIcon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </StrokeIcon>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M7 10l3 2-3 2M12 14h5" />
    </StrokeIcon>
  );
}

export function IconChevron(props: IconProps & { dir?: "left" | "right" }) {
  const dir = props.dir ?? "right";
  return (
    <StrokeIcon {...props}>
      {dir === "left" ? (
        <path d="M14 6l-6 6 6 6" />
      ) : (
        <path d="M10 6l6 6-6 6" />
      )}
    </StrokeIcon>
  );
}

const NAV_ICONS: Record<NavTarget, (props: IconProps) => ReactNode> = {
  mission: IconMission,
  crew: IconCrew,
  topology: IconTopology,
  memory: IconMemory,
  evidence: IconEvidence,
  control: IconControl,
  timeline: IconTimeline,
  graph: IconGraph,
  settings: IconSettings,
};

export function NavIcon(props: { target: NavTarget } & IconProps) {
  const Comp = NAV_ICONS[props.target];
  return <Comp className={props.className} size={props.size} />;
}
