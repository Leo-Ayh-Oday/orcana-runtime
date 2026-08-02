/** FileHarnessStore (H6, plan §13.1).
 *
 *  Local file layout under .deepseek-code/harness/:
 *    sessions/  <sessionId>.json
 *    runs/      <runId>.json
 *    snapshots/ <runId>-<sequence>.json
 *    events/    <runId>.jsonl   (typed trace, same layout as H5)
 *
 *  Reads never crash on storage problems: missing or corrupt files return
 *  null; schema version mismatches are rejected.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { HarnessEvent } from "../contracts/events"
import type { RunSnapshot } from "../contracts/snapshot"
import { HARNESS_STORE_SCHEMA_VERSION, type HarnessStore, type SerializableRun, type SerializableSession } from "./harness-store"

export interface FileHarnessStoreInput {
  root: string
}

function readJson<T>(file: string): T | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as T & { schemaVersion?: number }
    if (parsed && typeof parsed === "object" && "schemaVersion" in (parsed as object)
      && (parsed as { schemaVersion?: number }).schemaVersion !== HARNESS_STORE_SCHEMA_VERSION) {
      return null
    }
    return parsed as T
  } catch {
    return null
  }
}

export function createFileHarnessStore(input: FileHarnessStoreInput): HarnessStore {
  const sessionsDir = join(input.root, "sessions")
  const runsDir = join(input.root, "runs")
  const snapshotsDir = join(input.root, "snapshots")
  const eventsDir = join(input.root, "events")

  const ensureDirs = () => {
    for (const dir of [sessionsDir, runsDir, snapshotsDir, eventsDir]) {
      mkdirSync(dir, { recursive: true })
    }
  }

  return {
    async saveSession(session) {
      ensureDirs()
      writeFileSync(join(sessionsDir, `${session.sessionId}.json`), JSON.stringify(session), "utf-8")
    },

    async loadSession(sessionId) {
      return readJson<SerializableSession>(join(sessionsDir, `${sessionId}.json`))
    },

    async saveRun(run) {
      ensureDirs()
      writeFileSync(join(runsDir, `${run.runId}.json`), JSON.stringify(run), "utf-8")
    },

    async loadRun(runId) {
      return readJson<SerializableRun>(join(runsDir, `${runId}.json`))
    },

    async appendEvent(event) {
      ensureDirs()
      try {
        appendFileSync(join(eventsDir, `${event.runId}.jsonl`), `${JSON.stringify(event)}\n`, "utf-8")
      } catch {
        // Trace writes never fail the run.
      }
    },

    async saveSnapshot(snapshot) {
      ensureDirs()
      writeFileSync(
        join(snapshotsDir, `${snapshot.runId}-${snapshot.sequence}.json`),
        JSON.stringify(snapshot),
        "utf-8",
      )
    },

    async loadLatestSnapshot(runId) {
      try {
        const files = readdirSync(snapshotsDir)
          .filter(f => f.startsWith(`${runId}-`) && f.endsWith(".json"))
          .sort()
        if (files.length === 0) return null
        return readJson<RunSnapshot>(join(snapshotsDir, files[files.length - 1]!))
      } catch {
        return null
      }
    },
  }
}
