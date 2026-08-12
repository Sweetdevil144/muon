#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const sourceIcon = path.join(repoRoot, "public", "logo.png");
const targetIcon = path.join(desktopDir, "build", "icon.icns");
const checkOnly = process.argv.includes("--check");

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(command)} failed: ${result.stderr || result.stdout}`
  );
}

async function main() {
  assert.equal(
    existsSync(sourceIcon),
    true,
    `canonical public icon missing: ${sourceIcon}`
  );

  // MUON's desktop distribution is currently macOS-only. Linux CI still builds
  // the TypeScript app, so it validates that the committed artifact exists and
  // leaves regeneration to the macOS packaging gate.
  if (process.platform !== "darwin") {
    assert.equal(
      existsSync(targetIcon),
      true,
      `desktop icon missing: ${targetIcon}; regenerate it on macOS`
    );
    process.stdout.write(
      `[icon] ${checkOnly ? "checked" : "kept"} committed MUON icon (macOS regeneration unavailable)\n`
    );
    return;
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), "muon-icon-"));
  const iconsetDir = path.join(scratchDir, "MUON.iconset");
  const generatedIcon = path.join(scratchDir, "icon.icns");

  try {
    await mkdir(iconsetDir, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      run("/usr/bin/sips", [
        "-z",
        String(size),
        String(size),
        sourceIcon,
        "--out",
        path.join(iconsetDir, `icon_${size}x${size}.png`),
      ]);
      const retinaSize = size * 2;
      run("/usr/bin/sips", [
        "-z",
        String(retinaSize),
        String(retinaSize),
        sourceIcon,
        "--out",
        path.join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ]);
    }
    run("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconsetDir,
      "-o",
      generatedIcon,
    ]);

    const generated = await readFile(generatedIcon);
    const current = existsSync(targetIcon)
      ? await readFile(targetIcon)
      : Buffer.alloc(0);
    const matches = generated.equals(current);

    if (checkOnly) {
      assert.equal(
        matches,
        true,
        "apps/desktop/build/icon.icns drifted from public/logo.png; run `npm run build:icon`"
      );
      process.stdout.write(
        "[icon] packaged MUON icon matches canonical public/logo.png\n"
      );
      return;
    }

    if (!matches) {
      await mkdir(path.dirname(targetIcon), { recursive: true });
      await copyFile(generatedIcon, targetIcon);
      process.stdout.write(
        "[icon] regenerated desktop icon from canonical public/logo.png\n"
      );
    } else {
      process.stdout.write(
        "[icon] desktop icon already matches canonical public/logo.png\n"
      );
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `[icon] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
