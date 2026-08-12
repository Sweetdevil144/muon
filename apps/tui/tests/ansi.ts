// Ink renders through chalk, so frames carry SGR styling bytes whenever the
// environment reports color support - which differs between local shells and
// CI. Assertions in this suite are about the words a human sees, not the
// styling, so tests must compare against the stripped frame or they fail only
// in color-enabled environments (e.g. dim codes breaking toContain("fit 0.92"),
// or /\d/ matching the "2" inside the SGR reset sequence).
const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

export function plainFrame(frame: string): string {
  return frame.replace(SGR, "");
}
