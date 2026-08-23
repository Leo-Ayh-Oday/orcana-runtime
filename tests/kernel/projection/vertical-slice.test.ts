/** AK2-T07 — 纵向 Slice：revision 0 World → snapshot → projection →
 *  Linux execution → delta → commit revision 1 → 新 snapshot → integrity。
 *
 * A 层：deterministic backend（fixture）验证 coordinator/delta/commit 逻辑。
 * B 层：当前 WSL 真实 fuse-overlayfs + 真实 broker 执行 lane。
 * B 层不可用时标记 ENV_BLOCKED，不用 fixture 冒充通过。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import { CopyProjectionFixtureBackend, TestProjectionCoordinator, TestReceiptAuthority } from "./test-fixtures"
import {
  FuseOverlayfsProjectionBackend,
  probeNativeBackends,
} from "../../../src/kernel/projection/backend"
import { LinuxBrokerProjectionExecutor } from "../../../src/kernel/projection/broker-adapter"
import { validateWorldProjectionPlan } from "../../../src/kernel/projection/plan"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { RuntimeStateStore } from "../../../src/runtime/linux/recovery/state-store"
import { RuntimeStateReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
import { WorkspaceAuthorityRegistry } from "../../../src/runtime/linux/workspace/workspace-authority"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-slice-${label}-`))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      void error // 基线约定：best-effort 清理/预期失败，显式吞掉
      // 已删
    }
  })
  return dir
}

/** 完整纵向链（共享给 A/B 两层）。 */
async function runVerticalSlice(
  backend: CopyProjectionFixtureBackend | FuseOverlayfsProjectionBackend,
  executor: import("../../../src/kernel/projection/coordinator").ProjectionExecutor | ((authority: TestReceiptAuthority) => import("../../../src/kernel/projection/coordinator").ProjectionExecutor),
  receiptAuthority?: import("../../../src/kernel/projection/receipt-authority").ProjectionReceiptAuthority,
): Promise<{ ctx: TestWorldStore; revision: bigint; newContent: string; commitError?: unknown }> {
  // R5-01：A 层 executor 与 coordinator 必须共享同一 test authority。
  const testAuthority = receiptAuthority === undefined ? new TestReceiptAuthority() : undefined
  const effectiveExecutor = typeof executor === "function" && testAuthority !== undefined
    ? (executor as (a: TestReceiptAuthority) => import("../../../src/kernel/projection/coordinator").ProjectionExecutor)(testAuthority)
    : executor as import("../../../src/kernel/projection/coordinator").ProjectionExecutor
  const ctx = createTestWorldStore()
  ctx.store.createWorld({
    worldId: "world-v",
    branchId: "branch-main",
    rootObjectId: "root-1",
    owner: "owner:test",
    purpose: "ak2 vertical slice",
  })
  // 1. revision 0 World；2. TypeScript 文件。
  const original = "export const answer = 1\n"
  const originalDigest = ctx.store.cas.put(Buffer.from(original, "utf8"), "text/plain").digest
  ctx.store.compareAndCommit({
    worldId: "world-v",
    branchId: "branch-main",
    baseRevision: 0n,
    actor: "actor:test",
    mutations: [
      { type: "object.put", objectId: "obj-src", objectType: "directory", path: "src" },
      { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: originalDigest },
      { type: "object.put", objectId: "obj-docs", objectType: "directory", path: "docs" },
    ],
  })
  // 3. immutable snapshot（revision 1）。
  ctx.store.createSnapshot("world-v", "branch-main")
  const snapshot = ctx.store.snapshots.getForRevision("world-v", "branch-main", 1n)!

  const materializer = new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
  const coord = new TestProjectionCoordinator({
    store: ctx.store,
    materializer,
    // R7-01：test-only composition（tests/** 子类）提供 commit 授权。
    backend: backend as unknown as import("../../../src/kernel/projection/backend").NativeProjectionBackend,
    projectionRoot: tmpRoot("proj"),
    // R5-01：所有 backend 都要求 receipt authority —— A 层 fixture 用
    // TestReceiptAuthority（test-only）；B 层用 RuntimeStateReceiptAuthority。
    receiptAuthority: receiptAuthority ?? testAuthority!,
    // R7-03：durable reservation path 是必填 kernel 配置（测试用 per-test 路径）。
    intentReservationPath: join(tmpRoot("res"), "res.sqlite"),
  })
  // 4. native projection。
  const plan = validateWorldProjectionPlan({
    projectionId: `proj-vertical-${Math.random().toString(36).slice(2, 8)}`,
    worldId: "world-v",
    branchId: "branch-main",
    snapshotId: snapshot.snapshotId,
    actor: "actor:test",
    mode: "native",
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    expectedOutputs: ["src/main.ts"],
    graphCompletionAllowed: false,
  })
  const session = coord.start(plan)
  // projection 环境无 WorldDB/CAS authority 路径。
  expect(existsSync(join(session.mergedDir, "world.db"))).toBe(false)
  expect(existsSync(join(session.mergedDir, "cas"))).toBe(false)
  expect(readFileSync(join(session.mergedDir, "src/main.ts"), "utf8")).toBe(original)

  // 5. Linux execution 修改文件（executor 注入：B 层为真实 broker）。
  const newContent = "export const answer = 42\n"
  const outcome = await coord.execute(session, { executable: "noop", args: [] }, effectiveExecutor)
  expect(outcome.exitCode).toBe(0)
  expect(session.executionState).toBe("COMPLETED")

  // 6. deterministic delta。production lane（backend.kind !== "fixture"）：
  // finalized receipt/cleanup proof 缺失 → scan 即 fail-closed（ENV_BLOCKED
  // 语义前移到 scan —— 执行 writer 未证明终止不得扫描）。
  let delta: import("../../../src/kernel/projection/scanner").ProjectionDeltaResult | undefined
  let scanError: unknown
  void delta
  try {
    delta = coord.scan(session)
  } catch (error) {
    scanError = error
  }
  if (scanError !== undefined) {
    const code = (scanError as { code?: string }).code ?? ""
    if (/^EXECUTION_RECEIPT_(NOT_PERSISTED|NOT_FINALIZED|REQUIRED)$/.test(code)) {
      return { revision: 0n, newContent: "", ctx, commitError: scanError }
    }
    throw scanError
  }
  expect(delta!.entries).toContainEqual(expect.objectContaining({ kind: "write", path: "src/main.ts" }))

  // 7. validator 已内置于 commit（writes/expected output 验证）。
  // 8. World commit → revision 1（新 revision = 2）。
  let commitError: unknown
  let receipt
  try {
    receipt = coord.commit(session)
  } catch (error) {
    commitError = error
  }
  if (commitError !== undefined) {
    // R2-03/R3-15：只有明确「cleanup proof 不可得」类错误（receipt 未持久化
    // /未 finalized —— 本机 bwrap 无 cgroup 委托）才归类 ENV_BLOCKED
    // （fail-closed 拒绝）。任意未知 commit error 必须失败（重新抛出），
    // 不得宽泛归类 ENV_BLOCKED。
    const code = (commitError as { code?: string }).code ?? ""
    if (!/^EXECUTION_RECEIPT_(NOT_PERSISTED|NOT_FINALIZED|REQUIRED)$/.test(code)) {
      throw commitError
    }
    return { revision: 0n, newContent: "", ctx, commitError }
  }
  expect(session.worldState).toBe("COMMITTED")
  expect(receipt!.newRevision).toBe(2n)
  expect(ctx.store.getWorld("world-v")!.currentRevision).toBe(2n)

  // 9. WorldCommitReceipt。
  expect(session.receipt!.worldCommitReceipt!.deltaDigest).toBe(delta!.deltaDigest)
  expect(session.receipt!.effectState).toBe("NONE")
  expect(session.receipt!.evidenceState).toBe("PENDING")
  expect(session.receipt!.executionState).toBe("COMPLETED")

  // 10-11. 新 snapshot + 新内容 + CAS roots + integrity。
  const snapshot2 = ctx.store.createSnapshot("world-v", "branch-main")
  expect(snapshot2.revision).toBe(2n)
  const base2 = join(tmpRoot("rev2"), "base")
  mkdirSync(base2)
  new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  }).materialize(snapshot2.snapshotId, base2)
  expect(readFileSync(join(base2, "src/main.ts"), "utf8")).toBe(newContent)
  expect(ctx.store.verifyIntegrity()).toEqual([])
  expect(ctx.store.cas.has(snapshot2.manifestDigest)).toBe(true)

  // 12. Graph completion 未触发（receipt 无任何 completion 字段）。
  expect("graphCompleted" in session.receipt!).toBe(false)
  expect("completion" in session.receipt!).toBe(false)
  return { ctx, revision: receipt!.newRevision, newContent }
}

/** A 层 executor factory：直接写 merged（deterministic fixture 逻辑验证）。
 *  R5-01：fixture 执行也必须产出 receipt —— 与 coordinator 共享 authority。 */
function aLayerExecutor(mutate: (cwd: string) => void) {
  return (authority: TestReceiptAuthority) =>
    (require("./test-fixtures") as typeof import("./test-fixtures")).fixtureExecutor(authority, mutate)
}

/** B 层 executor：真实 Linux Broker —— 真实能力探测 + bubblewrap strict
 *  lane（R01.4：host-audit 不能作为 AK-2 安全边界；本机已验证
 *  bwrap unprivilegedUsable）。 */
function brokerExecutorFactory(merged: string, stateStore?: RuntimeStateStore) {
  const store = stateStore ?? new RuntimeStateStore({ root: join(tmpdir(), `ak2-slice-state-${process.pid}-${Math.random().toString(36).slice(2, 8)}`) })
  const broker = createLinuxBroker({ mode: "enabled", stateStore: store })
  const registry = new WorkspaceAuthorityRegistry()
  const workspace = registry.registerAgentWorktree({
    projectId: "ak2-slice",
    hostRoot: merged,
    access: "readwrite",
    // R4-03 投影契约：ownerFiles 必须等于 writable roots（pathguard
    // owned 范围 + filesystemPolicyDigest 派生前提）。
    ownerFiles: ["src"],
  })
  const executor = new LinuxBrokerProjectionExecutor({
    broker,
    authority: { identity: { runId: `run-${process.pid}`, nodeRunId: `run-${process.pid}:n1`, attempt: 1 }, workspace },
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    profile: "build",
    receiptAuthority: new RuntimeStateReceiptAuthority(store),
  })
  return executor
}

describe("AK2-T07 A 层：deterministic backend 纵向链", () => {
  test("12 步全链（fixture backend）", async () => {
    const result = await runVerticalSlice(
      new CopyProjectionFixtureBackend(),
      aLayerExecutor(cwd => writeFileSync(join(cwd, "src/main.ts"), "export const answer = 42\n")),
    )
    expect(result.revision).toBe(2n)
    expect(result.newContent).toBe("export const answer = 42\n")
    result.ctx.cleanup()
  })
})

describe("AK2-T07 B 层：真实 fuse-overlayfs + Linux execution lane", () => {
  const probe = probeNativeBackends()
  const realBackendAvailable = probe.fuseOverlayfs

  test("环境探测记录（ENV_BLOCKED 判定依据）", () => {
    expect(realBackendAvailable).toBe(true) // 本机 fuse-overlayfs 3.14 已装
  })

  test(
    "fuse-overlayfs 挂载 + 真实 broker 执行（ENV_BLOCKED: cleanup proof 不可得 → World commit 拒绝）",
    async () => {
      if (!realBackendAvailable) {
        console.log("ENV_BLOCKED: fuse-overlayfs unavailable; B-lane skipped (not a pass)")
        return
      }
      const stateStore = new RuntimeStateStore({ root: join(tmpdir(), `ak2-slice-bstate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`) })
      // R2-03：本机 bwrap 无 cgroup 委托 → cleanup proof 不可得 → 真实 lane
      // ENV_BLOCKED（fail-closed：World commit 必须被拒绝）。真实 overlay
      // 物化/执行/隔离仍全部真实执行并断言。
      const result = await runVerticalSlice(
        new FuseOverlayfsProjectionBackend(),
        async (cwd: string) => {
        // 真实 broker：在 fused merged 视图上执行 /bin/sh 修改文件。
        const executor = brokerExecutorFactory(cwd, stateStore)
        // R01.5：执行域（bwrap 隔离视图）无法寻址 ../base（projection root
        // 兄弟）与宿主路径 —— 只看到 /workspace（merged）映射；宿主 /tmp
        // 是空 tmpfs（marker 不可见）；/home 不在只读布局内（不可达）。
        const marker = join(tmpdir(), `ak2-host-marker-${process.pid}`)
        writeFileSync(marker, "host")
        try {
          const isolationResult = await executor.execute(cwd, {
            executable: "/bin/sh",
            args: ["-c", `{ test -e ../base && echo BASE_VISIBLE || echo base_hidden; test -e ${marker} && echo HOST_TMP_VISIBLE || echo host_tmp_hidden; test -e /home/fuqiang/worktrees/orcana-agent-os && echo HOST_HOME_VISIBLE || echo host_home_hidden; } > src/isolation.txt`],
          })
          expect(isolationResult.outcome.exitCode).toBe(0)
          const isolationOutput = readFileSync(join(cwd, "src/isolation.txt"), "utf8")
          expect(isolationOutput).toContain("base_hidden")
          expect(isolationOutput).toContain("host_tmp_hidden")
          expect(isolationOutput).toContain("host_home_hidden")
        } finally {
          rmSync(marker, { force: true })
        }
        const { outcome } = await executor.execute(cwd, {
          executable: "/bin/sh",
          args: ["-c", "echo 'export const answer = 42' > src/main.ts"],
        })
        return outcome
        },
        new RuntimeStateReceiptAuthority(stateStore),
      )
      if (result.commitError !== undefined) {
        // R2-03：真实 lane ENV_BLOCKED —— cleanup proof 不可得（本机
        // cleanupVerified=false）→ World commit 拒绝（fail-closed，不算 PASS）。
        console.log(`ENV_BLOCKED: bubblewrap cleanup proof unavailable on this host (cleanupVerified=false); World commit refused: ${result.commitError instanceof Error ? result.commitError.message : String(result.commitError)}`)
        expect(result.ctx.store.getWorld("world-v")!.currentRevision).toBe(1n)
      } else {
        expect(result.revision).toBe(2n)
        expect(result.newContent).toBe("export const answer = 42\n")
      }
      result.ctx.cleanup()
    },
    60_000,
  )

  test(
    "B 层成功链（final receipt 校验）：真实 overlay + 真实 broker + World commit —— CLEANUP_FAILED 语义由 fixture 故障矩阵覆盖（真实卸载失败无副作用注入）",
    async () => {
      if (!realBackendAvailable) return
      const ctx = createTestWorldStore()
      ctx.store.createWorld({ worldId: "world-vf", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
      const digest = ctx.store.cas.put(Buffer.from("x\n", "utf8"), "text/plain").digest
      ctx.store.compareAndCommit({
        worldId: "world-vf", branchId: "b", baseRevision: 0n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "d-src", objectType: "directory", path: "src" },
          { type: "object.put", objectId: "f1", objectType: "file", path: "src/a.ts", contentRef: digest },
          { type: "object.put", objectId: "d1", objectType: "directory", path: "docs" },
        ],
      })
      ctx.store.createSnapshot("world-vf", "b")
      const snapshot = ctx.store.snapshots.getForRevision("world-vf", "b", 1n)!
      const materializer = new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: d => ctx.store.cas.get(d),
      })
      const root = tmpRoot("bfail")
      const stateStore = new RuntimeStateStore({ root: join(tmpdir(), `ak2-slice-bfail-state-${process.pid}-${Math.random().toString(36).slice(2, 8)}`) })
      const coord = new TestProjectionCoordinator({
        store: ctx.store,
        materializer,
        backend: new FuseOverlayfsProjectionBackend(),
        projectionRoot: root,
        // 真实 broker 执行 → final receipt 持久化到 stateStore → commit 前校验。
        receiptAuthority: new RuntimeStateReceiptAuthority(stateStore),
        // R7-03：durable reservation path 是必填 kernel 配置（测试用 per-test 路径）。
        intentReservationPath: join(tmpRoot("resbfail"), "res.sqlite"),
      })
      const plan = validateWorldProjectionPlan({
        projectionId: "proj-bfail", worldId: "world-vf", branchId: "b", snapshotId: snapshot.snapshotId,
        actor: "a", mode: "native", writableRoots: ["src"], readonlyRoots: ["docs"], expectedOutputs: ["src/a.ts"],
        graphCompletionAllowed: false,
      })
      const session = coord.start(plan)
      await coord.execute(
        session,
        { executable: "noop", args: [] },
        async cwd => {
          const executor = brokerExecutorFactory(cwd, stateStore)
          const { outcome } = await executor.execute(cwd, { executable: "/bin/sh", args: ["-c", "echo y >> src/a.ts"] })
          return outcome
        },
      )
      // R4-00-7：production scan 需要 finalized receipt/cleanup proof —— 本机
      // bubblewrap 无 cgroup 委托（cleanupVerified=false）→ ENV_BLOCKED：
      // scan 即 fail-closed（执行 writer 未证明终止不得扫描；比 commit 更早
      // 拒绝）。真实 unmount 失败无法无副作用注入 —— CLEANUP_FAILED/residue
      // 语义由 fixture 故障矩阵覆盖。
      let scanBlocked = false
      try {
        coord.scan(session)
      } catch (error) {
        const code = (error as { code?: string }).code ?? ""
        if (/^EXECUTION_RECEIPT_(NOT_PERSISTED|NOT_FINALIZED|REQUIRED)$/.test(code)) {
          scanBlocked = true
          console.log("ENV_BLOCKED: bubblewrap cleanup proof unavailable on this host (cleanupVerified=false); delta scan refused (fail-closed)")
        } else {
          throw error
        }
      }
      if (scanBlocked) {
        expect(ctx.store.getWorld("world-vf")!.currentRevision).toBe(1n)
        ctx.cleanup()
        return
      }
      try {
        const receipt = coord.commit(session)
        expect(receipt.newRevision).toBe(2n)
      } catch (error) {
        // R3-15：只有明确 cleanup-proof 不可得类错误归类 ENV_BLOCKED；
        // 未知错误必须失败。
        const code = (error as { code?: string }).code ?? ""
        if (!/^EXECUTION_RECEIPT_(NOT_PERSISTED|NOT_FINALIZED|REQUIRED)$/.test(code)) {
          throw error
        }
        console.log(`ENV_BLOCKED: bubblewrap cleanup proof unavailable on this host; commit refused: ${error instanceof Error ? error.message : String(error)}`)
        expect(ctx.store.getWorld("world-vf")!.currentRevision).toBe(1n)
      }
      ctx.cleanup()
    },
    60_000,
  )
})
