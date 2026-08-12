import fs from "node:fs";
import path from "node:path";
import {
  MAX_CUSTOM_AGENTS,
  createUngovernedAgentEntry,
  parseUngovernedAgentEntry,
  type CustomAgentRegistrationInput,
  type UngovernedAgentEntry,
} from "@muon/protocol";
import { resolveDataDir } from "./paths.js";

/**
 * ROADMAP P7 — runtime persistence for custom (ungoverned) agents.
 *
 * ONE file, `<dataDir>/custom-agents.json`, in the SAME per-user data dir every
 * other MUON surface already shares (`resolveDataDir`, `paths.ts`) — not a
 * bespoke `~/.muon` location, so a relocated `MUON_DATA_DIR` (the desktop
 * passes its own `userData`) moves this store with everything else instead of
 * leaving an orphan file behind.
 *
 * This module is FLEET-ADJACENT BUT NEVER FLEET. There is no vendor here, no
 * `Agent` row, no readiness probe, and nothing this file writes is ever read
 * by `@muon/adapters` or a dispatch route — `apps/cli/src/commands/agents.ts`
 * (the fleet discovery table) and this store are deliberately two different
 * nouns so an operator command never conflates "one of my three claude-code
 * workers" with "the shell script I registered as a terminal shortcut". The
 * CLI keeps that split in its own command name (`custom-agents`, not
 * `agents register`).
 *
 * Every entry is validated on WRITE (`createUngovernedAgentEntry`, which can
 * only ever produce `UNGOVERNED_AUTHORITY`) and re-validated on READ
 * (`parseUngovernedAgentEntry`), so a hand-edited JSON file can widen nothing:
 * a tampered row is dropped rather than loaded, degrade-safe exactly like
 * `readLockfile`.
 */

export const CUSTOM_AGENTS_FILE_NAME = "custom-agents.json";

export function customAgentsFilePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, CUSTOM_AGENTS_FILE_NAME);
}

/** Typed refusal for a registration/removal the store itself rejects — never
 *  a raw filesystem error, so a caller can render the reason directly. */
export class CustomAgentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomAgentStoreError";
  }
}

/**
 * Read every VALID entry from the store. Degrade-safe: a missing file reads
 * as `[]` (no custom agents yet, not an error); a corrupt file, or a file that
 * is not a JSON array, ALSO reads as `[]` rather than throwing, mirroring
 * `readLockfile`'s "a truncated file is treated as absent" posture. A single
 * bad ROW inside an otherwise-good array is dropped silently — one operator
 * hand-edit should never make every other registered agent disappear.
 */
export function readCustomAgents(
  dataDir: string = resolveDataDir()
): UngovernedAgentEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(customAgentsFilePath(dataDir), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: UngovernedAgentEntry[] = [];
  for (const candidate of parsed) {
    const entry = parseUngovernedAgentEntry(candidate);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Mutations are stricter than display reads: a damaged store must never be
 * interpreted as an empty store and overwritten. The operator can still list
 * safely (the public reader degrades to valid rows), but registration/removal
 * stops until the original bytes are repaired or deliberately removed.
 */
function readCustomAgentsForMutation(dataDir: string): UngovernedAgentEntry[] {
  const filePath = customAgentsFilePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new CustomAgentStoreError(
      `Cannot safely read '${filePath}'; refusing to overwrite the custom-agent registry.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CustomAgentStoreError(
      `Custom-agent registry '${filePath}' is not valid JSON; refusing to overwrite it.`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CustomAgentStoreError(
      `Custom-agent registry '${filePath}' is not an array; refusing to overwrite it.`
    );
  }

  const entries: UngovernedAgentEntry[] = [];
  for (const candidate of parsed) {
    const entry = parseUngovernedAgentEntry(candidate);
    if (!entry) {
      throw new CustomAgentStoreError(
        `Custom-agent registry '${filePath}' contains an invalid row; refusing to discard it during a write.`
      );
    }
    entries.push(entry);
  }
  return entries;
}

/** Atomic write (temp + rename), owner-only perms — same discipline as
 *  `writeLockfile`: this file names binaries MUON will spawn, so it gets the
 *  same "no other user on a shared host should read or race it" treatment. */
function writeCustomAgentsAtomic(
  entries: readonly UngovernedAgentEntry[],
  dataDir: string
): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = customAgentsFilePath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function listCustomAgents(
  dataDir: string = resolveDataDir()
): UngovernedAgentEntry[] {
  return readCustomAgents(dataDir);
}

export function findCustomAgentById(
  id: string,
  dataDir: string = resolveDataDir()
): UngovernedAgentEntry | null {
  return readCustomAgents(dataDir).find((entry) => entry.id === id) ?? null;
}

/**
 * Register a new custom agent. Refuses (never silently overwrites) a slug
 * already in use, and refuses past `MAX_CUSTOM_AGENTS` — both as a typed
 * `CustomAgentStoreError`, distinct from the `ZodError`
 * `createUngovernedAgentEntry` throws for a malformed `input` itself.
 */
export function registerCustomAgent(
  input: CustomAgentRegistrationInput,
  dataDir: string = resolveDataDir()
): UngovernedAgentEntry {
  const existing = readCustomAgentsForMutation(dataDir);
  const entry = createUngovernedAgentEntry(input);
  if (existing.some((row) => row.id === entry.id)) {
    throw new CustomAgentStoreError(
      `A custom agent with slug '${entry.slug}' is already registered. Remove it first, or choose a different slug.`
    );
  }
  if (existing.length >= MAX_CUSTOM_AGENTS) {
    throw new CustomAgentStoreError(
      `MUON supports at most ${MAX_CUSTOM_AGENTS} registered custom agents. Remove one before registering another.`
    );
  }
  const next = [...existing, entry];
  writeCustomAgentsAtomic(next, dataDir);
  return entry;
}

/**
 * Remove a custom agent by id. Returns `true` if an entry was removed,
 * `false` if no entry with that id existed (not an error — removal is
 * idempotent).
 */
export function removeCustomAgent(
  id: string,
  dataDir: string = resolveDataDir()
): boolean {
  const existing = readCustomAgentsForMutation(dataDir);
  const next = existing.filter((entry) => entry.id !== id);
  if (next.length === existing.length) {
    return false;
  }
  writeCustomAgentsAtomic(next, dataDir);
  return true;
}
