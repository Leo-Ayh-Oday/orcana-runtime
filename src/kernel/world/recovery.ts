import type { WorldRecoveryReport } from "./contracts"
import { WorldCorruptionError } from "./contracts"
import { WorldStore } from "./store"

export function recoverWorldStore(store: WorldStore): WorldRecoveryReport {
  const casReport = store.cas.recover()
  const integrityIssues = store.verifyIntegrity()
  const hasCasCorruption = integrityIssues.some(issue =>
    issue.code === "CAS_MISSING_REFERENCED_OBJECT" || issue.code === "CAS_CONTENT_CORRUPT",
  )
  const corruptedWorldIds: string[] = []

  if (hasCasCorruption) {
    const detail = integrityIssues
      .filter(issue =>
        issue.code === "CAS_MISSING_REFERENCED_OBJECT" || issue.code === "CAS_CONTENT_CORRUPT",
      )
      .map(issue => issue.detail)
      .join("; ")
    for (const world of store.listWorlds()) {
      if (world.status === "corrupted") continue
      store.markCorruptedFromRecovery(world.worldId, detail)
      corruptedWorldIds.push(world.worldId)
    }
  }

  return Object.freeze({
    removedTemporaryFiles: Object.freeze([...casReport.removedTemporaryFiles]),
    removedUnreachableObjects: Object.freeze([...casReport.removedUnreachableObjects]),
    repairedRefCounts: Object.freeze([...casReport.repairedRefCounts]),
    integrityIssues: Object.freeze([...integrityIssues]),
    corruptedWorldIds: Object.freeze(corruptedWorldIds),
  })
}

export function assertWorldRecovered(report: WorldRecoveryReport): void {
  if (report.integrityIssues.length > 0) {
    throw new WorldCorruptionError(report.integrityIssues)
  }
}
