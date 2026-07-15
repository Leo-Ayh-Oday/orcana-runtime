import { describe, expect, test } from "bun:test"
import { formatToolLedgerStatus, ToolExecutionLedger } from "../src/agent/tool-ledger"
import { Result } from "../src/tools/registry"

describe("ToolExecutionLedger", () => {
  test("records successful changed files", () => {
    const ledger = new ToolExecutionLedger()
    const entry = ledger.record({
      id: "t1",
      round: 0,
      tool: "edit_file",
      startedAt: Date.now() - 5,
      result: Result.ok("edited", { path: "src/a.ts" }),
      changedFiles: ["src/a.ts", "src/a.ts"],
    })

    expect(entry.success).toBe(true)
    expect(entry.blocked).toBe(false)
    expect(entry.changedFiles).toEqual(["src/a.ts"])
    expect(ledger.changedFiles()).toEqual(["src/a.ts"])
    expect(formatToolLedgerStatus(entry)).toContain("edit_file ok")
    expect(formatToolLedgerStatus(entry)).toContain("files=1")
  })

  test("records blocked results", () => {
    const ledger = new ToolExecutionLedger()
    const entry = ledger.record({
      id: "t2",
      round: 0,
      tool: "shell",
      startedAt: Date.now(),
      result: Result.blocked("dangerous"),
    })

    expect(entry.success).toBe(false)
    expect(entry.blocked).toBe(true)
    expect(ledger.failedCount()).toBe(1)
    expect(ledger.blockedCount()).toBe(1)
    expect(formatToolLedgerStatus(entry)).toContain("shell blocked")
  })

  test("preserves structured freshness blocks in the run ledger", () => {
    const ledger = new ToolExecutionLedger()
    const entry = ledger.record({
      id: "t3",
      round: 1,
      tool: "edit_file",
      startedAt: Date.now(),
      result: {
        success: false,
        content: "[blocked] stale baseline",
        error: "stale baseline",
        metadata: {
          blocked: true,
          gate: "freshness",
          freshness: { path: "src/a.ts", status: "stale", reason: "changed" },
        },
      },
    })

    expect(entry).toMatchObject({ gate: "freshness", gateStatus: "stale" })
    expect(formatToolLedgerStatus(entry)).toContain("gate=freshness")
    expect(formatToolLedgerStatus(entry)).toContain("status=stale")
  })
})
