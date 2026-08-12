import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  MEMORY_DIRECTORY_SCHEMA_VERSION,
  memoryDirectoryDigestPayload,
  memoryDirectorySnapshotSchema,
  type MemoryDirectorySnapshot,
} from "@muon/protocol";
import type { MuonApiClient } from "@muon/client";

export const MEMORY_DIRECTORY_ROOT = ".muon/memory";
const ROOT_MARKER = ".muon-memory-root";
const SNAPSHOT_MARKER = ".muon-memory-snapshot.json";
const IGNORE_CONTENT = "*\n";
const ROOT_MARKER_CONTENT = `${JSON.stringify({
  producer: "muon",
  schemaVersion: MEMORY_DIRECTORY_SCHEMA_VERSION,
})}\n`;

const jobKey = (jobId: string): string =>
  createHash("sha256").update(jobId, "utf8").digest("hex").slice(0, 24);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const verifySnapshotIntegrity = (snapshot: MemoryDirectorySnapshot): void => {
  for (const entry of snapshot.files) {
    if (sha256(entry.content) !== entry.sha256) {
      throw new Error(`memory snapshot file hash mismatch: ${entry.path}`);
    }
  }
  if (sha256(memoryDirectoryDigestPayload(snapshot.files)) !== snapshot.digest) {
    throw new Error("memory snapshot digest does not match its files");
  }
};

const assertDirectory = async (target: string, label: string): Promise<void> => {
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, never a symlink`);
  }
};

const readImmutableFile = async (
  target: string,
  label: string
): Promise<string> => {
  const stat = await lstat(target);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o444
  ) {
    throw new Error(`${label} must be a real 0444 file, never a symlink`);
  }
  return readFile(target, "utf8");
};

const ensureRoot = async (cwd: string): Promise<string> => {
  const muonRoot = path.join(cwd, ".muon");
  const memoryRoot = path.join(cwd, MEMORY_DIRECTORY_ROOT);
  const muonStat = await lstat(muonRoot).catch(() => undefined);
  if (muonStat) {
    if (muonStat.isSymbolicLink() || !muonStat.isDirectory()) {
      throw new Error(".muon must be a real directory, never a symlink");
    }
  } else {
    await mkdir(muonRoot, { mode: 0o700 });
  }

  const memoryStat = await lstat(memoryRoot).catch(() => undefined);
  if (!memoryStat) {
    await mkdir(memoryRoot, { mode: 0o755 });
    await writeFile(path.join(memoryRoot, ROOT_MARKER), ROOT_MARKER_CONTENT, {
      encoding: "utf8",
      mode: 0o444,
      flag: "wx",
    });
    await writeFile(path.join(memoryRoot, ".gitignore"), IGNORE_CONTENT, {
      encoding: "utf8",
      mode: 0o444,
      flag: "wx",
    });
    return memoryRoot;
  }
  if (memoryStat.isSymbolicLink() || !memoryStat.isDirectory()) {
    throw new Error(".muon/memory must be a real directory, never a symlink");
  }
  const [marker, ignore] = await Promise.all([
    readImmutableFile(
      path.join(memoryRoot, ROOT_MARKER),
      "memory root marker"
    ).catch(() => ""),
    readImmutableFile(
      path.join(memoryRoot, ".gitignore"),
      "memory root gitignore"
    ).catch(() => ""),
  ]);
  if (marker !== ROOT_MARKER_CONTENT || ignore !== IGNORE_CONTENT) {
    throw new Error(
      "refusing to use an unowned or modified .muon/memory directory"
    );
  }
  return memoryRoot;
};

const markerContent = (key: string, digest: string): string =>
  `${JSON.stringify({
    producer: "muon",
    schemaVersion: MEMORY_DIRECTORY_SCHEMA_VERSION,
    jobKey: key,
    digest,
  })}\n`;

const verifyExisting = async (
  target: string,
  key: string,
  snapshot: MemoryDirectorySnapshot
): Promise<void> => {
  await assertDirectory(target, "memory snapshot");
  if (((await lstat(target)).mode & 0o777) !== 0o555) {
    throw new Error("existing memory snapshot directory is not immutable");
  }
  const expectedTop = new Set([
    SNAPSHOT_MARKER,
    "README.md",
    "index.tsv",
    ...(snapshot.noteCount > 0 ? ["notes"] : []),
  ]);
  const top = await readdir(target);
  if (
    top.length !== expectedTop.size ||
    top.some((entry) => !expectedTop.has(entry))
  ) {
    throw new Error("existing memory snapshot contains unexpected files");
  }
  const marker = await readImmutableFile(
    path.join(target, SNAPSHOT_MARKER),
    "memory snapshot marker"
  );
  if (marker !== markerContent(key, snapshot.digest)) {
    throw new Error("existing memory snapshot marker does not match its digest");
  }
  if (snapshot.noteCount > 0) {
    const notesDirectory = path.join(target, "notes");
    await assertDirectory(notesDirectory, "memory notes");
    if (((await lstat(notesDirectory)).mode & 0o777) !== 0o555) {
      throw new Error("existing memory notes directory is not immutable");
    }
  }
  for (const entry of snapshot.files) {
    const absolute = path.resolve(target, entry.path);
    if (!absolute.startsWith(`${path.resolve(target)}${path.sep}`)) {
      throw new Error("memory snapshot path escaped its generated directory");
    }
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o444) {
      throw new Error(`memory snapshot file is not immutable: ${entry.path}`);
    }
    if ((await readFile(absolute, "utf8")) !== entry.content) {
      throw new Error(`memory snapshot file was modified: ${entry.path}`);
    }
  }
};

const cleanupTemp = async (temporary: string): Promise<void> => {
  const notes = path.join(temporary, "notes");
  await chmod(notes, 0o700).catch(() => undefined);
  await chmod(temporary, 0o700).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
};

/**
 * Materialize a content-addressed snapshot. Existing generated data is never
 * overwritten or deleted; a changed brain gets a new digest directory. A
 * tampered same-digest directory is refused and never read as an input.
 */
export async function materializeMemoryDirectory(input: {
  cwd: string;
  jobId: string;
  snapshot: MemoryDirectorySnapshot;
}): Promise<string> {
  const snapshot = memoryDirectorySnapshotSchema.parse(input.snapshot);
  verifySnapshotIntegrity(snapshot);
  const root = await ensureRoot(input.cwd);
  const key = jobKey(input.jobId);
  const directoryName = `${key}-${snapshot.digest}`;
  const target = path.join(root, directoryName);
  if (await lstat(target).catch(() => undefined)) {
    await verifyExisting(target, key, snapshot);
    return path.posix.join(MEMORY_DIRECTORY_ROOT, directoryName);
  }

  const temporary = await mkdtemp(path.join(root, `.tmp-${key}-`));
  try {
    if (snapshot.noteCount > 0) {
      await mkdir(path.join(temporary, "notes"), { mode: 0o700 });
    }
    for (const entry of snapshot.files) {
      const absolute = path.resolve(temporary, entry.path);
      if (!absolute.startsWith(`${path.resolve(temporary)}${path.sep}`)) {
        throw new Error("memory snapshot path escaped its temporary directory");
      }
      await writeFile(absolute, entry.content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(absolute, 0o444);
    }
    const marker = path.join(temporary, SNAPSHOT_MARKER);
    await writeFile(marker, markerContent(key, snapshot.digest), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(marker, 0o444);
    if (snapshot.noteCount > 0) {
      await chmod(path.join(temporary, "notes"), 0o555);
    }
    await chmod(temporary, 0o555);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (await lstat(target).catch(() => undefined)) {
        await verifyExisting(target, key, snapshot);
        await cleanupTemp(temporary);
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (await lstat(temporary).catch(() => undefined)) {
      await cleanupTemp(temporary);
    }
    throw error;
  }
  return path.posix.join(MEMORY_DIRECTORY_ROOT, directoryName);
}

export function withMemoryDirectoryHint(
  brief: string,
  relativeDirectory: string,
  truncated: boolean
): string {
  const ceiling = truncated
    ? " The snapshot reached its 200-note ceiling; use memory_recall for anything absent."
    : "";
  return [
    `Governed memory directory: ${relativeDirectory}. It is a read-only, human-confirmed snapshot; use Read/Grep (or grep -a) and cite stable note ids.${ceiling}`,
    "Edits to that directory are ignored and never update MUON memory.",
    "",
    brief,
  ].join("\n");
}

export function supportsMemoryDirectory(
  client: MuonApiClient
): client is MuonApiClient & {
  getMemoryDirectorySnapshot(): Promise<MemoryDirectorySnapshot>;
} {
  return typeof client.getMemoryDirectorySnapshot === "function";
}
