/**
 * AK-2 Deterministic Delta Scanner。
 *
 * 比较 immutable lower（物化 base）与 merged view，产出确定性的
 * create/write/delete/rename delta；changed/new 内容在返回前进入 CAS。
 *
 * 不变量：
 * - 递归 lstat/readdir 无跟随语义；任何一侧出现 symlink/device/FIFO/
 *   socket 立即拒绝（DELTA_SCAN_FAILED）；
 * - manifest/delta 排序与 digest 完全 deterministic（UTF-16 code-unit
 *   path 排序；同一输入两次扫描 digest 相同）；
 * - rename 只在 deleted 与 created 之间存在唯一相同内容 digest pair 时
 *   推断；非唯一（任一侧重复）保持 delete + create；
 * - write/rename 保留既有 object identity（path → objectId 来自 base
 *   snapshot section manifest）、metadata；
 * - 新 object ID deterministic：file:<sha256hex> / dir:<sha256hex>（同内容
 *   同 id，幂等不碰撞）；
 * - 所有新内容 CAS put 后才输出 mutations（DELTA_WITHOUT_CAS = 0）；
 * - delta digest 使用与 WorldStore.compareAndCommit 相同的 canonical
 *   world-delta manifest 编码（单一 delta 格式真源）。
 */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
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
import { ProjectionError } from "./contracts"
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
}

/** deterministic digest（文件内容 / 目录子项 canonical）。 */
function fileDigest(cas: ProjectionDeltaCas, bytes: Uint8Array): CasDigest {
  const digest = sha256Digest(bytes)
  if (!cas.has(digest)) cas.put(bytes, "application/octet-stream")
  return digest
}

function directoryDigest(_cas: ProjectionDeltaCas, children: ReadonlyMap<string, ScannedNode>): CasDigest {
  const canonicalChildren = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, node]) => ({
      name,
      kind: node.kind,
      ...(node.digest === undefined ? {} : { digest: node.digest }),
    }))
  // 目录 digest 是确定性可重算的索引（用于 objectId）；不 put 进 CAS ——
  // 它没有 owner（AK-1 引用模型只认 world_objects/artifacts/snapshots/commits），
  // 入 CAS 会产生 UNREACHABLE_OBJECT_LEAK。文件内容仍必须入 CAS。
  return canonicalDigest(canonicalChildren)
}

/** 无跟随递归扫描；非法类型立即拒绝。 */
function walk(path: string, relative: string, out: Map<string, ScannedNode>): void {
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
    out.set(relative, { kind: "file", size: stat.size })
    return
  }
  if (stat.isDirectory()) {
    out.set(relative, { kind: "directory", size: 0 })
    const children = readdirSync(path)
    for (const child of children.sort()) {
      walk(join(path, child), relative.length === 0 ? child : `${relative}/${child}`, out)
    }
    return
  }
  throw new ProjectionError(
    "DELTA_SCAN_FAILED",
    `non-regular non-directory (device/FIFO/socket) found in projection view: ${relative}`,
  )
}

/** 计算文件内容 digest；目录 digest 由子项 canonical 计算。 */
function digestTree(
  base: string,
  nodes: Map<string, ScannedNode>,
  cas: ProjectionDeltaCas,
): Map<string, ScannedNode> {
  const resolved = new Map<string, ScannedNode>()
  // 文件先算（子项 digest 供目录计算）。
  const files = [...nodes.entries()].filter(([, node]) => node.kind === "file").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [relative, node] of files) {
    const bytes = readFileSync(join(base, ...relative.split("/")))
    resolved.set(relative, { kind: "file", digest: fileDigest(cas, bytes), size: node.size })
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
    resolved.set(relative, { kind: "directory", digest: directoryDigest(cas, children), size: node.size })
  }
  return resolved
}

export function scanProjectionDelta(input: ProjectionScanInput): ProjectionDeltaResult {
  const baseDir = resolve(input.baseDir)
  const mergedDir = resolve(input.mergedDir)
  if (!mergedDir.startsWith(baseDir.replace(/\/[^/]+$/, "") + sep) && false) {
    // 无约束：base 与 merged 是兄弟目录（coordinator 布局），不强制包含关系。
  }

  const baseNodes = new Map<string, ScannedNode>()
  walk(baseDir, "", baseNodes)
  const mergedNodes = new Map<string, ScannedNode>()
  walk(mergedDir, "", mergedNodes)

  // digest 计算（文件内容 + 目录子项 canonical；全部进 CAS）。
  const baseDigested = digestTree(baseDir, baseNodes, input.cas)
  const mergedDigested = digestTree(mergedDir, mergedNodes, input.cas)

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
        const objectId = baseEntry?.id ?? `obj:file:${baseNode.digest!.slice("sha256:".length)}`
        entries.push({ kind: "delete", path: relative, objectId, objectType: "file" })
        mutations.push({ type: "object.delete", objectId })
        const dirId = `obj:dir:${mergedNode.digest!.slice("sha256:".length)}`
        entries.push({ kind: "create", path: relative, objectId: dirId, objectType: "directory" })
        mutations.push({ type: "object.put", objectId: dirId, objectType: "directory", path: relative })
      } else {
        const objectId = baseEntry?.id ?? `obj:dir:${baseNode.digest!.slice("sha256:".length)}`
        entries.push({ kind: "delete", path: relative, objectId, objectType: "directory" })
        mutations.push({ type: "object.delete", objectId })
        const fileId = `obj:file:${mergedNode.digest!.slice("sha256:".length)}`
        entries.push({ kind: "create", path: relative, objectId: fileId, objectType: "file", contentRef: mergedNode.digest })
        mutations.push({ type: "object.put", objectId: fileId, objectType: "file", path: relative, contentRef: mergedNode.digest })
      }
      continue
    }

    if (baseNode && mergedNode) {
      // 两侧存在且类型相同。
      if (baseNode.kind === "file") {
        if (baseNode.digest !== mergedNode.digest) {
          const objectId = baseEntry?.id ?? `obj:file:${baseNode.digest!.slice("sha256:".length)}`
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
        const dirId = `obj:dir:${mergedNode.digest!.slice("sha256:".length)}`
        entries.push({ kind: "create", path: relative, objectId: dirId, objectType: "directory" })
        mutations.push({ type: "object.put", objectId: dirId, objectType: "directory", path: relative })
      }
      continue
    }

    // base-only → deleted。
    if (baseNode!.kind === "file") {
      deletedFiles.set(relative, baseNode!)
    } else {
      const objectId = baseEntry?.id ?? `obj:dir:${baseNode!.digest!.slice("sha256:".length)}`
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
    const objectId = baseEntry?.id ?? `obj:file:${digest.slice("sha256:".length)}`
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
    const objectId = baseEntry?.id ?? `obj:file:${node.digest!.slice("sha256:".length)}`
    entries.push({ kind: "delete", path: relative, objectId, objectType: "file" })
    mutations.push({ type: "object.delete", objectId })
  }
  for (const [relative, node] of [...createdFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (renamedNew.has(relative)) continue
    const fileId = `obj:file:${node.digest!.slice("sha256:".length)}`
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
