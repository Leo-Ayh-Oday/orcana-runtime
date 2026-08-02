import { AsyncLocalStorage } from "node:async_hooks"
import { resolve } from "node:path"
import { FileStateLedger, type FileReadRange, type FileStateRecord } from "./file-state-ledger"
import { fingerprintContent, type FileFingerprint } from "./file-fingerprint"

export interface RuntimeFileStateContext {
  ledger: FileStateLedger
  writeGeneration: number
  unmanagedWriteObserved: boolean
}

const runtimeFileStateStorage = new AsyncLocalStorage<RuntimeFileStateContext>()

export function createRuntimeFileStateContext(
  ledger = new FileStateLedger(),
): RuntimeFileStateContext {
  return { ledger, writeGeneration: 0, unmanagedWriteObserved: false }
}

// Compatibility-only state for direct tool/unit-test calls. Production Agent
// execution always enters runWithRuntimeFileStateContext via AgentRunScope.
let legacyCompatibilityFileState = createRuntimeFileStateContext()

function getRuntimeFileStateContext(): RuntimeFileStateContext {
  return runtimeFileStateStorage.getStore() ?? legacyCompatibilityFileState
}

export function hasActiveRuntimeFileStateContext(): boolean {
  return runtimeFileStateStorage.getStore() !== undefined
}

/** [PR-2 / I-2] Monotonic per-run write-generation counter. Bumped on every agent write.
 *  Evidence entries are stamped with the generation at collection time; the
 *  completion gate compares an entry's generation against the current one to
 *  detect stale evidence (code changed since it was verified). */
export function getWriteGeneration(): number {
  return getRuntimeFileStateContext().writeGeneration
}

/** True once this run observes a write that did not advance PatchTransaction history. */
export function hasRuntimeUnmanagedWrites(): boolean {
  return getRuntimeFileStateContext().unmanagedWriteObserved
}

export function runWithRuntimeFileStateContext<T>(
  context: RuntimeFileStateContext,
  callback: () => T,
): T {
  return runtimeFileStateStorage.run(context, callback)
}

/** Advance the code-state generation for writes observed outside the managed
 * file tools (for example a shell command). A batch is one state transition;
 * callers only need freshness invalidation, not a per-file counter. */
export function recordRuntimeObservedWrites(paths: string[]): number {
  const changed = new Set(paths.map(path => resolve(path)))
  if (changed.size === 0) return getRuntimeFileStateContext().writeGeneration
  return recordRuntimeUnmanagedWrite()
}

/** Mark one unmanaged write transition even when the changed paths are unknown. */
export function recordRuntimeUnmanagedWrite(): number {
  const context = getRuntimeFileStateContext()
  context.writeGeneration++
  context.unmanagedWriteObserved = true
  return context.writeGeneration
}

export function getRuntimeFileStateLedger(): FileStateLedger {
  return getRuntimeFileStateContext().ledger
}

export function resetRuntimeFileStateLedger(ledger = new FileStateLedger()): FileStateLedger {
  const activeContext = runtimeFileStateStorage.getStore()
  if (activeContext) {
    activeContext.ledger = ledger
    activeContext.writeGeneration = 0
    activeContext.unmanagedWriteObserved = false
    return activeContext.ledger
  }

  legacyCompatibilityFileState = createRuntimeFileStateContext(ledger)
  return legacyCompatibilityFileState.ledger
}

export function recordRuntimeFileRead(input: {
  path: string
  range: FileReadRange
  content: string
  fingerprint: FileFingerprint
  totalLines?: number
  truncated?: boolean
}): FileStateRecord {
  const canonicalPath = resolve(input.path)
  return getRuntimeFileStateContext().ledger.recordRead({
    path: canonicalPath,
    range: input.range,
    content: input.content,
    totalLines: input.totalLines,
    fingerprint: input.fingerprint,
    truncated: input.truncated,
  })
}

export function recordRuntimeFileWrite(input: {
  path: string
  content: string
}): FileStateRecord {
  const canonicalPath = resolve(input.path)
  const fingerprint = fingerprintContent(input.content)
  const context = getRuntimeFileStateContext()
  context.writeGeneration++
  return context.ledger.recordAgentWrite({
    path: canonicalPath,
    content: input.content,
    fingerprint,
  })
}
