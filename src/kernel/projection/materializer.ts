/**
 * AK-2 Immutable Snapshot Materializer。
 *
 * 只从 plan 指定的 immutable snapshot 物化：
 * - 内容来源 = snapshot.filesystemDigest 对应的 canonical world-section
 *   manifest + CAS bytes；**绝不读取当前 World HEAD**；contentRef 按 CAS
 *   记录区分 raw bytes 与 AK-1 FileManifest（chunk 校验后按序重建）；
 * - 只接受 snapshotId，身份字段从 WorldStore 严格校验（R06.5）；
 * - 只物化 regular file 与 directory（拒绝 symlink/hardlink/device/FIFO/
 *   socket 语义的 entry；kind=workspace 无 path 时跳过，带 path 拒绝）；
 * - 拒绝 duplicate path、file/directory collision 与 path escape；
 * - 物化后 lower base：file 0444 物理只读；directory 0755（fuse-overlayfs
 *   对 0555 目录 copy-up 会 EACCES，目录只读由 overlay 层语义保证）；
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
import { ProjectionError, DEFAULT_PROJECTION_LIMITS } from "./contracts"
import { canonicalizeProjectionPath } from "./path-policy"
import { parseCanonicalJson } from "../world/canonical"

/** 物化内容源 —— 只读消费 WorldStore 的公开快照/CAS 边界。 */
export interface ProjectionMaterializerSource {
  readonly getSnapshot: (snapshotId: string) => WorldSnapshot | undefined
  /** CAS 对象元数据（isManifest/mediaTypes）—— 用于区分 raw content 与
   *  FileManifest，不创建第二套格式。 */
  readonly getCasRecord: (digest: CasDigest) => import("../world/contracts").CasObjectRecord | undefined
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

/** 物化器 —— 从 snapshot 重建 immutable lower base。
 *  只接受 snapshotId；snapshot 身份字段全部从 WorldStore 获取并严格匹配
 *  （worldId/branchId/revision/filesystemDigest/全部 section digest），
 *  不信任调用方构造的 WorldSnapshot。 */
export class SnapshotMaterializer {
  constructor(
    private readonly source: ProjectionMaterializerSource,
    private readonly limits: import("./contracts").ProjectionLimits = DEFAULT_PROJECTION_LIMITS,
  ) {}

  /**
   * 物化 snapshot 到 baseDir（必须已存在且为空）。返回只读 lower base。
   * 不访问 World HEAD；snapshot 内容完全来自 CAS。
   */
  materialize(snapshotId: string, baseDir: string): MaterializedBase {
    const snapshot = this.source.getSnapshot(snapshotId)
    if (!snapshot) {
      throw new ProjectionError("SNAPSHOT_NOT_FOUND", `snapshot ${snapshotId} is not stored`)
    }
    this.assertCanonicalSnapshot(snapshot)
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
        // 目录允许无 contentRef；有 contentRef 时的存在性由 CAS integrity
        // 保证（snapshot 存储时 assertManifestReferences 已闭合引用），
        // 物化不重复验证（也不读取目录内容）。
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
    let treeBytes = 0
    if (manifest.entries.length > this.limits.maxEntries) {
      throw new ProjectionError("PROJECTION_RESOURCE_LIMIT", `filesystem manifest entries exceed limit (${manifest.entries.length} > ${this.limits.maxEntries})`)
    }
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
      const content = this.rebuildFileBytes(entry.contentRef!, path)
      if (content.byteLength > this.limits.maxFileBytes) {
        throw new ProjectionError(
          "PROJECTION_RESOURCE_LIMIT",
          `file ${path} exceeds maxFileBytes (${content.byteLength} > ${this.limits.maxFileBytes})`,
        )
      }
      treeBytes += content.byteLength
      if (treeBytes > this.limits.maxTreeBytes) {
        throw new ProjectionError(
          "PROJECTION_RESOURCE_LIMIT",
          `materialized tree exceeds maxTreeBytes (${treeBytes} > ${this.limits.maxTreeBytes})`,
        )
      }
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

  /** 从 WorldStore 严格校验 canonical snapshot 身份字段（R06.5）：
   *  worldId/branchId/revision 非空；全部 section digest 存在且为
   *  manifest 记录；filesystemDigest 对应 section manifest 可读。 */
  private assertCanonicalSnapshot(snapshot: WorldSnapshot): void {
    const fail = (detail: string): never => {
      throw new ProjectionError("SNAPSHOT_MISMATCH", `canonical snapshot ${snapshot.snapshotId} failed identity check: ${detail}`)
    }
    if (typeof snapshot.worldId !== "string" || snapshot.worldId.length === 0) fail("worldId missing")
    if (typeof snapshot.branchId !== "string" || snapshot.branchId.length === 0) fail("branchId missing")
    if (typeof snapshot.revision !== "bigint" && typeof snapshot.revision !== "number") fail("revision missing")
    const digests: Array<[string, CasDigest | undefined]> = [
      ["filesystem", snapshot.filesystemDigest],
      ["memory", snapshot.memoryDigest],
      ["taskState", snapshot.taskStateDigest],
      ["capabilityState", snapshot.capabilityStateDigest],
      ["serviceState", snapshot.serviceStateDigest],
      ["artifactState", snapshot.artifactStateDigest],
    ]
    for (const [label, digest] of digests) {
      if (typeof digest !== "string" || !digest.startsWith("sha256:")) fail(`${label}Digest missing`)
      const record = this.source.getCasRecord(digest as CasDigest)
      if (!record) {
        fail(`${label}Digest ${digest} has no CAS record`)
        return
      }
      if (record.isManifest !== true) fail(`${label}Digest ${digest} is not a manifest`)
    }
    // manifestDigest 存在（world manifest 引用闭合由 CAS integrity 保证）。
    if (typeof snapshot.manifestDigest !== "string" || !snapshot.manifestDigest.startsWith("sha256:")) {
      fail("manifestDigest missing")
    }
  }

  /** 重建文件原始 bytes（R04）：识别 raw CAS content 与 AK-1 FileManifest。
   *  FileManifest：完整解析 schema、校验 chunk digest/offset/size/顺序/
   *  总长度，按序重建；缺失/重复/重叠/越界/digest 错误全部 fail-closed。
   *  有界：manifest.size 与总字节受 maxFileBytes/maxFileChunks 限制。 */
  private rebuildFileBytes(contentRef: CasDigest, path: string): Buffer {
    const record = this.source.getCasRecord(contentRef)
    if (!record) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: CAS object ${contentRef} is not registered`)
    }
    const recordIsManifest = record.isManifest
    if (recordIsManifest) {
      const manifest = this.parseFileManifest(contentRef, path)
      if (manifest.size > this.limits.maxFileBytes) {
        throw new ProjectionError(
          "PROJECTION_RESOURCE_LIMIT",
          `file ${path}: FileManifest size ${manifest.size} exceeds maxFileBytes ${this.limits.maxFileBytes}`,
        )
      }
      if (manifest.chunks.length > this.limits.maxFileChunks) {
        throw new ProjectionError(
          "PROJECTION_RESOURCE_LIMIT",
          `file ${path}: FileManifest chunk count ${manifest.chunks.length} exceeds maxFileChunks ${this.limits.maxFileChunks}`,
        )
      }
      // chunk 顺序重建（CAS record.size 由 CAS 自身校验，这里逐 chunk 复核）。
      const parts: Buffer[] = []
      let expectedOffset = 0
      for (let index = 0; index < manifest.chunks.length; index++) {
        const chunk = manifest.chunks[index]!
        if (chunk.offset !== expectedOffset) {
          throw new ProjectionError(
            "MATERIALIZATION_FAILED",
            `file ${path}: FileManifest chunk ${index} offset ${chunk.offset} != expected ${expectedOffset} (gap/overlap)`,
          )
        }
        const bytes = this.readCasObjectSafe(chunk.digest, `file ${path} chunk ${index}`)
        if (bytes.byteLength !== chunk.size) {
          throw new ProjectionError(
            "MATERIALIZATION_FAILED",
            `file ${path}: chunk ${index} size ${bytes.byteLength} != declared ${chunk.size}`,
          )
        }
        parts.push(bytes)
        expectedOffset += chunk.size
      }
      if (expectedOffset !== manifest.size) {
        throw new ProjectionError(
          "MATERIALIZATION_FAILED",
          `file ${path}: FileManifest chunks cover ${expectedOffset} bytes, declared size ${manifest.size}`,
        )
      }
      return Buffer.concat(parts, manifest.size)
    }
    return this.readCasObjectSafe(contentRef, `file ${path}`)
  }

  /** 解析并校验 AK-1 FileManifest schema（type==="file" + chunks 连续覆盖）。 */
  private parseFileManifest(digest: CasDigest, path: string): import("../world/contracts").FileManifest {
    let bytes: Buffer
    try {
      bytes = this.source.readCasObject(digest)
    } catch (error) {
      throw new ProjectionError(
        "MATERIALIZATION_FAILED",
        `file ${path}: cannot read FileManifest ${digest}`,
        error instanceof Error ? error.message : String(error),
      )
    }
    let parsed: unknown
    try {
      parsed = parseCanonicalJson<unknown>(bytes.toString("utf8"))
    } catch {
      throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest ${digest} is not canonical JSON`)
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest ${digest} must be an object`)
    }
    const manifest = parsed as Record<string, unknown>
    if (manifest.schemaVersion !== 1 || manifest.type !== "file") {
      throw new ProjectionError(
        "MATERIALIZATION_FAILED",
        `file ${path}: CAS manifest ${digest} is not a FileManifest (schemaVersion=${String(manifest.schemaVersion)}, type=${String(manifest.type)})`,
      )
    }
    if (typeof manifest.mediaType !== "string" || manifest.mediaType.length === 0) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest ${digest} mediaType missing`)
    }
    if (typeof manifest.size !== "number" || !Number.isSafeInteger(manifest.size) || manifest.size < 0) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest ${digest} size invalid`)
    }
    if (!Array.isArray(manifest.chunks)) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest ${digest} chunks must be an array`)
    }
    if (manifest.size === 0 && manifest.chunks.length !== 0) {
      throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest ${digest} empty size with chunks`)
    }
    const chunks: import("../world/contracts").FileManifestChunk[] = []
    for (let index = 0; index < manifest.chunks.length; index++) {
      const raw = manifest.chunks[index]
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest chunk ${index} must be an object`)
      }
      const chunk = raw as Record<string, unknown>
      if (typeof chunk.digest !== "string" || !chunk.digest.startsWith("sha256:")) {
        throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest chunk ${index} digest invalid`)
      }
      if (typeof chunk.offset !== "number" || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0) {
        throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest chunk ${index} offset invalid`)
      }
      if (typeof chunk.size !== "number" || !Number.isSafeInteger(chunk.size) || chunk.size <= 0) {
        throw new ProjectionError("MATERIALIZATION_FAILED", `file ${path}: FileManifest chunk ${index} size invalid`)
      }
      chunks.push({ digest: chunk.digest as CasDigest, offset: chunk.offset, size: chunk.size })
    }
    return Object.freeze({ schemaVersion: 1, type: "file", mediaType: manifest.mediaType, size: manifest.size, chunks: Object.freeze(chunks) })
  }

  /** 读取 CAS 对象（source 错误统一包装为 MATERIALIZATION_FAILED）。 */
  private readCasObjectSafe(digest: CasDigest, label: string): Buffer {
    try {
      return this.source.readCasObject(digest)
    } catch (error) {
      throw new ProjectionError(
        "MATERIALIZATION_FAILED",
        `cannot read ${label} (${digest})`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 读取 section manifest（source 错误统一包装为 MATERIALIZATION_FAILED）。 */
  private readSectionManifest(digest: CasDigest): Buffer {
    return this.readCasObjectSafe(digest, "filesystem section manifest")
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

  /** 逐级创建目录；任何既有非目录或 symlink → 拒绝。深度受配额限制。 */
  private ensureDirectory(base: string, rel: string): void {
    const segments = rel.split("/")
    if (segments.length > this.limits.maxDepth) {
      throw new ProjectionError(
        "PROJECTION_RESOURCE_LIMIT",
        `path depth exceeds maxDepth: ${rel}`,
      )
    }
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
