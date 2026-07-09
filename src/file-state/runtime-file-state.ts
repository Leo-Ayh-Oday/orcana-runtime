import { resolve } from "node:path"
import { FileStateLedger, type FileReadRange, type FileStateRecord } from "./file-state-ledger"
import { fingerprintContent, fingerprintFile } from "./file-fingerprint"

let runtimeFileStateLedger = new FileStateLedger()

export function getRuntimeFileStateLedger(): FileStateLedger {
  return runtimeFileStateLedger
}

export function resetRuntimeFileStateLedger(ledger = new FileStateLedger()): FileStateLedger {
  runtimeFileStateLedger = ledger
  return runtimeFileStateLedger
}

export function recordRuntimeFileRead(input: {
  path: string
  range: FileReadRange
  content: string
  totalLines?: number
  truncated?: boolean
}): FileStateRecord | undefined {
  const canonicalPath = resolve(input.path)
  const fingerprint = fingerprintFile(canonicalPath)
  if (!fingerprint) return undefined
  return runtimeFileStateLedger.recordRead({
    path: canonicalPath,
    range: input.range,
    content: input.content,
    totalLines: input.totalLines,
    fingerprint,
    truncated: input.truncated,
  })
}

export function recordRuntimeFileWrite(input: {
  path: string
  content: string
}): FileStateRecord {
  const canonicalPath = resolve(input.path)
  const fingerprint = fingerprintFile(canonicalPath) ?? fingerprintContent(input.content)
  return runtimeFileStateLedger.recordAgentWrite({
    path: canonicalPath,
    content: input.content,
    fingerprint,
  })
}
