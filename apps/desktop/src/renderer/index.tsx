import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { RendererErrorBoundary } from "./error-boundary.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("renderer: #root missing from index.html");
}

// A render throw used to unmount the whole tree and leave a blank window with
// no message and no log line. Everything below the boundary can still fail; it
// can no longer fail SILENTLY or unrecoverably. See error-boundary.tsx.
createRoot(container).render(
  <RendererErrorBoundary>
    <App />
  </RendererErrorBoundary>
);

// Async failures never reach a React boundary (they are not thrown during
// render), so a rejected IPC call would still vanish without a trace. Route
// both global channels into the same console sink the debug tee records.
window.addEventListener("error", (event) => {
  console.error("[renderer] uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer] unhandled rejection", event.reason);
});
