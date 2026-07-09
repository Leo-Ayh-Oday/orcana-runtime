import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"

export interface FileFingerprint {
  sha256: string
  mtimeMs: number
  size: number
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
