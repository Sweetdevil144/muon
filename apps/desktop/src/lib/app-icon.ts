import path from "node:path";

export function resolveAppIconPath(input: {
  packaged: boolean;
  resourcesPath: string;
  moduleDir: string;
}): string {
  return input.packaged
    ? path.join(input.resourcesPath, "icon.icns")
    : path.join(input.moduleDir, "..", "build", "icon.icns");
}
