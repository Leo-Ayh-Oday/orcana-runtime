/**
 * AK-2 Immutable Snapshot Materializer。
 *
 * 只从 plan 指定的 immutable snapshot 物化：
 * - 内容来源 = snapshot.filesystemDigest 对应的 canonical world-section
 *   manifest + CAS bytes；**绝不读取当前 World HEAD**；
 * - 只物化 regular file 与 directory（拒绝 symlink/hardlink/device/FIFO/
 *   socket 语义的 entry；kind=workspace 无 path 时跳过，带 path 拒绝）；
 * - 拒绝 duplicate path、file/directory collision 与 path escape；
 * - 物化完成后 lower base 全部只读（file 0444 / directory 0555）；
 * - 不把 WorldDB/CAS authority 路径暴露给执行环境（只写独立 baseDir）。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  readdirSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from "node:fs"
import { join, resolve, sep } from "node:path"
import type { CasDigest, WorldSnapshot } from "../world/contracts"
import { ProjectionError } from "./contracts"
import { canonicalizeProjectionPath } from "./path-policy"
import { parseCanonicalJson } from "../world/canonical"

/** 物化内容源 —— 只读消费 WorldStore 的公开快照/CAS 边界。 */
export interface ProjectionMaterializerSource {
  readonly getSnapshot: (snapshotId: string) => WorldSnapshot | undefined
  readonly readCasObject: (digest: CasDigest) => Buffer
}

/** filesystem section manifest 的运行时解析形态。 */
export interface MaterializedSectionEntry {
  readonly id: string
  readonly kind: string
  readonly path?: string
  readonly contentRef?: CasDigest
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface MaterializedSectionManifest {
  readonly schemaVersion: 1
  readonly type: "world-section"
  readonly section: "filesystem"
  readonly entries: readonly MaterializedSectionEntry[]
}

export interface MaterializedBase {
  readonly baseDir: string
  readonly snapshot: WorldSnapshot
  readonly entryCount: number
  readonly fileCount: number
  readonly directoryCount: number
}

/** 解析并验证 filesystem section manifest（fatal，malformed 拒绝）。 */
export function parseFilesystemSection(bytes: Buffer): MaterializedSectionManifest {
  let parsed: unknown
  try {
    parsed = parseCanonicalJson<unknown>(bytes.toString("utf8"))
  } catch {
    throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section manifest is not canonical JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section manifest must be an object")
  }
  const manifest = parsed as Record<string, unknown>
  if (manifest.schemaVersion !== 1 || manifest.type !== "world-section") {
    throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section manifest envelope mismatch")
  }
  if (manifest.section !== "filesystem") {
    throw new ProjectionError(
      "MATERIALIZATION_FAILED",
      `expected filesystem section, got ${String(manifest.section)}`,
    )
  }
  if (!Array.isArray(manifest.entries)) {
    throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entries must be an array")
  }
  const entries: MaterializedSectionEntry[] = []
  for (const raw of manifest.entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entry must be an object")
    }
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entry id must be non-empty")
    }
    if (typeof entry.kind !== "string" || entry.kind.length === 0) {
      throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entry kind must be non-empty")
    }
    if (entry.path !== undefined && typeof entry.path !== "string") {
      throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entry path must be a string")
    }
    if (entry.contentRef !== undefined && typeof entry.contentRef !== "string") {
      throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entry contentRef must be a string")
    }
    if (entry.metadata !== undefined && (typeof entry.metadata !== "object" || entry.metadata === null || Array.isArray(entry.metadata))) {
      throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entry metadata must be a plain record")
    }
    entries.push({
      id: entry.id,
      kind: entry.kind,
      ...(entry.path === undefined ? {} : { path: entry.path }),
      ...(entry.contentRef === undefined ? {} : { contentRef: entry.contentRef as CasDigest }),
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata as Readonly<Record<string, unknown>> }),
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    type: "world-section" as const,
    section: "filesystem" as const,
    entries: Object.freeze(entries.map(entry => Object.freeze(entry))),
  })
}

/** 物化器 —— 从 snapshot 重建 immutable lower base。 */
export class SnapshotMaterializer {
  constructor(private readonly source: ProjectionMaterializerSource) {}

  /**
   * 物化 snapshot 到 baseDir（必须已存在且为空）。返回只读 lower base。
   * 不访问 World HEAD；snapshot 内容完全来自 CAS。
   */
  materialize(snapshot: WorldSnapshot, baseDir: string): MaterializedBase {
    if (!this.source.getSnapshot(snapshot.snapshotId)) {
      throw new ProjectionError("SNAPSHOT_NOT_FOUND", `snapshot ${snapshot.snapshotId} is not stored`)
    }
    const absoluteBase = resolve(baseDir)
    if (!existsSync(absoluteBase)) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `materialization root does not exist: ${absoluteBase}`)
    }
    const baseStat = lstatSync(absoluteBase)
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `materialization root must be a real directory: ${absoluteBase}`)
    }
    if (readdirSync(absoluteBase).length !== 0) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `materialization root must be empty: ${absoluteBase}`)
    }

    const manifestBytes = this.readSectionManifest(snapshot.filesystemDigest)
    const manifest = parseFilesystemSection(manifestBytes)

    // 规范顺序验证（createSectionManifest 按 path/id canonical 排序）。
    const canonicalOrder = [...manifest.entries].sort((left, right) => {
      const leftPath = left.path ?? ""
      const rightPath = right.path ?? ""
      const byPath = leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
      if (byPath !== 0) return byPath
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
    for (let index = 0; index < manifest.entries.length; index++) {
      const actual = manifest.entries[index]!
      const expected = canonicalOrder[index]!
      if (actual !== expected) {
        throw new ProjectionError("MATERIALIZATION_FAILED", "filesystem section entries are not canonically ordered")
      }
    }

    // path 唯一性 + file/directory collision + 类型约束。
    const byPath = new Map<string, MaterializedSectionEntry>()
    for (const entry of manifest.entries) {
      const path = entry.path
      if (path === undefined) {
        // 无 path 的 entry：workspace/无路径对象不物化（AK-2 只物化 file/directory）。
        if (entry.kind === "workspace") continue
        throw new ProjectionError(
          "MATERIALIZATION_FAILED",
          `filesystem entry ${entry.id} (${entry.kind}) has no path`,
        )
      }
      const canonical = this.canonicalEntryPath(path, entry)
      if (canonical !== path) {
        throw new ProjectionError("MATERIALIZATION_FAILED", `filesystem entry path is not canonical: ${path}`)
      }
      if (byPath.has(canonical)) {
        throw new ProjectionError("MATERIALIZATION_FAILED", `duplicate filesystem entry path: ${canonical}`)
      }
      if (entry.kind === "file") {
        if (entry.contentRef === undefined) {
          throw new ProjectionError("MATERIALIZATION_FAILED", `file entry ${entry.id} has no contentRef`)
        }
      } else if (entry.kind === "directory") {
        // 允许无 contentRef；有则必须存在（防御）。
      } else {
        throw new ProjectionError(
          "MATERIALIZATION_FAILED",
          `filesystem entry ${entry.id} has unsupported kind ${entry.kind} ` +
            `(only file/directory are materializable; symlink/hardlink/device/FIFO/socket rejected)`,
        )
      }
      byPath.set(canonical, entry)
    }

    // file/directory collision：某 path 是 file，同时又是另一 entry 的目录祖先。
    for (const [path, entry] of byPath) {
      if (entry.kind !== "file") continue
      let parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined
      while (parent !== undefined && parent.length > 0) {
        const parentEntry = byPath.get(parent)
        if (parentEntry && parentEntry.kind !== "directory") {
          throw new ProjectionError(
            "MATERIALIZATION_FAILED",
            `file ${path} collides with non-directory parent entry ${parent}`,
          )
        }
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : undefined
      }
    }

    // 物化（只创建 regular file + directory；O_NOFOLLOW 语义由「root 为空 +
    // 逐级自建」保证无既有 symlink 可跟随）。
    let fileCount = 0
    let directoryCount = 0
    const plannedDirectories = [...byPath.entries()]
      .filter(([, entry]) => entry.kind === "directory")
      .map(([path]) => path)
      .sort()
    const createdDirectories = new Set<string>()
    for (const rel of plannedDirectories) {
      this.ensureDirectory(absoluteBase, rel)
      createdDirectories.add(rel)
      directoryCount++
    }
    // 文件父目录隐式创建（含未声明的中间目录）。
    for (const [path, entry] of byPath) {
      if (entry.kind !== "file") continue
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
      if (parent.length > 0) this.ensureDirectory(absoluteBase, parent)
      const content = this.readFileContent(entry.contentRef!)
      const target = this.joinWithin(absoluteBase, path)
      const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o444)
      try {
        writeFileSync(fd, content, { mode: 0o444 })
      } finally {
        closeSync(fd)
      }
      fileCount++
    }

    // 文件 0444 物理只读（lower 内容不可被直接写）。目录保持 0755：
    // fuse-overlayfs 对 0555 目录的 copy-up 会 EACCES，而 overlay 层的
    // lower 语义本身保证 merged 的写入永远落在 upper —— 目录只读由
    // overlay 层保证，不由 mode 承担。

    return Object.freeze({
      baseDir: absoluteBase,
      snapshot: Object.freeze({ ...snapshot }),
      entryCount: byPath.size,
      fileCount,
      directoryCount,
    })
  }

  /** 读取 section manifest（source 错误统一包装为 MATERIALIZATION_FAILED）。 */
  private readSectionManifest(digest: CasDigest): Buffer {
    try {
      return this.source.readCasObject(digest)
    } catch (error) {
      throw new ProjectionError(
        "MATERIALIZATION_FAILED",
        `cannot read filesystem section manifest ${digest}`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 读取文件内容（source 错误统一包装为 MATERIALIZATION_FAILED）。 */
  private readFileContent(digest: CasDigest): Buffer {
    try {
      return this.source.readCasObject(digest)
    } catch (error) {
      throw new ProjectionError(
        "MATERIALIZATION_FAILED",
        `cannot read file content ${digest}`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 路径 canonicalize 错误统一包装为 MATERIALIZATION_FAILED。 */
  private canonicalEntryPath(path: string, entry: MaterializedSectionEntry): string {
    try {
      return canonicalizeProjectionPath(path)
    } catch {
      throw new ProjectionError(
        "MATERIALIZATION_FAILED",
        `filesystem entry ${entry.id} has invalid path: ${path}`,
      )
    }
  }

  /** 逐级创建目录；任何既有非目录或 symlink → 拒绝。 */
  private ensureDirectory(base: string, rel: string): void {
    const segments = rel.split("/")
    let current = base
    for (const segment of segments) {
      current = join(current, segment)
      if (existsSync(current)) {
        const stat = lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new ProjectionError(
            "MATERIALIZATION_FAILED",
            `materialization path component is not a real directory: ${rel}`,
          )
        }
        continue
      }
      mkdirSync(current, { mode: 0o700 })
    }
  }

  /** 路径必须落在 base 内（防 escape；base 为新目录无 symlink，防御性验证）。 */
  private joinWithin(base: string, rel: string): string {
    const joined = join(base, ...rel.split("/"))
    const resolved = resolve(joined)
    if (resolved !== joined || !resolved.startsWith(base + sep)) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `path escapes materialization root: ${rel}`)
    }
    return resolved
  }
}
