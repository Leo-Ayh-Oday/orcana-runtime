/** LR2-1v2（L2-A）验收：执行句柄 + 重启接管。 */

import { describe, test, expect } from "bun:test"
import { determineTakeover, parsePopulated, memCgroupFs, type ExecutionHandle } from "../../../src/execd/handle"
import { Recovery } from "../../../src/execd/recovery"
import { StateStore } from "../../../src/execd/state/store"

function handle(cgroupPath: string): ExecutionHandle {
  return {
    handleId: "h1",
    cellId: "cell-1",
    runId: "run-1",
    attemptId: "cell-1-a1",
    cgroupPath,
    spawnPid: 1234,
    startedAt: 1_700_000_000_000,
  }
}

describe("L2-A: determineTakeover", () => {
  test("cgroup populated=1 → RECOVERED (process tree alive)", () => {
    const fs = memCgroupFs({ "/sys/fs/cgroup/run-1/cell-1": { events: "populated 1\nfrozen 0\n" } })
    const v = determineTakeover(handle("/sys/fs/cgroup/run-1/cell-1"), fs)
    expect(v.state).toBe("RECOVERED")
  })

  test("cgroup populated=0 → EXITED", () => {
    const fs = memCgroupFs({ "/sys/fs/cgroup/run-1/cell-1": { events: "populated 0\nfrozen 0\n" } })
    const v = determineTakeover(handle("/sys/fs/cgroup/run-1/cell-1"), fs)
    expect(v.state).toBe("EXITED")
  })

  test("cgroup missing → ABSENT", () => {
    const fs = memCgroupFs({})
    const v = determineTakeover(handle("/sys/fs/cgroup/run-1/cell-1"), fs)
    expect(v.state).toBe("ABSENT")
  })

  test("cgroup.events unreadable → UNKNOWN (fail closed, keep RUNNING)", () => {
    const fs = memCgroupFs({ "/sys/fs/cgroup/run-1/cell-1": {} })
    const v = determineTakeover(handle("/sys/fs/cgroup/run-1/cell-1"), fs)
    expect(v.state).toBe("UNKNOWN")
  })

  test("parsePopulated: valid / invalid / missing", () => {
    expect(parsePopulated("populated 1\nfrozen 0\n")).toBe(true)
    expect(parsePopulated("populated 0\nfrozen 0\n")).toBe(false)
    expect(parsePopulated("frozen 0\n")).toBeUndefined()
    expect(parsePopulated(undefined)).toBeUndefined()
    expect(parsePopulated("populated 2\n")).toBeUndefined()
  })
})

describe("L2-A: Recovery takeover (RUNNING cells)", () => {
  function setupWithRunningCell(cgroupEvents: string | undefined, withHandle: boolean) {
    const state = new StateStore(":memory:")
    const at = 1_700_000_000_000
    const attemptId = "cell-1-a1"
    state.upsertCell({
      cellId: "cell-1", runId: "run-1", nodeRunId: "run-1:n1", attempt: 1,
      capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
      cwdRef: ".", timeoutMs: 5000, currentState: "RUNNING", createdAt: at, updatedAt: at,
    })
    state.upsertRun("run-1", "active", at)
    if (withHandle) {
      state.upsertExecutionHandle({
        handleId: "h1", cellId: "cell-1", runId: "run-1", attemptId,
        cgroupPath: "/sys/fs/cgroup/run-1/cell-1", spawnPid: 1234, startedAt: at,
      })
      state.transition("cell-1", attemptId, "RUNNING", { from: "ACCEPTED", reasonCode: "setup", actor: "test", at })
    }
    const events: string[] = []
    const fs = memCgroupFs(cgroupEvents !== undefined
      ? { "/sys/fs/cgroup/run-1/cell-1": { events: cgroupEvents } }
      : {})
    const recovery = new Recovery({
      state,
      probeFs: fs,
      publish: (ev: { kind: string }, seq: number) => events.push(`${ev.kind}@${seq}`),
    })
    return { state, recovery, events }
  }

  test("RUNNING + cgroup populated → RECOVERED (stays RUNNING)", () => {
    const { state, recovery } = setupWithRunningCell("populated 1\nfrozen 0\n", true)
    const report = recovery.run()
    expect(report.scanned).toBe(1)
    expect(report.recovered[0]?.to).toBe("RUNNING")
    expect(state.getCell("cell-1")?.currentState).toBe("RUNNING")
    // 句柄记录接管结果
    const h = state.listHandlesByCell("cell-1")[0]
    expect(h?.takeover).toBe("RECOVERED")
  })

  test("RUNNING + cgroup empty → EXIT_OBSERVED", () => {
    const { state, recovery } = setupWithRunningCell("populated 0\nfrozen 0\n", true)
    const report = recovery.run()
    expect(report.recovered[0]?.to).toBe("EXIT_OBSERVED")
    expect(state.getCell("cell-1")?.currentState).toBe("EXIT_OBSERVED")
  })

  test("RUNNING + cgroup absent → START_FAILED", () => {
    const { state, recovery } = setupWithRunningCell(undefined, true)
    const report = recovery.run()
    expect(report.recovered[0]?.to).toBe("START_FAILED")
    expect(state.getCell("cell-1")?.currentState).toBe("START_FAILED")
  })

  test("RUNNING without handle → LOST (v1 fallback, honest)", () => {
    const { state, recovery } = setupWithRunningCell("populated 1\nfrozen 0\n", false)
    const report = recovery.run()
    expect(report.recovered[0]?.to).toBe("LOST")
    expect(state.getCell("cell-1")?.currentState).toBe("LOST")
  })

  test("ACCEPTED/POLICY_COMPILED without handle → LOST (before cgroup)", () => {
    const state = new StateStore(":memory:")
    const at = 1_700_000_000_000
    state.upsertCell({
      cellId: "cell-2", runId: "run-2", nodeRunId: "run-2:n1", attempt: 1,
      capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
      cwdRef: ".", timeoutMs: 5000, currentState: "ACCEPTED", createdAt: at, updatedAt: at,
    })
    const recovery = new Recovery({ state, publish: () => {} })
    const report = recovery.run()
    expect(report.recovered[0]?.to).toBe("LOST")
  })

  test("RUNNING + cgroup events unreadable → stays RUNNING (UNKNOWN retry)", () => {
    const { state, recovery } = setupWithRunningCell(undefined, true)
    // 覆盖：cgroup 目录存在但 events 缺失 → UNKNOWN（不是 START_FAILED）
    const fs = memCgroupFs({ "/sys/fs/cgroup/run-1/cell-1": {} })
    const rec2 = new Recovery({ state, probeFs: fs, publish: () => {} })
    rec2.run()
    expect(state.getCell("cell-1")?.currentState).toBe("RUNNING")
  })

  test("takeover is idempotent (repeated scan same result)", () => {
    const { state, recovery } = setupWithRunningCell("populated 1\nfrozen 0\n", true)
    recovery.run()
    recovery.run()
    expect(state.getCell("cell-1")?.currentState).toBe("RUNNING")
  })
})
