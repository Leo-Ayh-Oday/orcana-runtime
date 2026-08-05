import { AsyncLocalStorage } from "node:async_hooks"
import { resolve } from "node:path"
import { FileStateLedger, type FileReadRange, type FileStateRecord } from "./file-state-ledger"
import { fingerprintContent, type FileFingerprint } from "./file-fingerprint"

export interface RuntimeFileStateContext {
  ledger: FileStateLedger
  writeGeneration: number
  unmanagedWriteObserved: boolean
  /** [command-to-file] Exact paths written outside managed tools. */
  unmanagedWritePaths: Set<string>
  /** [command-to-file] Every unmanaged write path was covered by a
   *  verification command that ran against the current disk state. */
  unmanagedWritesCovered: boolean
}

const runtimeFileStateStorage = new AsyncLocalStorage<RuntimeFileStateContext>()

export function createRuntimeFileStateContext(
  ledger = new FileStateLedger(),
): RuntimeFileStateContext {
  return {
    ledger,
    writeGeneration: 0,
    unmanagedWriteObserved: false,
    unmanagedWritePaths: new Set(),
    unmanagedWritesCovered: false,
  }
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

/** [command-to-file] Exact paths the run observed written outside the
 *  managed file tools (shell / run_process writes). */
export function getUnmanagedWritePaths(): string[] {
  return [...getRuntimeFileStateContext().unmanagedWritePaths]
}

/** [command-to-file] True when a verification command covered every
 *  unmanaged write path — the current disk state has been verified, so the
 *  transaction binding requirement can be relaxed for the completion gate. */
export function hasCoveredUnmanagedWrites(): boolean {
  const context = getRuntimeFileStateContext()
  return context.unmanagedWritesCovered && context.unmanagedWritePaths.size === 0
}

/** [command-to-file] Record the file set a passing verification command ran
 *  against. Paths it covered are removed from the unmanaged-write set; when
 *  the set becomes empty, the run's unmanaged writes are fully covered. */
export function recordVerificationCoverage(files: string[]): void {
  const context = getRuntimeFileStateContext()
  if (files.length === 0 || context.unmanagedWritePaths.size === 0) return
  for (const file of files) {
    if (!file) continue
    context.unmanagedWritePaths.delete(resolve(file))
  }
  if (context.unmanagedWritePaths.size === 0) {
    context.unmanagedWritesCovered = true
  }
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
  const context = getRuntimeFileStateContext()
  const changed = new Set(paths.map(path => resolve(path)))
  if (changed.size === 0) return context.writeGeneration
  for (const path of changed) context.unmanagedWritePaths.add(path)
  context.unmanagedWritesCovered = false
  return recordRuntimeUnmanagedWrite()
}

/** Mark one unmanaged write transition even when the changed paths are unknown. */
export function recordRuntimeUnmanagedWrite(): number {
  const context = getRuntimeFileStateContext()
  context.writeGeneration++
  context.unmanagedWriteObserved = true
  return context.writeGeneration
}

/** [SS-Next-2B] A managed rollback reverted the workspace to a prior code
 *  state. Advance the write-generation so evidence collected before the
 *  rollback fails the L2 freshness check — without marking the rollback as
 *  an unmanaged write: rollback is an exact, managed operation, so it must
 *  not poison the transaction-evidence binding (L3 stays authoritative). */
export function recordRuntimeRollback(_paths?: string[]): number {
  const context = getRuntimeFileStateContext()
  context.writeGeneration++
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
    activeContext.unmanagedWritePaths.clear()
    activeContext.unmanagedWritesCovered = false
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
