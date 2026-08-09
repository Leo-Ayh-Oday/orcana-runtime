import { canonicalJson, compareCanonicalStrings } from "./canonical"
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

export function createSectionManifest(
  cas: WorldCas,
  section: string,
  entries: readonly SectionManifestEntry[],
): StoredManifest<SectionManifest> {
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
  return storeManifest(cas, manifest, referenced)
}

export function createWorldManifest(
  cas: WorldCas,
  manifest: WorldManifest,
): StoredManifest<WorldManifest> {
  const references = [
    manifest.filesystemDigest,
    manifest.memoryDigest,
    manifest.taskStateDigest,
    manifest.capabilityStateDigest,
    manifest.serviceStateDigest,
    manifest.artifactStateDigest,
  ]
  assertManifestReferences(cas, references)
  const frozen = Object.freeze({ ...manifest })
  return storeManifest(cas, frozen, references)
}
