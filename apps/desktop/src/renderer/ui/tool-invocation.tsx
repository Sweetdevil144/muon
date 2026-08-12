/**
 * Quiet-native ToolInvocation primitives.
 *
 * Desktop does **not** use shadcn/Tailwind (`apps/desktop` is CSS tokens +
 * esbuild). These mirror the shadcn ToolInvocation API/shape but style through
 * Quiet classes in `styles.css` so the chat page stays one design system.
 */
import {
  type ComponentProps,
  type ReactNode,
  useState,
} from "react";
import { cn } from "./cn.js";
import { idToReadableText } from "./tool-invocation-utils.js";

export type ToolInvocationPhase =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export function ToolInvocation({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("tool-invocation", className)}
      {...props}
    />
  );
}

export function ToolInvocationHeader({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div className={cn("tool-invocation-header", className)} {...props} />
  );
}

export function ToolInvocationName({
  name,
  capitalize = true,
  type,
  isError = false,
  className,
  trailing,
}: {
  name: string;
  capitalize?: boolean;
  type: ToolInvocationPhase;
  isError?: boolean;
  className?: string;
  trailing?: ReactNode;
}) {
  const hasError = type === "output-error" || isError;

  return (
    <div className={cn("tool-invocation-name", className)}>
      {(type === "input-streaming" || type === "input-available") && (
        <ToolInvocationLoadingIcon
          aria-hidden
          className="tool-invocation-icon tool-invocation-icon-loading"
          duration="2s"
        />
      )}
      {type === "output-available" && !hasError ? (
        <span
          aria-hidden
          className="tool-invocation-icon tool-invocation-icon-ok"
        >
          ✓
        </span>
      ) : null}
      {hasError ? (
        <span
          aria-hidden
          className="tool-invocation-icon tool-invocation-icon-err"
        >
          !
        </span>
      ) : null}
      <span
        className={cn(
          "tool-invocation-label",
          hasError && "tool-invocation-label-err"
        )}
      >
        {idToReadableText(name, { capitalize })}
      </span>
      {trailing}
    </div>
  );
}

export function ToolInvocationContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("tool-invocation-content", className)}>
      <div className="tool-invocation-content-label">Tool Details</div>
      <div className="tool-invocation-content-body">{children}</div>
    </div>
  );
}

export function ToolInvocationContentCollapsible({
  children,
  className,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
}: {
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div
      className={cn(
        "tool-invocation-collapsible",
        open && "tool-invocation-collapsible-open",
        className
      )}
    >
      <button
        aria-expanded={open}
        className="tool-invocation-collapse-trigger"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span>Tool Details</span>
        <span className="tool-invocation-collapse-hint">
          {open ? "collapse" : "expand"}
        </span>
      </button>
      {open ? (
        <div className="tool-invocation-content-body">{children}</div>
      ) : null}
    </div>
  );
}

export function ToolInvocationRawData({
  data,
  title = "Data",
}: {
  data: unknown;
  title?: string;
}) {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const fieldClass =
    title === "Called with"
      ? "tool-card-output tool-card-args-box tool-invocation-raw-pre"
      : "tool-card-output tool-invocation-raw-pre";

  return (
    <div className="tool-invocation-raw">
      <h4 className="tool-invocation-raw-title tool-card-field-label">
        {title}
      </h4>
      <div className="tool-invocation-raw-scroll">
        <pre className={fieldClass}>{text}</pre>
      </div>
    </div>
  );
}

export function ToolInvocationLoadingIcon({
  duration = "3s",
  sphereRadius = 20,
  ...props
}: ComponentProps<"svg"> & { duration?: string; sphereRadius?: number }) {
  const topPos = { x: 50, y: sphereRadius };
  const bottomLeftPos = { x: sphereRadius, y: 100 - sphereRadius };
  const bottomRightPos = { x: 100 - sphereRadius, y: 100 - sphereRadius };

  const path1to2 = `M 0 0 L ${bottomLeftPos.x - topPos.x} ${bottomLeftPos.y - topPos.y}`;
  const path2to3 = `M 0 0 L ${bottomRightPos.x - bottomLeftPos.x} ${bottomRightPos.y - bottomLeftPos.y}`;
  const path3to1 = `M 0 0 L ${topPos.x - bottomRightPos.x} ${topPos.y - bottomRightPos.y}`;

  return (
    <svg
      fill="currentColor"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <title>Loading</title>
      <circle cx={topPos.x} cy={topPos.y} r={sphereRadius}>
        <animateMotion
          calcMode="linear"
          dur={duration}
          path={path1to2}
          repeatCount="indefinite"
        />
      </circle>
      <circle cx={bottomLeftPos.x} cy={bottomLeftPos.y} r={sphereRadius}>
        <animateMotion
          calcMode="linear"
          dur={duration}
          path={path2to3}
          repeatCount="indefinite"
        />
      </circle>
      <circle cx={bottomRightPos.x} cy={bottomRightPos.y} r={sphereRadius}>
        <animateMotion
          calcMode="linear"
          dur={duration}
          path={path3to1}
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );
}

export default ToolInvocation;
