import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { lstat, open } from "node:fs/promises"

export interface FileFingerprint {
  sha256: string
  mtimeMs: number
  size: number
}

export type FileSnapshotResult =
  | { state: "absent" | "unreadable" | "non_file" | "changed" | "too_large" | "budget_exceeded" }
  | { state: "file"; content: string; fingerprint: FileFingerprint }

export type FileTargetInfo =
  | { state: "absent" | "unreadable" | "non_file" }
  | { state: "file"; size: number }

export interface FileSnapshotOptions {
  maxBytes?: number
  signal?: AbortSignal
  byteBudget?: {
    tryReserve(bytes: number): boolean
    release(bytes: number): void
  }
}

export function fingerprintContent(content: string | Buffer, mtimeMs = 0): FileFingerprint {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8")
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    mtimeMs,
    size: buffer.length,
  }
}

export function fingerprintFile(path: string): FileFingerprint | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    return fingerprintContent(readFileSync(path), stat.mtimeMs)
  } catch {
    return null
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
}

/** Inspect a prospective freshness target before allocating its full contents. */
export async function inspectFileTarget(path: string): Promise<FileTargetInfo> {
  try {
    const stat = await lstat(path)
    return stat.isFile() ? { state: "file", size: stat.size } : { state: "non_file" }
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "unreadable" }
  }
}

/** Async full-file snapshot used by tool preflight without blocking the agent loop. */
export async function readFileSnapshot(
  path: string,
  options: FileSnapshotOptions = {},
): Promise<FileSnapshotResult> {
  options.signal?.throwIfAborted()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let reservedBytes = 0
  let retainReservation = false
  try {
    handle = await open(path, "r")
    const before = await handle.stat()
    if (!before.isFile()) return { state: "non_file" }
    if (options.maxBytes !== undefined && before.size > options.maxBytes) {
      return { state: "too_large" }
    }
    if (options.byteBudget && !options.byteBudget.tryReserve(before.size)) {
      return { state: "budget_exceeded" }
    }
    reservedBytes = before.size

    const buffer = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < buffer.length) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }

    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (!pathAfter.isFile()) return { state: "non_file" }
    if (options.maxBytes !== undefined && after.size > options.maxBytes) {
      return { state: "too_large" }
    }
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    ) {
      return { state: "changed" }
    }

    retainReservation = true
    return {
      state: "file",
      content: buffer.toString("utf-8"),
      fingerprint: fingerprintContent(buffer, after.mtimeMs),
    }
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted()
    return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "unreadable" }
  } finally {
    if (reservedBytes > 0 && !retainReservation) options.byteBudget?.release(reservedBytes)
    await handle?.close().catch(() => {})
  }
}
