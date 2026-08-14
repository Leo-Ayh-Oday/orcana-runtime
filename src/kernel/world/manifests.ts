import { canonicalJson, compareCanonicalStrings, sha256Digest } from "./canonical"
import type {
  CasDigest,
  DirectoryManifest,
  DirectoryManifestEntry,
  FileManifest,
  WorldManifest,
} from "./contracts"
import { WorldCas } from "./cas"

export const DEFAULT_FILE_CHUNK_SIZE = 1024 * 1024

export interface StoredManifest<T> {
  readonly digest: CasDigest
  readonly manifest: T
}

export interface SectionManifestEntry {
  readonly id: string
  readonly kind: string
  readonly path?: string
  readonly contentRef?: CasDigest
  /** R5-07：内容表示类型的**不可变**判别子（raw | file-manifest）。
   *  由 snapshot 创建时绑定（CAS 的全局 isManifest 可被后续 promotion
   *  翻转 —— 不得用它推断文件语义；同一 snapshot 必须物化为相同 bytes）。
   *  kind === "file" 时必填；其它 kind 必须缺省。 */
  readonly representation?: "raw" | "file-manifest"
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SectionManifest {
  readonly schemaVersion: 1
  readonly type: "world-section"
  readonly section: string
  readonly entries: readonly SectionManifestEntry[]
}

function storeManifest<T>(
  cas: WorldCas,
  manifest: T,
  referencedDigests: readonly CasDigest[],
): StoredManifest<T> {
  const content = Buffer.from(canonicalJson(manifest), "utf8")
  const record = cas.putManifest(content, referencedDigests)
  return { digest: record.digest, manifest }
}

function assertManifestReferences(cas: WorldCas, digests: readonly CasDigest[]): void {
  for (const digest of new Set(digests)) {
    if (!cas.has(digest)) throw new Error(`manifest references missing CAS object: ${digest}`)
  }
}

export function createFileManifest(
  cas: WorldCas,
  content: Uint8Array,
  mediaType = "application/octet-stream",
  chunkSize = DEFAULT_FILE_CHUNK_SIZE,
): StoredManifest<FileManifest> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`invalid chunk size: ${chunkSize}`)
  }
  const bytes = Buffer.from(content)
  const chunks: FileManifest["chunks"][number][] = []
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
    const record = cas.put(chunk, "application/octet-stream")
    chunks.push({ digest: record.digest, offset, size: chunk.byteLength })
  }

  const manifest: FileManifest = Object.freeze({
    schemaVersion: 1,
    type: "file",
    mediaType,
    size: bytes.byteLength,
    chunks: Object.freeze(chunks),
  })
  return storeManifest(cas, manifest, chunks.map(chunk => chunk.digest))
}

export function createDirectoryManifest(
  cas: WorldCas,
  entries: readonly DirectoryManifestEntry[],
): StoredManifest<DirectoryManifest> {
  const sorted = [...entries].sort((left, right) =>
    compareCanonicalStrings(left.name, right.name),
  )
  const names = new Set<string>()
  for (const entry of sorted) {
    if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/]/.test(entry.name)) {
      throw new Error(`invalid directory manifest entry: ${entry.name}`)
    }
    if (names.has(entry.name)) throw new Error(`duplicate directory manifest entry: ${entry.name}`)
    names.add(entry.name)
  }
  assertManifestReferences(cas, sorted.map(entry => entry.digest))
  const manifest: DirectoryManifest = Object.freeze({
    schemaVersion: 1,
    type: "directory",
    entries: Object.freeze(sorted.map(entry => Object.freeze({ ...entry }))),
  })
  return storeManifest(cas, manifest, sorted.map(entry => entry.digest))
}

export interface ComputedSectionManifest {
  readonly digest: CasDigest
  readonly content: Buffer
  readonly references: readonly CasDigest[]
}

/** R6-07-1：纯计算 section manifest（排序 + canonical 编码 + digest；
 *  引用存在性只读校验 —— **不写 CAS**）。createSnapshot 用它先算 digest、
 *  查 existing snapshot，再决定是否物理写入（existing 命中 → 零 residue）。 */
export function computeSectionManifest(
  cas: WorldCas,
  section: string,
  entries: readonly SectionManifestEntry[],
): ComputedSectionManifest {
  const sorted = [...entries].sort((left, right) => {
    const pathOrder = compareCanonicalStrings(left.path ?? "", right.path ?? "")
    return pathOrder !== 0 ? pathOrder : compareCanonicalStrings(left.id, right.id)
  })
  const referenced = sorted
    .map(entry => entry.contentRef)
    .filter((digest): digest is CasDigest => digest !== undefined)
  assertManifestReferences(cas, referenced)
  const manifest: SectionManifest = Object.freeze({
    schemaVersion: 1,
    type: "world-section",
    section,
    entries: Object.freeze(sorted.map(entry => Object.freeze({ ...entry }))),
  })
  const content = Buffer.from(canonicalJson(manifest), "utf8")
  const digest = sha256Digest(content) as CasDigest
  return Object.freeze({ digest, content, references: Object.freeze(referenced) })
}

export function createSectionManifest(
  cas: WorldCas,
  section: string,
  entries: readonly SectionManifestEntry[],
): StoredManifest<SectionManifest> {
  const computed = computeSectionManifest(cas, section, entries)
  const record = cas.putManifest(computed.content, computed.references)
  const parsed = parseSectionManifestFromBuffer(computed.content)
  return { digest: record.digest, manifest: parsed }
}

function parseSectionManifestFromBuffer(content: Buffer): SectionManifest {
  const parsed = JSON.parse(content.toString("utf8")) as SectionManifest
  return Object.freeze({
    ...parsed,
    entries: Object.freeze(parsed.entries.map(entry => Object.freeze(entry))),
  })
}

export interface ComputedWorldManifest {
  readonly digest: CasDigest
  readonly content: Buffer
  readonly references: readonly CasDigest[]
}

/** R6-07-1：纯计算 world manifest（**不写 CAS**）。
 *  引用（各 section digest）在纯计算阶段**不要求已存在** —— section
 *  manifests 尚未写入；写入路径（createWorldManifest → putManifest）在
 *  section 写入后自行校验引用存在。 */
export function computeWorldManifest(
  _cas: WorldCas,
  manifest: WorldManifest,
): ComputedWorldManifest {
  const references = [
    manifest.filesystemDigest,
    manifest.memoryDigest,
    manifest.taskStateDigest,
    manifest.capabilityStateDigest,
    manifest.serviceStateDigest,
    manifest.artifactStateDigest,
  ]
  const frozen = Object.freeze({ ...manifest })
  const content = Buffer.from(canonicalJson(frozen), "utf8")
  const digest = sha256Digest(content) as CasDigest
  return Object.freeze({ digest, content, references: Object.freeze(references) })
}

export function createWorldManifest(
  cas: WorldCas,
  manifest: WorldManifest,
): StoredManifest<WorldManifest> {
  const computed = computeWorldManifest(cas, manifest)
  const record = cas.putManifest(computed.content, computed.references)
  return { digest: record.digest, manifest: Object.freeze({ ...manifest }) }
}
