/**
 * Rollback engine — file-level undo/redo with merge/reproduce support.
 *
 * Builds on the checkpoint system (./checkpoints.ts) to track file state at
 * each user-message boundary. A mapping file (rollback-map.json) in the session
 * directory links each UserCard's cardId to the checkpoint taken just before
 * that message was submitted.
 *
 * Rollback flow:
 *   1. User clicks "rollback" on a message → record pre-rollback checkpoint
 *   2. Restore the checkpoint associated with the target message
 *   3. Insert a RollbackMarker in the card stream
 *   4. User can "undo rollback" to restore pre-rollback state
 *   5. If new changes exist since rollback → offer Reproduce or Merge
 *
 * Reproduce: undo new changes, replay the rolled-back state
 * Merge: keep new changes, apply rolled-back file changes on top
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type Checkpoint,
  type CheckpointMeta,
  type CreateCheckpointOptions,
  type RestoreResult,
  createCheckpoint,
  loadCheckpoint,
  restoreCheckpoint,
} from "./checkpoints.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry in the rollback mapping: links a user card to a pre-message checkpoint. */
export interface RollbackMapEntry {
  /** The UserCard's id in AgentState.cards. */
  userCardId: string;
  /** The checkpoint created just before this user message was submitted. */
  checkpointId: string;
  /** Timestamp of the mapping entry creation. */
  createdAt: number;
  /** The user message text at this checkpoint. */
  userText: string;
}

/** Tracks an active rollback for potential undo. */
export interface RollbackState {
  /** Unique id for this rollback operation. */
  id: string;
  /** The UserCard id that was rolled back to. */
  targetUserCardId: string;
  /** Checkpoint restored during rollback (the target message's pre-submit snapshot). */
  restoredCheckpointId: string;
  /** Checkpoint created BEFORE the rollback, so we can undo (restore to this). */
  preRollbackCheckpointId: string;
  /** Timestamp when rollback was performed. */
  timestamp: number;
  /** Whether this rollback is currently active. */
  isActive: boolean;
}

/** Result of performing a rollback. */
export interface RollbackResult {
  /** The RollbackState for the operation. */
  state: RollbackState;
  /** Files restored to their pre-message state. */
  restoredFiles: string[];
  /** Files removed (didn't exist at checkpoint). */
  removedFiles: string[];
}

/** Result of undoing a rollback. */
export interface UndoRollbackResult {
  /** Files restored (the pre-rollback state). */
  restoredFiles: string[];
  /** Files removed during undo. */
  removedFiles: string[];
  /** Whether conflicts were detected. */
  hasConflicts: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLLBACK_MAP_FILE = "rollback-map.json";
const ROLLBACK_STATE_DIR = "rollbacks";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function sanitizeRoot(rootDir: string): string {
  return resolve(rootDir)
    .replace(/[\\/:]+/g, "_")
    .replace(/^_+/, "");
}

function sessionRoot(rootDir: string): string {
  return join(homedir(), ".reasonix", "sessions", sanitizeRoot(rootDir));
}

function rollbackMapPath(rootDir: string): string {
  return join(sessionRoot(rootDir), ROLLBACK_MAP_FILE);
}

function rollbackDir(rootDir: string): string {
  return join(sessionRoot(rootDir), ROLLBACK_STATE_DIR);
}

function rollbackStatePath(rootDir: string, rollbackId: string): string {
  return join(rollbackDir(rootDir), `${rollbackId}.json`);
}

// ---------------------------------------------------------------------------
// Rollback map — cardId ↔ checkpointId
// ---------------------------------------------------------------------------

/** Load the rollback mapping for a workspace. Returns empty map when missing. */
export function loadRollbackMap(rootDir: string): Map<string, RollbackMapEntry> {
  const path = rollbackMapPath(rootDir);
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const map = new Map<string, RollbackMapEntry>();
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.userCardId === "string" &&
        typeof entry.checkpointId === "string"
      ) {
        map.set(entry.userCardId, entry as RollbackMapEntry);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Persist the rollback mapping. */
export function saveRollbackMap(rootDir: string, map: Map<string, RollbackMapEntry>): void {
  const path = rollbackMapPath(rootDir);
  const entries = [...map.values()];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf8");
}

/** Record an auto-checkpoint associated with a user card. */
export function recordAutoCheckpoint(
  rootDir: string,
  userCardId: string,
  checkpointId: string,
  userText?: string,
): void {
  const map = loadRollbackMap(rootDir);
  const existing = map.get(userCardId);
  map.set(userCardId, {
    userCardId,
    checkpointId,
    createdAt: existing?.createdAt ?? Date.now(),
    userText: userText ?? existing?.userText ?? "",
  });
  saveRollbackMap(rootDir, map);
}

/** Get the checkpoint id for a user card. Returns null when missing. */
export function getCheckpointForCard(rootDir: string, userCardId: string): string | null {
  const map = loadRollbackMap(rootDir);
  return map.get(userCardId)?.checkpointId ?? null;
}

// ---------------------------------------------------------------------------
// Rollback state — track active rollbacks for undo
// ---------------------------------------------------------------------------

/** Load all rollback states for a workspace. */
export function loadRollbackStates(rootDir: string): RollbackState[] {
  const dir = rollbackDir(rootDir);
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir);
    const states: RollbackState[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(dir, file), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.id === "string") {
          states.push(parsed as RollbackState);
        }
      } catch {
        // Skip corrupt files
      }
    }
    return states;
  } catch {
    return [];
  }
}

/** Save a rollback state. */
export function saveRollbackState(rootDir: string, state: RollbackState): void {
  const dir = rollbackDir(rootDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(rollbackStatePath(rootDir, state.id), JSON.stringify(state, null, 2), "utf8");
}

/** Deactivate a rollback state (mark as inactive). */
export function deactivateRollbackState(rootDir: string, rollbackId: string): void {
  const states = loadRollbackStates(rootDir);
  const updated = states.map((s) =>
    s.id === rollbackId ? { ...s, isActive: false } : s,
  );
  // Rewrite all states
  const dir = rollbackDir(rootDir);
  mkdirSync(dir, { recursive: true });
  for (const s of updated) {
    writeFileSync(rollbackStatePath(rootDir, s.id), JSON.stringify(s, null, 2), "utf8");
  }
}

// ---------------------------------------------------------------------------
// File helpers — discover tracked files for snapshot
// ---------------------------------------------------------------------------

/** Get list of tracked files in the workspace (via git ls-files). */
function getTrackedFiles(rootDir: string): string[] {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith("GIT_")) delete env[k];
    }
    const stdout = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: rootDir,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main rollback operations
// ---------------------------------------------------------------------------

/**
 * Create an auto-checkpoint BEFORE a user message is processed.
 * This captures the file state before any tool calls from this message
 * modify the workspace.
 *
 * @returns The checkpoint id to associate with the user card.
 */
export function createAutoCheckpoint(rootDir: string, userCardId: string, label: string, userText?: string): string {
  const files = getTrackedFiles(rootDir);
  const meta = createCheckpoint({
    rootDir,
    name: `auto-msg-${label}`,
    source: "auto-session-start",
    paths: files,
  });
  recordAutoCheckpoint(rootDir, userCardId, meta.id, userText);
  return meta.id;
}

/**
 * Perform a rollback to the state before a specific user message.
 *
 * 1. Looks up the checkpoint for the target user message
 * 2. Creates a pre-rollback checkpoint (for undo)
 * 3. Restores the target checkpoint
 *
 * @returns The result of the rollback, including the state object for undo.
 */
export function performRollback(
  rootDir: string,
  targetUserCardId: string,
): RollbackResult | { error: string } {
  const targetCheckpointId = getCheckpointForCard(rootDir, targetUserCardId);
  if (!targetCheckpointId) {
    return { error: `No checkpoint found for card ${targetUserCardId}` };
  }

  const cp = loadCheckpoint(rootDir, targetCheckpointId);
  if (!cp) {
    return { error: `Checkpoint ${targetCheckpointId} not found on disk` };
  }

  // Create a pre-rollback checkpoint of current state (for undo)
  const files = getTrackedFiles(rootDir);
  const rollbackId = `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const preRollbackMeta = createCheckpoint({
    rootDir,
    name: `pre-rollback-${rollbackId}`,
    source: "auto-pre-restore",
    paths: files,
  });

  // Restore the target checkpoint
  const result = restoreCheckpoint(rootDir, targetCheckpointId);

  // Record the rollback state
  const state: RollbackState = {
    id: rollbackId,
    targetUserCardId,
    restoredCheckpointId: targetCheckpointId,
    preRollbackCheckpointId: preRollbackMeta.id,
    timestamp: Date.now(),
    isActive: true,
  };
  saveRollbackState(rootDir, state);

  return {
    state,
    restoredFiles: result.restored,
    removedFiles: result.removed,
  };
}

/**
 * Check whether there are new user messages since a rollback.
 * Used to determine if we need the merge/reproduce choice dialog.
 */
export function getChangesSinceRollback(
  rollback: RollbackState,
  currentUserCardIds: readonly string[],
): string[] {
  const targetIndex = currentUserCardIds.indexOf(rollback.targetUserCardId);
  if (targetIndex < 0) return [];
  return currentUserCardIds.slice(targetIndex + 1);
}

/**
 * Undo a rollback — simple restore to the pre-rollback state.
 * Used when there are no new changes since the rollback.
 */
export function undoRollback(
  rootDir: string,
  rollbackId: string,
): UndoRollbackResult | { error: string } {
  const states = loadRollbackStates(rootDir);
  const state = states.find((s) => s.id === rollbackId);
  if (!state) {
    return { error: `Rollback state ${rollbackId} not found` };
  }

  // Restore the pre-rollback checkpoint
  const result = restoreCheckpoint(rootDir, state.preRollbackCheckpointId);

  // Deactivate the rollback
  deactivateRollbackState(rootDir, rollbackId);

  return {
    restoredFiles: result.restored,
    removedFiles: result.removed,
    hasConflicts: false,
  };
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Three-way merge for the "Merge" choice:
 * Keep the current file state but apply the rollback's file changes on top,
 * preserving any new changes the user made since the rollback.
 *
 * Strategy per file:
 * - If only the rollback changed it (no new changes) → apply rollback version
 * - If only new changes touched it → keep current version
 * - If both changed it (and to different contents) → flag conflict, keep current
 */
export function mergeRollbackChanges(
  rootDir: string,
  rollbackId: string,
): UndoRollbackResult | { error: string } {
  const states = loadRollbackStates(rootDir);
  const state = states.find((s) => s.id === rollbackId);
  if (!state) {
    return { error: `Rollback state ${rollbackId} not found` };
  }

  const preRollbackCp = loadCheckpoint(rootDir, state.preRollbackCheckpointId);
  const restoredCp = loadCheckpoint(rootDir, state.restoredCheckpointId);
  if (!preRollbackCp || !restoredCp) {
    return { error: "Checkpoint data not available for merge" };
  }

  // Build lookup maps
  const preRbMap = new Map<string, string | null>();
  for (const f of preRollbackCp.files) preRbMap.set(f.path, f.content);

  const restoredMap = new Map<string, string | null>();
  for (const f of restoredCp.files) restoredMap.set(f.path, f.content);

  // Current state: read current file contents for all paths across both checkpoints
  const currentMap = new Map<string, string | null>();
  const allPaths = new Set<string>();
  for (const f of preRollbackCp.files) allPaths.add(f.path);
  for (const f of restoredCp.files) allPaths.add(f.path);

  const absRoot = resolve(rootDir);
  for (const p of allPaths) {
    const abs = resolve(absRoot, p);
    if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) continue;
    try {
      if (existsSync(abs)) {
        const content = readFileSync(abs, "utf8");
        currentMap.set(p, content);
      } else {
        currentMap.set(p, null);
      }
    } catch {
      currentMap.set(p, null);
    }
  }

  const result: UndoRollbackResult = {
    restoredFiles: [],
    removedFiles: [],
    hasConflicts: false,
  };

  // Merge per-file:
  // - rollback change only → apply rollback version
  // - new change only → keep current (already on disk)
  // - both changed (different) → conflict, keep current
  // - neither changed → skip
  for (const [p, preRbContent] of preRbMap) {
    const restoredContent = restoredMap.get(p) ?? null;
    const currentContent = currentMap.get(p) ?? null;

    const restoredChanged = restoredContent !== preRbContent;
    const currentChanged = currentContent !== preRbContent;

    if (restoredChanged && !currentChanged) {
      // Only rollback changed it → apply rollback version
      applyFileChange(rootDir, p, restoredContent, result);
    } else if (restoredChanged && currentChanged && restoredContent !== currentContent) {
      // Both changed → conflict. Keep current version, flag.
      result.hasConflicts = true;
    }
    // else: keep current
  }

  deactivateRollbackState(rootDir, rollbackId);
  return result;
}

/** Apply a single file content change (write or delete). */
function applyFileChange(
  rootDir: string,
  relPath: string,
  content: string | null,
  result: UndoRollbackResult,
): void {
  const absRoot = resolve(rootDir);
  const abs = resolve(absRoot, relPath);
  if (abs !== absRoot && !abs.startsWith(`${absRoot}${sep}`)) return;
  try {
    if (content === null) {
      if (existsSync(abs)) {
        rmSync(abs);
        result.removedFiles.push(relPath);
      }
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      result.restoredFiles.push(relPath);
    }
  } catch {
    // Best-effort per-file
  }
}
