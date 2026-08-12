/**
 * AK-2 Deterministic Delta Scanner。
 *
 * 比较 immutable lower（物化 base）与 merged view，产出确定性的
 * create/write/delete/rename delta；changed/new 内容在返回前进入 CAS。
 *
 * 不变量：
 * - 递归 lstat/readdir 无跟随语义；任何一侧出现 symlink/device/FIFO/
 *   socket 立即拒绝（DELTA_SCAN_FAILED）；
 * - 文件读取用 anchored no-follow traversal：open(O_NOFOLLOW) + 读取
 *   前后 fstat 验证 dev/ino/type 未变化（TOCTOU fail-closed）；
 *   文件 nlink>1（hardlink）拒绝；非法名称（反斜杠/CR/LF/无效 UTF-8/
 *   dot segment）拒绝；
 * - 深度/entry 数/单文件字节/总字节有确定性配额（PROJECTION_RESOURCE_LIMIT）；
 * - manifest/delta 排序与 digest 完全 deterministic（UTF-16 code-unit
 *   path 排序；同一输入两次扫描 digest 相同）；
 * - rename 只在 deleted 与 created 之间存在唯一相同内容 digest pair 时
 *   推断；非唯一（任一侧重复）保持 delete + create；
 * - write/rename 保留既有 object identity（path → objectId 来自 base
 *   snapshot section manifest）、metadata；
 * - 新 object ID 稳定确定且对 canonical path 唯一：
 *   obj:file:<sha256(worldId|branchId|baseRevision|kind|path)> ——
 *   CAS digest 是内容身份，objectId 是 World 对象身份（分离）；
 * - 输出 mutation 前检测重复 objectId，fail-closed（OBJECT_ID_COLLISION）；
 * - 所有新内容 CAS put 后才输出 mutations（DELTA_WITHOUT_CAS = 0）；
 * - delta digest 使用与 WorldStore.compareAndCommit 相同的 canonical
 *   world-delta manifest 编码（单一 delta 格式真源）。
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  canonicalDigest,
  canonicalJson,
  sha256Digest,
} from "../world/canonical"
import type {
  CasDigest,
  CasObjectRecord,
  WorldMutation,
} from "../world/contracts"
import { worldDeltaManifest } from "../world/contracts"
import { ProjectionError, DEFAULT_PROJECTION_LIMITS, type ProjectionLimits } from "./contracts"
import type { MaterializedSectionEntry } from "./materializer"

/** CAS 最小只读/写入边界（scanner 只消费 put/has）。 */
export interface ProjectionDeltaCas {
  readonly put: (content: Uint8Array, mediaType?: string) => CasObjectRecord
  readonly has: (digest: CasDigest) => boolean
}

export interface ProjectionScanInput {
  readonly baseDir: string
  readonly mergedDir: string
  /** path → base snapshot section entry（objectId/metadata 保留来源）。 */
  readonly baseIndex: ReadonlyMap<string, MaterializedSectionEntry>
  readonly cas: ProjectionDeltaCas
  readonly worldId: string
  readonly branchId: string
  readonly baseRevision: bigint
  /** 资源配额（默认 DEFAULT_PROJECTION_LIMITS；测试可注入更小值）。 */
  readonly limits?: ProjectionLimits
}

export type ProjectionDeltaEntry =
  | {
      readonly kind: "create"
      readonly path: string
      readonly objectId: string
      readonly objectType: "file" | "directory"
      readonly contentRef?: CasDigest
    }
  | {
      readonly kind: "write"
      readonly path: string
      readonly objectId: string
      readonly contentRef: CasDigest
    }
  | {
      readonly kind: "delete"
      readonly path: string
      readonly objectId: string
      readonly objectType: "file" | "directory"
    }
  | {
      readonly kind: "rename"
      readonly oldPath: string
      readonly newPath: string
      readonly objectId: string
      readonly contentRef: CasDigest
    }

export interface ProjectionDeltaResult {
  /** 人类可读 delta 描述（确定性排序；测试断言使用）。 */
  readonly entries: readonly ProjectionDeltaEntry[]
  /** canonical World mutations（顺序确定，可直接提交 compareAndCommit）。 */
  readonly mutations: readonly WorldMutation[]
  /** canonical world-delta manifest 的 CAS digest（与 store 计算一致）。 */
  readonly deltaDigest: CasDigest
}

interface ScannedNode {
  readonly kind: "file" | "directory"
  readonly digest?: CasDigest
  readonly size: number
  /** 身份锚（TOCTOU 复核：walk 与读取必须同 dev/ino/type）。 */
  readonly dev: number
  readonly ino: number
  readonly nlink: number
}

/** deterministic digest（文件内容 / 目录子项 canonical）。 */
function fileDigest(cas: ProjectionDeltaCas, bytes: Uint8Array): CasDigest {
  const digest = sha256Digest(bytes)
  if (!cas.has(digest)) cas.put(bytes, "application/octet-stream")
  return digest
}

/** 新对象 ID：稳定、确定、对 canonical path 唯一（R02）。输入含
 *  world/branch + base revision（snapshot identity）+ kind + canonical
 *  path —— 同内容不同路径不会碰撞；同路径在后续 revision 的 create
 *  因 revision 不同而不同（路径身份绑定到该 base）。 */
export function deriveObjectId(
  worldId: string,
  branchId: string,
  baseRevision: bigint,
  kind: "file" | "directory",
  path: string,
): string {
  const seed = canonicalJson({
    worldId,
    branchId,
    baseRevision: baseRevision.toString(),
    kind,
    path,
  })
  const hex = sha256Digest(Buffer.from(seed, "utf8")).slice("sha256:".length)
  return kind === "file" ? `obj:file:${hex}` : `obj:dir:${hex}`
}

/** 目录内容身份（deterministic 可重算索引；不 put 进 CAS —— 无 owner
 *  会 UNREACHABLE_OBJECT_LEAK。objectId 由 deriveObjectId 派生，与目录
 *  digest 分离）。 */
function directoryDigest(_cas: ProjectionDeltaCas, children: ReadonlyMap<string, ScannedNode>): CasDigest {
  const canonicalChildren = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, node]) => ({
      name,
      kind: node.kind,
      ...(node.digest === undefined ? {} : { digest: node.digest }),
    }))
  return canonicalDigest(canonicalChildren)
}

/** 名称卫生（R05.7）：拒绝反斜杠/CR/LF/无效 UTF-8/dot segment。 */
function assertSafeEntryName(name: string, relative: string): void {
  if (name.length === 0) {
    throw new ProjectionError("DELTA_SCAN_FAILED", `empty entry name in ${relative}`)
  }
  if (name === "." || name === "..") {
    throw new ProjectionError("DELTA_SCAN_FAILED", `dot segment entry in ${relative}`)
  }
  if (name.includes("\\")) {
    throw new ProjectionError("DELTA_SCAN_FAILED", `backslash entry name in ${relative}`)
  }
  if (/[\r\n]/.test(name)) {
    throw new ProjectionError("DELTA_SCAN_FAILED", `CR/LF entry name in ${relative}`)
  }
  if (name.includes("\0")) {
    throw new ProjectionError("DELTA_SCAN_FAILED", `NUL entry name in ${relative}`)
  }
  if (!isValidUtf8(name) || name.includes("\uFFFD")) {
    // U+FFFD：readdir 字符串解码失真的信号（原始字节含非法 UTF-8 序列）。
    // fail-closed —— 字面含 U+FFFD 的文件名同样拒绝（极罕见，宁可误拒）。
    throw new ProjectionError("DELTA_SCAN_FAILED", `invalid UTF-8 entry name in ${relative}`)
  }
}

/** 严格 UTF-8 验证（bun 无 Buffer.isUtf8；fatal decoder 抛错即非法）。 */
function isValidUtf8(value: string): boolean {
  return isValidUtf8Bytes(Buffer.from(value, "utf8"))
}

/** 原始字节层 UTF-8 验证（readdir buffer 模式；locale 无关）。 */
function isValidUtf8Bytes(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** 无跟随递归扫描；非法类型/名称/配额立即拒绝。
 *  limits 注入（默认 DEFAULT_PROJECTION_LIMITS）。 */
function walk(
  path: string,
  relative: string,
  out: Map<string, ScannedNode>,
  limits: ProjectionLimits,
): void {
  if (out.size > limits.maxEntries) {
    throw new ProjectionError(
      "PROJECTION_RESOURCE_LIMIT",
      `entry count exceeds maxEntries (${out.size} > ${limits.maxEntries})`,
    )
  }
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    throw new ProjectionError(
      "DELTA_SCAN_FAILED",
      `cannot lstat ${relative}`,
      error instanceof Error ? error.message : String(error),
    )
  }
  if (stat.isSymbolicLink()) {
    throw new ProjectionError("DELTA_SCAN_FAILED", `symlink found in projection view: ${relative}`)
  }
  if (stat.isFile()) {
    if (stat.nlink > 1) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `hardlink (nlink=${stat.nlink}) found in projection view: ${relative}`)
    }
    if (stat.size > limits.maxFileBytes) {
      throw new ProjectionError(
        "PROJECTION_RESOURCE_LIMIT",
        `file ${relative} exceeds maxFileBytes (${stat.size} > ${limits.maxFileBytes})`,
      )
    }
    out.set(relative, { kind: "file", size: stat.size, dev: stat.dev, ino: stat.ino, nlink: stat.nlink })
    return
  }
  if (stat.isDirectory()) {
    const depth = relative.length === 0 ? 0 : relative.split("/").length
    if (depth >= limits.maxDepth) {
      throw new ProjectionError(
        "PROJECTION_RESOURCE_LIMIT",
        `tree depth exceeds maxDepth at ${relative}`,
      )
    }
    out.set(relative, { kind: "directory", size: 0, dev: stat.dev, ino: stat.ino, nlink: stat.nlink })
    // readdir 原始字节模式：UTF-8 有效性在字节层验证（locale 无关 ——
    // 字符串模式会把非法字节替换为 U+FFFD，检测不可靠）。
    const children = readdirSync(path, { encoding: "buffer" }) as Buffer[]
    const names = children.map(raw => {
      const bytes = Buffer.from(raw)
      if (!isValidUtf8Bytes(bytes)) {
        throw new ProjectionError("DELTA_SCAN_FAILED", `invalid UTF-8 entry name in ${relative}`)
      }
      return bytes.toString("utf8")
    })
    for (const child of names.sort()) {
      assertSafeEntryName(child, relative.length === 0 ? child : `${relative}/${child}`)
      walk(join(path, child), relative.length === 0 ? child : `${relative}/${child}`, out, limits)
    }
    return
  }
  throw new ProjectionError(
    "DELTA_SCAN_FAILED",
    `non-regular non-directory (device/FIFO/socket) found in projection view: ${relative}`,
  )
}

/** 计算文件内容 digest；目录 digest 由子项 canonical 计算。
 *  文件读取使用 anchored no-follow traversal：open(O_NOFOLLOW) + 读取
 *  前后 fstat 验证 dev/ino/type 与 walk 记录一致（TOCTOU fail-closed）；
 *  总字节受 maxTreeBytes 配额限制。 */
function digestTree(
  base: string,
  nodes: Map<string, ScannedNode>,
  cas: ProjectionDeltaCas,
  limits: ProjectionLimits,
): Map<string, ScannedNode> {
  const resolved = new Map<string, ScannedNode>()
  // 文件先算（子项 digest 供目录计算）。
  const files = [...nodes.entries()].filter(([, node]) => node.kind === "file").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  let treeBytes = 0
  for (const [relative, node] of files) {
    const full = join(base, ...relative.split("/"))
    const fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      // 读取前复核：与 walk 记录的 dev/ino/type 一致（文件 swap / 目录替换）。
      const before = fstatSync(fd)
      if (!before.isFile()) {
        throw new ProjectionError("DELTA_SCAN_FAILED", `entry type changed during scan: ${relative}`)
      }
      if (before.dev !== node.dev || before.ino !== node.ino) {
        throw new ProjectionError("DELTA_SCAN_FAILED", `entry identity changed during scan: ${relative}`)
      }
      const bytes = readFileSync(fd)
      // 读取后复核：身份再次验证（swap-back 防护）。
      const after = fstatSync(fd)
      if (!after.isFile() || after.dev !== node.dev || after.ino !== node.ino) {
        throw new ProjectionError("DELTA_SCAN_FAILED", `entry identity changed during read: ${relative}`)
      }
      if (bytes.byteLength !== node.size) {
        throw new ProjectionError("DELTA_SCAN_FAILED", `file size changed during scan: ${relative}`)
      }
      treeBytes += bytes.byteLength
      if (treeBytes > limits.maxTreeBytes) {
        throw new ProjectionError(
          "PROJECTION_RESOURCE_LIMIT",
          `scanned tree exceeds maxTreeBytes (${treeBytes} > ${limits.maxTreeBytes})`,
        )
      }
      resolved.set(relative, { kind: "file", digest: fileDigest(cas, bytes), size: node.size, dev: node.dev, ino: node.ino, nlink: node.nlink })
    } finally {
      closeSync(fd)
    }
  }
  // 目录按深度倒序（子目录 digest 就绪）。
  const dirs = [...nodes.entries()]
    .filter(([, node]) => node.kind === "directory")
    .sort(([a], [b]) => (a.split("/").length - b.split("/").length) * 1000 + (a < b ? -1 : a > b ? 1 : 0))
  for (const [relative, node] of dirs) {
    const children = new Map<string, ScannedNode>()
    const prefix = relative.length === 0 ? "" : `${relative}/`
    for (const [childRelative, childNode] of resolved) {
      if (prefix.length === 0 || childRelative.startsWith(prefix)) {
        const name = childRelative.slice(prefix.length)
        if (!name.includes("/")) children.set(name, childNode)
      }
    }
    resolved.set(relative, { kind: "directory", digest: directoryDigest(cas, children), size: node.size, dev: node.dev, ino: node.ino, nlink: node.nlink })
  }
  return resolved
}

export function scanProjectionDelta(input: ProjectionScanInput): ProjectionDeltaResult {
  const limits = input.limits ?? DEFAULT_PROJECTION_LIMITS
  const baseNodes = new Map<string, ScannedNode>()
  walk(input.baseDir, "", baseNodes, limits)
  const mergedNodes = new Map<string, ScannedNode>()
  walk(input.mergedDir, "", mergedNodes, limits)

  // digest 计算（文件内容 + 目录子项 canonical；全部进 CAS）。
  const baseDigested = digestTree(input.baseDir, baseNodes, input.cas, limits)
  const mergedDigested = digestTree(input.mergedDir, mergedNodes, input.cas, limits)

  const baseFiles = new Map<string, ScannedNode>()
  const baseDirs = new Set<string>()
  for (const [relative, node] of baseDigested) {
    if (relative.length === 0) continue
    if (node.kind === "file") baseFiles.set(relative, node)
    else baseDirs.add(relative)
  }
  const mergedFiles = new Map<string, ScannedNode>()
  const mergedDirs = new Set<string>()
  for (const [relative, node] of mergedDigested) {
    if (relative.length === 0) continue
    if (node.kind === "file") mergedFiles.set(relative, node)
    else mergedDirs.add(relative)
  }

  const allPaths = new Set([...baseFiles.keys(), ...baseDirs, ...mergedFiles.keys(), ...mergedDirs])
  const entries: ProjectionDeltaEntry[] = []
  const mutations: WorldMutation[] = []

  const deletedFiles = new Map<string, ScannedNode>()
  const createdFiles = new Map<string, ScannedNode>()

  // 逐 path 分类（确定性排序）。
  for (const relative of [...allPaths].sort()) {
    const baseNode = baseDigested.get(relative)
    const mergedNode = mergedDigested.get(relative)
    const baseEntry = input.baseIndex.get(relative)

    if (baseNode && mergedNode && baseNode.kind !== mergedNode.kind) {
      // file ↔ directory 冲突：delete 旧 + create 新。
      if (baseNode.kind === "file" && mergedNode.kind === "directory") {
        const objectId = baseEntry?.id ?? deriveObjectId(input.worldId, input.branchId, input.baseRevision, "file", relative)
        entries.push({ kind: "delete", path: relative, objectId, objectType: "file" })
        mutations.push({ type: "object.delete", objectId })
        const dirId = deriveObjectId(input.worldId, input.branchId, input.baseRevision, "directory", relative)
        entries.push({ kind: "create", path: relative, objectId: dirId, objectType: "directory" })
        mutations.push({ type: "object.put", objectId: dirId, objectType: "directory", path: relative })
      } else {
        const objectId = baseEntry?.id ?? deriveObjectId(input.worldId, input.branchId, input.baseRevision, "directory", relative)
        entries.push({ kind: "delete", path: relative, objectId, objectType: "directory" })
        mutations.push({ type: "object.delete", objectId })
        const fileId = deriveObjectId(input.worldId, input.branchId, input.baseRevision, "file", relative)
        entries.push({ kind: "create", path: relative, objectId: fileId, objectType: "file", contentRef: mergedNode.digest })
        mutations.push({ type: "object.put", objectId: fileId, objectType: "file", path: relative, contentRef: mergedNode.digest })
      }
      continue
    }

    if (baseNode && mergedNode) {
      // 两侧存在且类型相同。
      if (baseNode.kind === "file") {
        if (baseNode.digest !== mergedNode.digest) {
          const objectId = baseEntry?.id ?? deriveObjectId(input.worldId, input.branchId, input.baseRevision, "file", relative)
          entries.push({ kind: "write", path: relative, objectId, contentRef: mergedNode.digest! })
          mutations.push({
            type: "object.put",
            objectId,
            objectType: "file",
            path: relative,
            contentRef: mergedNode.digest,
            ...(baseEntry?.metadata === undefined ? {} : { metadata: baseEntry.metadata }),
          })
        }
      }
      continue
    }

    if (mergedNode) {
      // created。
      if (mergedNode.kind === "file") {
        createdFiles.set(relative, mergedNode)
      } else {
        const dirId = deriveObjectId(input.worldId, input.branchId, input.baseRevision, "directory", relative)
        entries.push({ kind: "create", path: relative, objectId: dirId, objectType: "directory" })
        mutations.push({ type: "object.put", objectId: dirId, objectType: "directory", path: relative })
      }
      continue
    }

    // base-only → deleted。
    if (baseNode!.kind === "file") {
      deletedFiles.set(relative, baseNode!)
    } else {
      const objectId = baseEntry?.id ?? deriveObjectId(input.worldId, input.branchId, input.baseRevision, "directory", relative)
      entries.push({ kind: "delete", path: relative, objectId, objectType: "directory" })
      mutations.push({ type: "object.delete", objectId })
    }
  }

  // rename 推断：deleted ↔ created 唯一同 digest pair。
  const deletedByDigest = new Map<string, string[]>()
  for (const [relative, node] of deletedFiles) {
    const key = node.digest!
    const list = deletedByDigest.get(key) ?? []
    list.push(relative)
    deletedByDigest.set(key, list)
  }
  const createdByDigest = new Map<string, string[]>()
  for (const [relative, node] of createdFiles) {
    const key = node.digest!
    const list = createdByDigest.get(key) ?? []
    list.push(relative)
    createdByDigest.set(key, list)
  }
  const renamedOld = new Set<string>()
  const renamedNew = new Set<string>()
  for (const [digest, olds] of deletedByDigest) {
    if (olds.length !== 1) continue // 非唯一 → delete+create
    const news = createdByDigest.get(digest)
    if (!news || news.length !== 1) continue // 非唯一 → delete+create
    const oldPath = olds[0]!
    const newPath = news[0]!
    const baseEntry = input.baseIndex.get(oldPath)
    const objectId = baseEntry?.id ?? deriveObjectId(input.worldId, input.branchId, input.baseRevision, "file", oldPath)
    const digestRef = digest as CasDigest
    entries.push({ kind: "rename", oldPath, newPath, objectId, contentRef: digestRef })
    mutations.push({
      type: "object.put",
      objectId,
      objectType: "file",
      path: newPath,
      contentRef: digestRef,
      ...(baseEntry?.metadata === undefined ? {} : { metadata: baseEntry.metadata }),
    })
    renamedOld.add(oldPath)
    renamedNew.add(newPath)
  }

  // 未 rename 的 deleted/created → delete + create mutations。
  for (const [relative, node] of [...deletedFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (renamedOld.has(relative)) continue
    const baseEntry = input.baseIndex.get(relative)
    const objectId = baseEntry?.id ?? deriveObjectId(input.worldId, input.branchId, input.baseRevision, "file", relative)
    entries.push({ kind: "delete", path: relative, objectId, objectType: "file" })
    mutations.push({ type: "object.delete", objectId })
  }
  for (const [relative, node] of [...createdFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (renamedNew.has(relative)) continue
    const fileId = deriveObjectId(input.worldId, input.branchId, input.baseRevision, "file", relative)
    entries.push({ kind: "create", path: relative, objectId: fileId, objectType: "file", contentRef: node.digest })
    mutations.push({
      type: "object.put",
      objectId: fileId,
      objectType: "file",
      path: relative,
      contentRef: node.digest,
    })
  }

  if (mutations.length === 0) {
    throw new ProjectionError("DELTA_SCAN_FAILED", "projection delta is empty: no world mutation")
  }

  // 重复 objectId 检测（R02.5）：同一 objectId 出现在多个不同 canonical
  // path 的 put/delete 中 → fail-closed（WorldStore UPSERT 会静默覆盖，
  // 绝不允许 scanner 输出这种 mutation 序列）。
  {
    const idToPaths = new Map<string, string[]>()
    for (const mutation of mutations) {
      if (mutation.type === "object.put" || mutation.type === "object.delete") {
        const list = idToPaths.get(mutation.objectId) ?? []
        if (mutation.type === "object.put") {
          if (!list.includes(mutation.path ?? "")) list.push(mutation.path ?? "")
        } else {
          list.push(`<delete>`)
        }
        idToPaths.set(mutation.objectId, list)
      }
    }
    for (const [objectId, paths] of idToPaths) {
      const unique = [...new Set(paths)]
      if (unique.length > 1) {
        throw new ProjectionError(
          "OBJECT_ID_COLLISION",
          `objectId ${objectId} would collide across paths: ${unique.join(", ")}`,
        )
      }
    }
  }

  const deltaDigest = sha256Digest(
    Buffer.from(
      canonicalJson(worldDeltaManifest(input.worldId, input.branchId, input.baseRevision, mutations)),
      "utf8",
    ),
  )
  return Object.freeze({
    entries: Object.freeze(entries.map(entry => Object.freeze(entry))),
    mutations: Object.freeze(mutations.map(mutation => Object.freeze(mutation))),
    deltaDigest,
  })
}
