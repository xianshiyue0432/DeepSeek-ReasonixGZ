/**
 * Rules store — natural-language rules for AI behavior.
 *
 * Follows the same pattern as MemoryStore (src/memory/user.ts) but stores
 * simple natural-language rules instead of structured memory entries.
 *
 * Rules are stored as .md files with frontmatter, one file per rule.
 * A MEMORY.md-style index is maintained for each scope.
 *
 * Rules are injected into the system prompt alongside memory in applyMemoryStack.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";

export const RULES_DIR = "rules";
export const RULES_INDEX_FILE = "RULES.md";
export const RULES_INDEX_MAX_CHARS = 4000;

export type RuleScope = "global" | "project";

export interface RuleEntry {
  name: string;
  scope: RuleScope;
  /** One-line summary shown in the index. */
  description: string;
  /** Full rule text / instruction body. */
  body: string;
  /** ISO date string. */
  createdAt: string;
  /** Last modified ISO date string. */
  updatedAt: string;
}

export interface RulesStoreOptions {
  homeDir?: string;
  projectRoot?: string;
}

/** Permissive: any non-empty 1-1000 char name that does not contain
 *  path separators (`/`, `\`) or NUL bytes. */
const VALID_NAME = /^[^\/\\\0\n\r\t]{1,1000}$/;

function sanitizeName(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error(`invalid rule name: ${JSON.stringify(raw)} — name cannot be empty`);
  }
  if (!VALID_NAME.test(trimmed)) {
    throw new Error(
      `invalid rule name: ${JSON.stringify(raw)} — must be 1-1000 chars, no path separators (/, \\) or control characters`,
    );
  }
  return trimmed;
}

function projectHash(rootDir: string): string {
  const abs = resolve(rootDir);
  return createHash("sha1").update(abs).digest("hex").slice(0, 16);
}

function scopeDir(opts: { homeDir: string; scope: RuleScope; projectRoot?: string }): string {
  if (opts.scope === "global") {
    return join(opts.homeDir, RULES_DIR, "global");
  }
  if (!opts.projectRoot) {
    throw new Error("scope=project requires a projectRoot");
  }
  return join(opts.homeDir, RULES_DIR, projectHash(opts.projectRoot));
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function indexLine(e: RuleEntry): string {
  const safeDesc = e.description.replace(/\n/g, " ").trim();
  return `- \`${e.name}\` — ${safeDesc}`;
}

/** Frontmatter format for a rule file. */
function formatFrontmatter(e: RuleEntry): string {
  return [
    "---",
    `name: ${e.name}`,
    `scope: ${e.scope}`,
    `description: ${e.description.replace(/\n/g, " ")}`,
    `created: ${e.createdAt}`,
    `updated: ${e.updatedAt}`,
    "---",
    "",
  ].join("\n");
}

/** Parse a rule file's frontmatter + body. Returns null on parse failure. */
function parseRuleFile(filePath: string): RuleEntry | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const fm = parseFrontmatter(raw);
    if (!fm || !fm.data || typeof fm.data.name !== "string") return null;
    return {
      name: fm.data.name,
      scope: fm.data.scope === "project" ? "project" : "global",
      description: String(fm.data.description ?? ""),
      body: fm.body.trim(),
      createdAt: String(fm.data.created ?? todayIso()),
      updatedAt: String(fm.data.updated ?? fm.data.created ?? todayIso()),
    };
  } catch {
    return null;
  }
}

function indexPath(opts: { homeDir: string; scope: RuleScope; projectRoot?: string }): string {
  return join(scopeDir(opts), RULES_INDEX_FILE);
}

function regenerateIndex(opts: { homeDir: string; scope: RuleScope; projectRoot?: string }): void {
  const dir = scopeDir(opts);
  ensureDir(dir);
  let entries: RuleEntry[] = [];
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".md") || f === RULES_INDEX_FILE) continue;
      const entry = parseRuleFile(join(dir, f));
      if (entry) entries.push(entry);
    }
  } catch {
    entries = [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = entries.map(indexLine);
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  writeFileSync(join(dir, RULES_INDEX_FILE), content, "utf8");
}

export class RulesStore {
  private homeDir: string;
  private projectRoot?: string;

  constructor(opts: RulesStoreOptions = {}) {
    this.homeDir = opts.homeDir ?? join(homedir(), ".reasonix");
    this.projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : undefined;
  }

  /** List all rules in a scope. */
  list(scope: RuleScope): RuleEntry[] {
    const dir = scopeDir({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
    ensureDir(dir);
    const entries: RuleEntry[] = [];
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (!f.endsWith(".md") || f === RULES_INDEX_FILE) continue;
        const entry = parseRuleFile(join(dir, f));
        if (entry) entries.push(entry);
      }
    } catch { /* empty dir */ }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** Read a single rule by name. Returns null if not found. */
  read(name: string, scope: RuleScope): RuleEntry | null {
    const safe = sanitizeName(name);
    const dir = scopeDir({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
    const filePath = join(dir, `${safe}.md`);
    if (!existsSync(filePath)) return null;
    return parseRuleFile(filePath);
  }

  /** Write (create or update) a rule. */
  write(input: {
    name: string;
    description: string;
    body: string;
    scope: RuleScope;
  }): RuleEntry {
    const safe = sanitizeName(input.name);
    const dir = scopeDir({ homeDir: this.homeDir, scope: input.scope, projectRoot: this.projectRoot });
    ensureDir(dir);
    const filePath = join(dir, `${safe}.md`);
    const existing = existsSync(filePath) ? parseRuleFile(filePath) : null;
    const now = todayIso();
    const entry: RuleEntry = {
      name: safe,
      scope: input.scope,
      description: input.description.trim(),
      body: input.body.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const content = formatFrontmatter(entry) + entry.body + "\n";
    writeFileSync(filePath, content, "utf8");
    regenerateIndex({ homeDir: this.homeDir, scope: input.scope, projectRoot: this.projectRoot });
    return entry;
  }

  /** Delete a rule by name. Returns true if deleted, false if not found. */
  delete(name: string, scope: RuleScope): boolean {
    const safe = sanitizeName(name);
    const dir = scopeDir({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
    const filePath = join(dir, `${safe}.md`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    regenerateIndex({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
    return true;
  }

  /** Get the full index content for a scope (for system prompt injection). */
  renderIndex(scope: RuleScope): string {
    const ip = indexPath({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
    if (!existsSync(ip)) return "";
    try {
      const raw = readFileSync(ip, "utf8");
      return raw.slice(0, RULES_INDEX_MAX_CHARS);
    } catch {
      return "";
    }
  }
}

/** Convenience: read rules index content for both scopes, formatted for the system prompt. */
export function renderRulesForPrompt(rootDir?: string, homeDir?: string): string {
  const store = new RulesStore({ projectRoot: rootDir, homeDir });
  const parts: string[] = [];

  const globalIndex = store.renderIndex("global");
  if (globalIndex) parts.push(`# Global Rules\n\n${globalIndex}`);

  if (rootDir) {
    const projectIndex = store.renderIndex("project");
    if (projectIndex) parts.push(`# Project Rules\n\n${projectIndex}`);
  }

  return parts.join("\n\n");
}
