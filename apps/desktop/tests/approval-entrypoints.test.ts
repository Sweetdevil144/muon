import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8"
);

describe("native approval entrypoints", () => {
  it("never approves or rejects from truncated tray or notification copy", () => {
    const tray = source.slice(
      source.indexOf("function rebuildTrayMenu"),
      source.indexOf("function makeMonitor")
    );
    // BUG 2: the native notification is now built in the deduping notifier's
    // `show` closure; its click still only OPENS the review (never approves/
    // rejects from truncated copy).
    const notification = source.slice(
      source.indexOf("const approvalNotifier"),
      source.indexOf("function sendToRenderer")
    );
    // The monitor's onNewApproval routes strictly through the notifier — it can
    // never approve/reject either.
    const onNewApproval = source.slice(
      source.indexOf("onNewApproval:"),
      source.indexOf("let monitor:")
    );

    expect(tray).toContain("openApprovalReview(approval.id)");
    expect(tray).not.toContain('label: "Approve"');
    expect(tray).not.toContain('label: "Reject"');
    expect(notification).toContain("openApprovalReview(approval.id)");
    expect(notification).not.toContain('notification.on("action"');
    expect(notification).not.toContain("actions:");
    expect(onNewApproval).toContain("approvalNotifier.notify(approval)");
    expect(onNewApproval).not.toContain('label: "Approve"');
    expect(onNewApproval).not.toContain('label: "Reject"');
  });
});
