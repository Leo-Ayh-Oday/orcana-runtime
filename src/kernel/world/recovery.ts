import type { WorldRecoveryReport } from "./contracts"
import { WorldCorruptionError } from "./contracts"
import { WorldStore } from "./store"

export function recoverWorldStore(store: WorldStore): WorldRecoveryReport {
  const casReport = store.cas.recover()
  const integrityIssues = store.verifyIntegrity()
  const corruptedWorldIds: string[] = []

  const globalIssues = integrityIssues.filter(issue => issue.worldId === undefined)
  for (const world of store.listWorlds()) {
    if (world.status === "corrupted") continue
    const worldIssues = integrityIssues.filter(issue => issue.worldId === world.worldId)
    const relevant = [...globalIssues, ...worldIssues]
    if (relevant.length === 0) continue
    const detail = relevant.map(issue => `${issue.code}: ${issue.detail}`).join("; ")
    const onlyCasIssues = relevant.every(issue =>
      issue.code === "CAS_MISSING_REFERENCED_OBJECT" ||
      issue.code === "CAS_CONTENT_CORRUPT" ||
      issue.code === "CAS_REFERENCE_DIVERGENCE",
    )
    if (onlyCasIssues) store.markCorruptedFromRecovery(world.worldId, detail)
    else store.quarantineWorldFromRecovery(world.worldId, detail)
    if (store.getWorld(world.worldId)?.status === "corrupted") {
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
