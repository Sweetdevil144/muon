import { describe, expect, it } from "vitest";
import { TabStrip } from "../src/shell/tab-strip.js";
import { visibleWidth } from "../src/vendor/pi-tui/src/utils.ts";
/**
 * A tab title is STORED text — a directory name, an agent name — so it can
 * contain anything a filesystem allows, including CJK and emoji. Zones were
 * measured with `.length` (UTF-16 units) while the shell lays out and clips in
 * terminal CELLS, so one wide character made every zone after it drift and a
 * click landed on the neighbouring tab.
 */
describe("tab click targets are measured in terminal cells", () => {
  it("a wide title does not shift the tabs after it", () => {
    const strip = new TabStrip({ tabs: [{ id: "a", title: "日本語テスト" }, { id: "b", title: "next" }], activeId: "a" });
    const zones = strip.zones(120);
    const first = zones[0]!;
    expect(first.end - first.start).toBe(visibleWidth(" 日本語テスト "));
    expect(zones[1]!.start).toBe(first.end);
  });

  it("the + affordance is measured the same way", () => {
    const strip = new TabStrip({
      tabs: [{ id: "a", title: "🚀🚀🚀" }],
      activeId: "a",
    });
    const zones = strip.zones(120);
    const plus = zones.find((zone) => zone.target.kind === "new-tab")!;
    expect(plus.start).toBe(visibleWidth(" 🚀🚀🚀 "));
    expect(plus.end - plus.start).toBe(visibleWidth(" + "));
  });
});
