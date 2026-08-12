/**
 * AK-2 Path Policy —— canonical POSIX relative path 验证与 scope 归属。
 *
 * canonical 定义（fail-closed）：
 * - 非空；不是绝对路径（不以 "/" 开头）；不含 NUL、反斜杠；
 * - 分段后无空段（拒绝 `//`）、无 "."、".."、无 "./" 前缀段；
 * - 无尾随斜杠；
 * - 与自身规范化（normalize 后逐字节相同）一致。
 *
 * scope 不变量：
 * - writableRoots / readonlyRoots 各自互不相交（同 scope 内嵌套/重复拒绝）；
 * - 跨 scope 任何重叠（相等、嵌套）拒绝 —— 归属判定必须唯一；
 * - expectedOutputs 必须在 writable scope 内且不在 readonly scope 内。
 */

import { ProjectionError, type ProjectionErrorCode } from "./contracts"

/** canonicalize 一个相对路径；任何非法形式抛 ProjectionError(INVALID_PATH/
 *  NON_CANONICAL_PATH)。 */
export function canonicalizeProjectionPath(raw: string): string {
  if (typeof raw !== "string") {
    throw new ProjectionError("INVALID_PATH", `projection path must be a string: ${String(raw)}`)
  }
  if (raw.length === 0) throw new ProjectionError("INVALID_PATH", "projection path must be non-empty")
  if (raw.includes("\0")) throw new ProjectionError("INVALID_PATH", "projection path must not contain NUL")
  if (raw.includes("\\")) {
    throw new ProjectionError("INVALID_PATH", "projection path must not contain backslash")
  }
  if (/[\r\n]/.test(raw)) {
    throw new ProjectionError("INVALID_PATH", "projection path must not contain CR/LF")
  }
  if (raw.startsWith("/")) {
    throw new ProjectionError("INVALID_PATH", `projection path must be relative: ${raw}`)
  }
  if (raw.endsWith("/")) {
    throw new ProjectionError("NON_CANONICAL_PATH", `projection path must not end with slash: ${raw}`)
  }
  if (raw.includes("//")) {
    throw new ProjectionError("NON_CANONICAL_PATH", `projection path must not contain duplicate separators: ${raw}`)
  }
  const segments = raw.split("/")
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new ProjectionError("NON_CANONICAL_PATH", `projection path must not contain empty segments: ${raw}`)
    }
    if (segment === "." || segment === "..") {
      throw new ProjectionError("NON_CANONICAL_PATH", `projection path must not contain ${segment}: ${raw}`)
    }
    if (segment.includes("\0")) {
      throw new ProjectionError("INVALID_PATH", "projection path segment must not contain NUL")
    }
  }
  return raw
}

/** 冻结的 scope 视图：root 已 canonicalize 且互不相交。 */
export interface ProjectionScope {
  readonly writableRoots: readonly string[]
  readonly readonlyRoots: readonly string[]
  readonly expectedOutputs: readonly string[]
}

function assertDisjoint(
  roots: readonly string[],
  label: string,
): readonly string[] {
  const seen = new Set<string>()
  for (const raw of roots) {
    const root = canonicalizeProjectionPath(raw)
    for (const other of seen) {
      if (root === other) {
        throw new ProjectionError("DUPLICATE_SCOPE_ROOT", `${label} contains duplicate root: ${root}`)
      }
      if (root.startsWith(`${other}/`) || other.startsWith(`${root}/`)) {
        throw new ProjectionError(
          "SCOPE_OVERLAP",
          `${label} roots must be disjoint (${other} vs ${root})`,
        )
      }
    }
    seen.add(root)
  }
  return Object.freeze([...seen])
}

function assertCrossDisjoint(
  left: readonly string[],
  right: readonly string[],
  leftLabel: string,
  rightLabel: string,
): void {
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new ProjectionError(
          "SCOPE_AMBIGUITY",
          `${leftLabel} root ${a} overlaps ${rightLabel} root ${b}`,
        )
      }
    }
  }
}

/** path 是否位于 root（root 自身或其下任意后代）。 */
export function pathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/** path 是否位于 roots 中任一 root 下。 */
export function pathWithinAny(path: string, roots: readonly string[]): boolean {
  return roots.some(root => pathWithinRoot(path, root))
}

/** 验证并冻结 scope；任何歧义抛 ProjectionError。 */
export function buildProjectionScope(
  writableRoots: readonly string[],
  readonlyRoots: readonly string[],
  expectedOutputs: readonly string[],
): ProjectionScope {
  const writable = assertDisjoint(writableRoots, "writableRoots")
  const readonly = assertDisjoint(readonlyRoots, "readonlyRoots")
  assertCrossDisjoint(writable, readonly, "writableRoots", "readonlyRoots")
  if (writable.length === 0) {
    throw new ProjectionError("SCOPE_AMBIGUITY", "writableRoots must contain at least one root")
  }
  const outputs = Object.freeze(expectedOutputs.map(canonicalizeProjectionPath))
  for (const output of outputs) {
    if (!pathWithinAny(output, writable)) {
      throw new ProjectionError(
        "EXPECTED_OUTPUT_OUTSIDE_WRITABLE",
        `expected output ${output} is outside all writableRoots`,
      )
    }
    if (pathWithinAny(output, readonly)) {
      throw new ProjectionError(
        "EXPECTED_OUTPUT_INSIDE_READONLY",
        `expected output ${output} is inside a readonlyRoot`,
      )
    }
  }
  return Object.freeze({ writableRoots: writable, readonlyRoots: readonly, expectedOutputs: outputs })
}

/** 合法非空 ID（projectionId/worldId/branchId/snapshotId/actor）。
 *  错误码按 label 精确映射（不统一归 INVALID_WORLD_ID）。 */
export function assertProjectionId(value: string, label: ProjectionIdLabel): string {
  const code: ProjectionErrorCode =
    label === "projectionId"
      ? "INVALID_PROJECTION_ID"
      : label === "worldId"
        ? "INVALID_WORLD_ID"
        : label === "branchId"
          ? "INVALID_BRANCH_ID"
          : label === "snapshotId"
            ? "INVALID_SNAPSHOT_ID"
            : "INVALID_ACTOR"
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectionError(code, `${label} must be a non-empty string`)
  }
  if (value !== value.trim()) {
    throw new ProjectionError(code, `${label} must not have leading/trailing whitespace`)
  }
  if (/[\0\r\n]/.test(value)) {
    throw new ProjectionError(code, `${label} must not contain NUL/CR/LF`)
  }
  if (value.length > 512) {
    throw new ProjectionError(code, `${label} exceeds 512 chars`)
  }
  return value
}

export type ProjectionIdLabel =
  | "projectionId"
  | "worldId"
  | "branchId"
  | "snapshotId"
  | "actor"
