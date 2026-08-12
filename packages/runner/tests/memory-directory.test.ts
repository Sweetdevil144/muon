import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { memoryDirectoryDigestPayload } from "@muon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeMemoryDirectory,
  withMemoryDirectoryHint,
} from "../src/memory-directory.js";

const dirs: string[] = [];
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const exec = promisify(execFile);

const snapshot = () => {
  const files = [
    {
      path: "README.md" as const,
      content: "read",
      mode: "0444" as const,
      sha256: hash("read"),
    },
    {
      path: "index.tsv" as const,
      content: "id\n",
      mode: "0444" as const,
      sha256: hash("id\n"),
    },
    {
      path: "notes/mem-12345678-1234-4123-8123-123456789abc.txt",
      content: "confirmed fact",
      mode: "0444" as const,
      sha256: hash("confirmed fact"),
    },
  ];
  return {
    schemaVersion: 1 as const,
    source: "human_confirmed_gate" as const,
    noteCount: 1,
    truncated: false,
    files,
    digest: hash(memoryDirectoryDigestPayload(files)),
  };
};

afterEach(async () => {
  while (dirs.length > 0) {
    const directory = dirs.pop()!;
    await exec("chmod", ["-R", "u+w", directory]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

const makeTempDir = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("materializeMemoryDirectory", () => {
  it("writes an ignored 0444 content-addressed snapshot", async () => {
    const cwd = await makeTempDir("muon-memory-directory-");
    dirs.push(cwd);
    const relative = await materializeMemoryDirectory({
      cwd,
      jobId: "job-1",
      snapshot: snapshot(),
    });
    const note = join(cwd, relative, snapshot().files[2]!.path);
    expect(await readFile(note, "utf8")).toBe("confirmed fact");
    expect((await lstat(note)).mode & 0o777).toBe(0o444);
    expect(await readFile(join(cwd, ".muon/memory/.gitignore"), "utf8")).toBe(
      "*\n"
    );
    await exec("git", ["init", "--quiet"], { cwd });
    const status = await exec(
      "git",
      ["status", "--short", "--untracked-files=all"],
      { cwd }
    );
    expect(status.stdout).toBe("");
  });

  it("reuses identical bytes and refuses a modified projection", async () => {
    const cwd = await makeTempDir("muon-memory-directory-");
    dirs.push(cwd);
    const first = await materializeMemoryDirectory({
      cwd,
      jobId: "job-2",
      snapshot: snapshot(),
    });
    expect(
      await materializeMemoryDirectory({
        cwd,
        jobId: "job-2",
        snapshot: snapshot(),
      })
    ).toBe(first);
    const note = join(cwd, first, snapshot().files[2]!.path);
    await chmod(note, 0o644);
    await writeFile(note, "agent rewrite", "utf8");
    await expect(
      materializeMemoryDirectory({ cwd, jobId: "job-2", snapshot: snapshot() })
    ).rejects.toThrow(/not immutable|modified/);
  });

  it("refuses a pre-existing unowned root and labels prompt semantics honestly", async () => {
    const cwd = await makeTempDir("muon-memory-directory-");
    dirs.push(cwd);
    await mkdir(join(cwd, ".muon/memory"), { recursive: true });
    await expect(
      materializeMemoryDirectory({ cwd, jobId: "job-3", snapshot: snapshot() })
    ).rejects.toThrow(/unowned/);
    expect(withMemoryDirectoryHint("do work", ".muon/memory/x", false)).toContain(
      "ignored and never update MUON memory"
    );
  });

  it("never accepts symlinked ownership markers", async () => {
    const cwd = await makeTempDir("muon-memory-directory-");
    dirs.push(cwd);
    const root = join(cwd, ".muon/memory");
    await mkdir(root, { recursive: true });
    const external = join(cwd, "forged-marker");
    await writeFile(
      external,
      `${JSON.stringify({ producer: "muon", schemaVersion: 1 })}\n`,
      { mode: 0o444 }
    );
    await symlink(external, join(root, ".muon-memory-root"));
    await writeFile(join(root, ".gitignore"), "*\n", { mode: 0o444 });

    await expect(
      materializeMemoryDirectory({ cwd, jobId: "job-symlink", snapshot: snapshot() })
    ).rejects.toThrow(/unowned/);
  });

  it("refuses content or digest corruption before writing any projection", async () => {
    const cwd = await makeTempDir("muon-memory-directory-");
    dirs.push(cwd);
    const corruptContent = snapshot();
    corruptContent.files[2]!.content = "forged";
    await expect(
      materializeMemoryDirectory({
        cwd,
        jobId: "job-4",
        snapshot: corruptContent,
      })
    ).rejects.toThrow(/file hash mismatch/);

    const corruptDigest = snapshot();
    corruptDigest.digest = "b".repeat(64);
    await expect(
      materializeMemoryDirectory({ cwd, jobId: "job-4", snapshot: corruptDigest })
    ).rejects.toThrow(/digest does not match/);
  });
});
