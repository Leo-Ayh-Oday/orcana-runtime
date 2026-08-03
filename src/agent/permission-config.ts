/** Permission config loader — user-level and project-level JSON config files.
 *
 *  Config files are read once at startup. Invalid JSON / missing files are
 *  silently ignored (graceful degradation). The priority chain in
 *  PermissionGate.check() applies: Global Deny > User Deny > Project Deny >
 *  Session Override > User Allow > Project Allow > Tool Declared > Category Default.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import type { PermissionLevel, ToolCategory } from "./permission"

// ── Types ──

export interface PermissionRule {
  toolName: string
  paramKey?: string
  paramPattern?: string
  pathPattern?: string
  level: "allow" | "deny"
  reason: string
}

export interface PermissionConfig {
  rules: PermissionRule[]
  categoryOverrides?: Partial<Record<ToolCategory, PermissionLevel>>
}

// ── Loaders ──

/** Load user-level config from ~/.orcana/permissions.json */
export function loadUserConfig(): PermissionConfig | null {
  const path = join(homedir(), ".orcana", "permissions.json")
  return loadConfigFile(path)
}

/** Load project-level config from <projectRoot>/.orcana/permissions.json */
export function loadProjectConfig(projectRoot: string): PermissionConfig | null {
  const path = resolve(projectRoot, ".orcana", "permissions.json")
  return loadConfigFile(path)
}

function loadConfigFile(path: string): PermissionConfig | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as Partial<PermissionConfig>
    if (!parsed || typeof parsed !== "object") return null
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.filter((r: unknown): r is PermissionRule =>
          typeof (r as PermissionRule).toolName === "string" &&
          ((r as PermissionRule).level === "allow" || (r as PermissionRule).level === "deny"))
      : []
    return {
      rules,
      categoryOverrides: parsed.categoryOverrides as PermissionConfig["categoryOverrides"],
    }
  } catch {
    // Invalid JSON or unreadable — silently skip
    return null
  }
}

// ── Path-pattern matching (minimal glob, zero dependencies) ──

/**
 * Match a file path against a glob-like path pattern.
 *
 * Supported:
 *   - `**` — matches zero or more directory segments
 *   - `*`  — matches within a single directory segment (no /)
 *   - `!pattern` — exclusion (returns false if matched)
 *
 * Path and pattern use `/` as separator (normalized before matching).
 */
export function matchPathPattern(pattern: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/")
  const normalizedPattern = pattern.replace(/\\/g, "/")

  // Exclusion
  if (normalizedPattern.startsWith("!")) {
    return !matchPathPattern(normalizedPattern.slice(1), normalizedPath)
  }

  const patternParts = normalizedPattern.split("/")
  const pathParts = normalizedPath.split("/")

  return matchSegments(patternParts, pathParts, 0, 0)
}

function matchSegments(
  pattern: string[],
  path: string[],
  pi: number,
  pp: number,
): boolean {
  while (pi < pattern.length) {
    const p = pattern[pi]

    if (p === "**") {
      if (pi === pattern.length - 1) return true // trailing ** matches everything
      pi++
      // Try matching at every remaining position
      while (pp < path.length) {
        if (matchSegments(pattern, path, pi, pp)) return true
        pp++
      }
      return matchSegments(pattern, path, pi, pp)
    }

    if (pp >= path.length) return false

    if (!matchSingle(p!, path[pp]!)) return false

    pi++
    pp++
  }

  return pp >= path.length
}

function matchSingle(pattern: string, segment: string): boolean {
  if (pattern === "*") return !segment.includes("/")
  // Convert glob * to regex wildcard
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$"
  )
  return regex.test(segment)
}

// ── Rule matching ──

/**
 * Check if a PermissionRule applies to a tool call.
 * Returns { matched: true, level: "allow"|"deny", reason: string } if matched.
 */
export function matchRule(
  rule: PermissionRule,
  toolName: string,
  params: Record<string, unknown>,
): { matched: true; level: "allow" | "deny"; reason: string } | { matched: false } {
  if (rule.toolName !== "*" && rule.toolName !== toolName) return { matched: false }

  // paramKey + paramPattern
  if (rule.paramKey && rule.paramPattern) {
    const value = String(params[rule.paramKey] ?? "")
    try {
      if (!new RegExp(rule.paramPattern, "i").test(value)) return { matched: false }
    } catch { return { matched: false } }
  }

  // pathPattern — only for file_path params
  if (rule.pathPattern && rule.paramKey) {
    const value = String(params[rule.paramKey] ?? "")
    if (!matchPathPattern(rule.pathPattern, value)) return { matched: false }
  }

  return { matched: true, level: rule.level, reason: rule.reason }
}

/**
 * Check a list of rules and return the first matching result, or null.
 */
export function matchFirstRule(
  rules: PermissionRule[],
  toolName: string,
  params: Record<string, unknown>,
): { level: "allow" | "deny"; reason: string } | null {
  for (const rule of rules) {
    const result = matchRule(rule, toolName, params)
    if (result.matched) return { level: result.level, reason: result.reason }
  }
  return null
}
