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
import { ProjectionCoordinator } from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import {
  CopyProjectionFixtureBackend,
  FuseOverlayfsProjectionBackend,
  probeNativeBackends,
} from "../../../src/kernel/projection/backend"
import { LinuxBrokerProjectionExecutor } from "../../../src/kernel/projection/broker-adapter"
import { validateWorldProjectionPlan } from "../../../src/kernel/projection/plan"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { RuntimeStateStore } from "../../../src/runtime/linux/recovery/state-store"
import { RuntimeStateReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
import { HOST_AUDIT_TEST_CAPABILITIES } from "../../helpers/linux-process-test-broker"
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
    } catch {
      // 已删
    }
  })
  return dir
}

/** 完整纵向链（共享给 A/B 两层）。 */
async function runVerticalSlice(
  backend: CopyProjectionFixtureBackend | FuseOverlayfsProjectionBackend,
  executor: import("../../../src/kernel/projection/coordinator").ProjectionExecutor,
  receiptAuthority?: import("../../../src/kernel/projection/receipt-authority").ProjectionReceiptAuthority,
): Promise<{ ctx: TestWorldStore; revision: bigint; newContent: string }> {
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
  const coord = new ProjectionCoordinator({
    store: ctx.store,
    materializer,
    backend,
    projectionRoot: tmpRoot("proj"),
    // A 层 fixture backend 需要显式 test capability（R06.3）。
    allowTestBackends: backend.kind === "fixture" ? true : undefined,
    // A 层 fixture executor 无真实 receipt —— 仅测试。
    allowFixtureExecution: backend.kind === "fixture" ? true : undefined,
    ...(receiptAuthority === undefined ? {} : { receiptAuthority }),
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
  const outcome = await coord.execute(session, { executable: "noop", args: [] }, executor)
  expect(outcome.exitCode).toBe(0)
  expect(session.executionState).toBe("COMPLETED")

  // 6. deterministic delta。
  const delta = coord.scan(session)
  expect(delta.entries).toContainEqual(expect.objectContaining({ kind: "write", path: "src/main.ts" }))

  // 7. validator 已内置于 commit（writes/expected output 验证）。
  // 8. World commit → revision 1（新 revision = 2）。
  const receipt = coord.commit(session)
  expect(session.worldState).toBe("COMMITTED")
  expect(receipt.newRevision).toBe(2n)
  expect(ctx.store.getWorld("world-v")!.currentRevision).toBe(2n)

  // 9. WorldCommitReceipt。
  expect(session.receipt!.worldCommitReceipt!.deltaDigest).toBe(delta.deltaDigest)
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
  return { ctx, revision: receipt.newRevision, newContent }
}

/** A 层 executor：直接写 merged（deterministic fixture 逻辑验证）。 */
async function fixtureExecutor(cwd: string): Promise<import("../../../src/kernel/projection/validator").ProjectionExecutionOutcome> {
  writeFileSync(join(cwd, "src/main.ts"), "export const answer = 42\n")
  return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
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
    ownerFiles: [merged],
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
    const result = await runVerticalSlice(new CopyProjectionFixtureBackend(), fixtureExecutor)
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
    "fuse-overlayfs 挂载 + 真实 broker 执行 + World commit 全链",
    async () => {
      if (!realBackendAvailable) {
        console.log("ENV_BLOCKED: fuse-overlayfs unavailable; B-lane skipped (not a pass)")
        return
      }
      const stateStore = new RuntimeStateStore({ root: join(tmpdir(), `ak2-slice-bstate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`) })
      const result = await runVerticalSlice(
        new FuseOverlayfsProjectionBackend(),
        async cwd => {
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
      expect(result.revision).toBe(2n)
      // merged 视图真实 overlay：lower 内容可见、upper 写入生效。
      expect(result.newContent).toBe("export const answer = 42\n")
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
      const coord = new ProjectionCoordinator({
        store: ctx.store,
        materializer,
        backend: new FuseOverlayfsProjectionBackend(),
        projectionRoot: root,
        // 真实 broker 执行 → final receipt 持久化到 stateStore → commit 前校验。
        receiptAuthority: new RuntimeStateReceiptAuthority(stateStore),
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
      coord.scan(session)
      // 注意：本测试验证真实 overlay 成功链（final receipt 校验 + commit）。
      // 真实 unmount 失败无法无副作用注入 —— CLEANUP_FAILED/residue 语义
      // 由 coordinator 故障矩阵（fixture stub，确定性）与 R03 测试覆盖。
      const receipt = coord.commit(session)
      expect(receipt.newRevision).toBe(2n)
      ctx.cleanup()
    },
    60_000,
  )
})
