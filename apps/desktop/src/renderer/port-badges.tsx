import { isLocalhostListenAddress } from "@muon/core/port-association";
import type { ListeningPortSnapshot } from "../shared/ipc.js";

export function formatPortBadgeLabel(port: ListeningPortSnapshot): string {
  const command = port.command ? ` ${port.command}` : "";
  return `:${port.port}${command}`;
}

export function WorkspacePortBadges(props: {
  ports: readonly ListeningPortSnapshot[];
  previewEnabled: boolean;
  onPreview?: (port: number) => void;
}) {
  if (props.ports.length === 0) {
    return null;
  }
  return (
    <>
      {props.ports.map((port) => {
        const localhost = isLocalhostListenAddress(port.address);
        const label = formatPortBadgeLabel(port);
        const title = port.jobId
          ? `Job ${port.jobId} listening on ${port.address}:${port.port}`
          : `Workspace server on ${port.address}:${port.port}`;
        if (props.previewEnabled && localhost && props.onPreview) {
          return (
            <button
              key={`${port.pid}:${port.address}:${port.port}`}
              type="button"
              className="workspace-port-badge workspace-port-badge-action"
              aria-label={`Preview localhost port ${port.port}`}
              title={`${title} — open preview`}
              onClick={(event) => {
                event.stopPropagation();
                props.onPreview?.(port.port);
              }}
            >
              {label}
            </button>
          );
        }
        return (
          <span
            key={`${port.pid}:${port.address}:${port.port}`}
            className="workspace-port-badge"
            aria-label={`Listening port ${port.port}`}
            title={title}
          >
            {label}
          </span>
        );
      })}
    </>
  );
}
