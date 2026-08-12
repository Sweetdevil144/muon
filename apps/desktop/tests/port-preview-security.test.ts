import { describe, expect, it } from "vitest";
import {
  buildLocalhostPreviewUrl,
  isAllowedPortPreviewUrl,
  resolvePortPreviewUrl,
} from "../src/lib/port-preview-security.js";

describe("port preview allowlist", () => {
  it("builds only http://127.0.0.1:<port>/ URLs", () => {
    expect(buildLocalhostPreviewUrl(3000)).toBe("http://127.0.0.1:3000/");
    expect(buildLocalhostPreviewUrl(0)).toBeNull();
    expect(buildLocalhostPreviewUrl(70000)).toBeNull();
  });

  it("rejects arbitrary hosts, paths, and credentials", () => {
    expect(isAllowedPortPreviewUrl("http://127.0.0.1:3000/")).toBe(true);
    expect(isAllowedPortPreviewUrl("http://127.0.0.1:3000/admin")).toBe(false);
    expect(isAllowedPortPreviewUrl("http://localhost:3000/")).toBe(false);
    expect(isAllowedPortPreviewUrl("https://127.0.0.1:3000/")).toBe(false);
    expect(isAllowedPortPreviewUrl("http://evil.test:3000/")).toBe(false);
    expect(isAllowedPortPreviewUrl("http://user:pass@127.0.0.1:3000/")).toBe(
      false
    );
  });

  it("resolvePortPreviewUrl is the only supported open path", () => {
    expect(resolvePortPreviewUrl(5173)).toBe("http://127.0.0.1:5173/");
    expect(resolvePortPreviewUrl(-1)).toBeNull();
  });
});
