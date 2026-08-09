/** LR2-1v2（L2-E）Gate 验收：7 项 execd v2 Gate。
 *
 *  EXECD_RESTART_LOSES_RUNNING_CELL   = 0（同 boot 重启可接管）
 *  CGROUP_POPULATED_UNTRACKED         = 0（活进程树必有归属）
 *  ATTACH_LOGS_TRUNCATED              = 0（大对象完整可读）
 *  EVENT_QUEUE_UNBOUNDED              = 0
 *  SLOW_CONSUMER_EVENT_LOSS           = 0
 *  UNAUTHORIZED_APPROVAL              = 0
 *  LOG_LEAK_AFTER_CLEANUP             = 0
 */

import { describe, test, expect } from "bun:test"
import { determineTakeover, parsePopulated, memCgroupFs } from "../../../src/execd/handle"
import { LogStore, memLogFs, memLogIndex } from "../../../src/execd/log-store"
import { EventStream } from "../../../src/execd/event-stream"
import { fixedApprovalTokenProvider, checkApproval } from "../../../src/execd/approval"
import { Recovery } from "../../../src/execd/recovery"
import { StateStore } from "../../../src/execd/state/store"

describe("LR2-1v2 Gates", () => {
  test("EXECD_RESTART_LOSES_RUNNING_CELL = 0: RUNNING cell recovered via cgroup probe", () => {
    const state = new StateStore(":memory:")
    const at = 1_700_000_000_000
    state.upsertCell({
      cellId: "cell-1", runId: "run-1", nodeRunId: "run-1:n1", attempt: 1,
      capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
      cwdRef: ".", timeoutMs: 5000, currentState: "RUNNING", createdAt: at, updatedAt: at,
    })
    state.upsertRun("run-1", "active", at)
    state.upsertExecutionHandle({
      handleId: "h1", cellId: "cell-1", runId: "run-1", attemptId: "cell-1-a1",
      cgroupPath: "/sys/fs/cgroup/run-1/cell-1", spawnPid: 999, startedAt: at,
    })
    state.transition("cell-1", "cell-1-a1", "RUNNING", { from: "ACCEPTED", reasonCode: "setup", actor: "test", at })
    const recovery = new Recovery({
      state,
      probeFs: memCgroupFs({ "/sys/fs/cgroup/run-1/cell-1": { events: "populated 1\n" } }),
      publish: () => {},
    })
    recovery.run()
    expect(state.getCell("cell-1")?.currentState).toBe("RUNNING")
  })

  test("CGROUP_POPULATED_UNTRACKED = 0: alive tree is always attributed (probe decides state)", () => {
    const v = determineTakeover(
      { handleId: "h", cellId: "c", runId: "r", attemptId: "a", cgroupPath: "/cg/c1", startedAt: 1 },
      memCgroupFs({ "/cg/c1": { events: "populated 1\n" } }),
    )
    expect(v.state).toBe("RECOVERED")
    const exited = determineTakeover(
      { handleId: "h", cellId: "c", runId: "r", attemptId: "a", cgroupPath: "/cg/c1", startedAt: 1 },
      memCgroupFs({ "/cg/c1": { events: "populated 0\n" } }),
    )
    expect(exited.state).toBe("EXITED")
    expect(parsePopulated("populated 1\n")).toBe(true)
    expect(parsePopulated("populated 0\n")).toBe(false)
  })

  test("ATTACH_LOGS_TRUNCATED = 0: full log readable via attach (beyond 16KB index truncation)", () => {
    const { fs, files } = memLogFs()
    const store = new LogStore({ logRoot: "/logs", fs, index: memLogIndex() })
    const big = "y".repeat(64 * 1024)
    store.append("cell-1", "stdout", big)
    const chunk = store.attach("cell-1", "stdout", 0)
    expect(chunk.data.length).toBe(64 * 1024)
    expect(chunk.eof).toBe(true)
  })

  test("EVENT_QUEUE_UNBOUNDED = 0: live queue bounded by maxQueued", () => {
    const es = new EventStream({ maxQueued: 8 })
    const sub = es.subscribe("cell-1")
    for (let i = 1; i <= 100; i++) {
      es.publish({ kind: "cell.status", cellId: "cell-1", payload: {} }, i)
    }
    expect(sub.live.length).toBeLessThanOrEqual(8)
    expect(sub.lagged).toBe(true)
  })

  test("SLOW_CONSUMER_EVENT_LOSS = 0: lagged events recoverable via resumeFromSequence", () => {
    const es = new EventStream({ maxQueued: 2 })
    const sub = es.subscribe("cell-1")
    es.publish({ kind: "cell.status", cellId: "cell-1", payload: {} }, 1)
    es.publish({ kind: "cell.status", cellId: "cell-1", payload: {} }, 2)
    es.drain(sub)
    es.acknowledge(sub, 2)
    es.publish({ kind: "cell.status", cellId: "cell-1", payload: {} }, 3)
    es.publish({ kind: "cell.status", cellId: "cell-1", payload: {} }, 4)
    es.publish({ kind: "cell.status", cellId: "cell-1", payload: {} }, 5)
    const d = es.drain(sub)
    expect(d.lagged).toBe(true)
    expect(d.resumeFromSequence).toBe(3) // 可补读起点（无丢失）
  })

  test("UNAUTHORIZED_APPROVAL = 0: no/wrong token rejected for Submit and Cancel", () => {
    const p = fixedApprovalTokenProvider(["tok"])
    expect(checkApproval(p, undefined, "SubmitCell").ok).toBe(false)
    expect(checkApproval(p, "wrong", "CancelCell").ok).toBe(false)
    expect(checkApproval(p, "tok", "SubmitCell").ok).toBe(true)
  })

  test("LOG_LEAK_AFTER_CLEANUP = 0: remove deletes files and index", () => {
    const { fs, files } = memLogFs()
    const index = memLogIndex()
    const store = new LogStore({ logRoot: "/logs", fs, index })
    store.append("cell-1", "stdout", "a")
    store.append("cell-1", "stderr", "b")
    store.remove("cell-1")
    expect([...files.keys()]).toHaveLength(0)
    expect(store.attach("cell-1", "stdout", 0).eof).toBe(true)
  })
})
