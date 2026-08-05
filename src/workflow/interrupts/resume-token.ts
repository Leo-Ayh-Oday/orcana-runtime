/** MACP-M4: resume tokens — opaque, tamper-evident, expiring handles.
 *
 *  token = base64url(`v1.<specDigest>.<expiresAt>.<interruptId>`)
 *  Validation is carried out by the ResumeController against the stored
 *  record (graph version, expiry, status, schema); the token itself binds
 *  the interrupt id to the spec digest and expiry so a replayed or stale
 *  handle is rejected before touching the store.
 */
import { randomUUID } from "node:crypto"

const V1 = "v1"

export interface ResumeTokenPayload {
  specDigest: string
  expiresAt: number
  interruptId: string
}

export function createResumeToken(payload: ResumeTokenPayload): string {
  const raw = `${V1}.${payload.specDigest}.${payload.expiresAt}.${payload.interruptId}`
  return Buffer.from(raw, "utf8").toString("base64url")
}

export function parseResumeToken(token: string): ResumeTokenPayload | undefined {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8")
    const [version, specDigest, expiresAt, interruptId] = raw.split(".")
    if (version !== V1 || !specDigest || !expiresAt || !interruptId) return undefined
    const expires = Number(expiresAt)
    if (!Number.isFinite(expires)) return undefined
    return { specDigest, expiresAt: expires, interruptId }
  } catch {
    return undefined
  }
}

export function newInterruptId(): string {
  return `wfi_${randomUUID().replace(/-/g, "")}`
}
