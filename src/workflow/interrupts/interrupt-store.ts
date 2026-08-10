/** MACP-M4: interrupt store — durable records under
 *  `<projectRoot>/.orcana/workflow/interrupts/<interruptId>.json`.
 *  Records survive process exit (PROCESS_BOUND_WAITING: 0) and can be
 *  re-read after restart. */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { WorkflowInterruptRecord, WorkflowInterruptStatus } from "./types"

export class InterruptStore {
  constructor(private readonly dir: string) {}

  private file(interruptId: string): string {
    return join(this.dir, `${interruptId}.json`)
  }

  /** Persist a record (create or update). */
  put(record: WorkflowInterruptRecord): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(record.interruptId), JSON.stringify(record, null, 2), "utf8")
  }

  get(interruptId: string): WorkflowInterruptRecord | undefined {
    const file = this.file(interruptId)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, "utf8")) as WorkflowInterruptRecord
    } catch {
      return undefined
    }
  }

  /** All records with the given status (default: waiting). */
  list(status?: WorkflowInterruptStatus): WorkflowInterruptRecord[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as WorkflowInterruptRecord
        } catch {
          return undefined
        }
      })
      .filter((r): r is WorkflowInterruptRecord => r !== undefined)
      .filter(r => status === undefined || r.status === status)
  }

  /** M10: atomically consume a waiting record (waiting → resuming). The
   *  read-check-write runs entirely synchronously — a concurrent resume()
   *  in the same process observes "resuming" and fails. Returns the
   *  consumed record, or undefined when the record is absent or already
   *  consumed/resolved/cancelled (DOUBLE_RESUME: 0). */
  consume(interruptId: string): WorkflowInterruptRecord | undefined {
    const record = this.get(interruptId)
    if (!record) return undefined
    if (record.status !== "waiting") return undefined
    const next: WorkflowInterruptRecord = { ...record, status: "resuming" }
    this.put(next)
    return next
  }

  update(interruptId: string, patch: Partial<WorkflowInterruptRecord>): WorkflowInterruptRecord | undefined {
    const record = this.get(interruptId)
    if (!record) return undefined
    const next = { ...record, ...patch }
    this.put(next)
    return next
  }

  remove(interruptId: string): void {
    const file = this.file(interruptId)
    if (existsSync(file)) rmSync(file, { force: true })
  }
}
