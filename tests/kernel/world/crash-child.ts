import { WorldStore, type WorldFaultPoint } from "../../../src/kernel/world"

const scenario = process.argv[2]
const root = process.argv[3]
if (!scenario || !root) throw new Error("usage: crash-child <scenario> <world-root>")

const faultByScenario: Readonly<Record<string, WorldFaultPoint>> = {
  "world-precommit": "after_materialization_before_ledger",
  "world-ledger": "after_ledger_before_commit",
  "world-postcommit": "after_commit_before_response",
  "cas-temp": "after_cas_temp_fsync",
  "cas-rename": "after_cas_rename_before_metadata",
  "cas-metadata": "after_cas_metadata_before_return",
  "gc-file": "after_gc_file_fsync_before_metadata_commit",
  "snapshot-manifest": "after_snapshot_manifest_before_insert",
  "snapshot-insert": "after_snapshot_insert_before_commit",
}
const target = faultByScenario[scenario]
if (!target) throw new Error(`unknown crash scenario: ${scenario}`)

const store = new WorldStore(root, {
  faultInjector: point => {
    if (point === target) process.exit(86)
  },
})

if (scenario === "world-precommit" || scenario === "world-ledger") {
  const content = store.cas.put(Buffer.from("precommit crash"), "text/plain")
  store.compareAndCommit({
    worldId: "w1",
    branchId: "main",
    baseRevision: 0n,
    actor: "agent:crash",
    commitId: `commit-${scenario}`,
    mutations: [{
      type: "object.put",
      objectId: "candidate",
      objectType: "file",
      contentRef: content.digest,
    }],
  })
} else if (scenario === "world-postcommit") {
  store.compareAndCommit({
    worldId: "w1",
    branchId: "main",
    baseRevision: 0n,
    actor: "agent:crash",
    commitId: "commit-post-crash",
    mutations: [{ type: "service.set", serviceId: "indexer", status: "ready" }],
  })
} else if (scenario.startsWith("cas-")) {
  store.cas.put(Buffer.from("cas crash"), "text/plain")
} else if (scenario === "gc-file") {
  store.cas.put(Buffer.from("gc crash"), "text/plain")
  store.cas.gc()
} else {
  store.createSnapshot("w1", "main")
}

throw new Error(`fault point was not reached: ${target}`)
