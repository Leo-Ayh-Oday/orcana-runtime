/**
 * AK2-R4 Correction Gate —— R4-00 先红反例冻结。
 *
 * 每个反例在修复前必须 RED（断言生产代码当前错误行为），修复后 GREEN。
 * 分层：
 * - FIXTURE：fixture backend + fake receipt authority（deterministic）；
 * - ARGV：bwrap argv 编译检查（无需 bwrap binary）；
 * - REAL：真实 fuse-overlayfs / 真实 broker 执行；
 * - STATIC：文档/导出面静态断言。
 *
 * 反例清单（R4-00-1 ~ R4-00-13 + R4-01 导出面）：
 *   1  production backend + allowFixtureExecution:true + receiptless 仍可 commit
 *   2a 整个 merged root RW bind 到 /workspace（unscoped 可读可写）
 *   2b 覆盖 readonly root 的更宽 RW ancestor mount
 *   2c unscoped workspace 路径被 mount 覆盖（可读）
 *   2d unscoped cwd/executable 仍可编译（受控视图外解析）
 *   3a intent command A 但 adapter 实际执行 command B（spawn 前必须拒绝）
 *   3b adapter roots ≠ intent scope（scope 绑定必须参与验证）
 *   3c adapter workspace dev/ino ≠ intent workspace identity
 *   5  receipt 存在 signal/oomKilled/pidLimitHit/outputLimitHit/tempLimitHit
 *      时不得作为成功执行提交
 *   6  execute 前 mount ownership 丢失必须 terminalize（不是裸 throw）
 *   7  production scan 缺少 finalized receipt/cleanup proof 必须拒绝
 *   8  projection root 在 lstat 后、fd open 前被替换 → cleanup 不得修改替换目录
 *   9  backend mount 成功后 create 失败 → 不得递归删除仍挂载的 merged
 *   11 scanner final verification 期间新增 sibling/修改已验证文件/删除目录
 *      必须被拒绝或 fail-closed
 *   12 FileManifest JSON 很小但 logical file 很大 → 累计 tree budget 必须
 *      在 chunk read/write 前拒绝
 *   13 阶段文档第 144 行 trailing whitespace（git diff --check 基线）
 *  R4-01 FIXTURE_EXECUTION_TOKEN 不得从生产模块公开导出
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { ProjectionCoordinator, expectedProjectionFilesystemPolicyDigest, type ProjectionExecutor, type ProjectionSession } from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import {
  CopyProjectionFixtureBackend,
} from "./test-fixtures"
import {
  FuseOverlayfsProjectionBackend,
  type NativeProjectionBackend,
  type ProjectionInstance,
} from "../../../src/kernel/projection/backend"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { CasDigest } from "../../../src/kernel/world"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"
import type { ProjectionReceiptAuthority, ProjectionReceiptBinding } from "../../../src/kernel/projection/receipt-authority"
import { LinuxBrokerProjectionExecutor } from "../../../src/kernel/projection/broker-adapter"
import { compileBwrapArgv, createBubblewrapBackend } from "../../../src/runtime/linux/backends/bubblewrap"
import { probeNativeBackends } from "../../../src/kernel/projection/backend"
import { probeLinuxCapabilities } from "../../../src/runtime/linux/capability-probe"
import { canonicalJson } from "../../../src/kernel/world/canonical"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-r4-${label}-`))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已删
    }
  })
  return dir
}

function buildWorld(): { ctx: TestWorldStore; snapshotId: string; baseContent: string } {
  const ctx = createTestWorldStore()
  ctx.store.createWorld({
    worldId: "world-c",
    branchId: "branch-main",
    rootObjectId: "root-1",
    owner: "owner:test",
    purpose: "ak2 r4",
  })
  const baseContent = "export const value = 1\n"
  const digest = ctx.store.cas.put(Buffer.from(baseContent, "utf8"), "text/plain").digest
  ctx.store.compareAndCommit({
    worldId: "world-c",
    branchId: "branch-main",
    baseRevision: 0n,
    actor: "actor:test",
    mutations: [
      { type: "object.put", objectId: "obj-src", objectType: "directory", path: "src" },
      { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: digest },
    ],
  })
  ctx.store.createSnapshot("world-c", "branch-main")
  const snapshot = ctx.store.snapshots.getForRevision("world-c", "branch-main", 1n)!
  return { ctx, snapshotId: snapshot.snapshotId, baseContent }
}

function makePlan(snapshotId: string, overrides: Partial<WorldProjectionPlanInput> = {}): WorldProjectionPlan {
  return validateWorldProjectionPlan({
    projectionId: `proj-${Math.random().toString(36).slice(2, 10)}`,
    worldId: "world-c",
    branchId: "branch-main",
    snapshotId,
    actor: "actor:test",
    mode: "native",
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    expectedOutputs: ["src/main.ts"],
    graphCompletionAllowed: false,
    ...overrides,
  })
}

function coordinator(
  ctx: TestWorldStore,
  backend?: NativeProjectionBackend,
  options: Record<string, unknown> = {},
): ProjectionCoordinator {
  const materializer = new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
  return new ProjectionCoordinator({
    store: ctx.store,
    materializer,
    backend: backend ?? new CopyProjectionFixtureBackend(),
    projectionRoot: tmpRoot("projroot"),
    allowTestBackends: true,
    ...options,
  })
}

function mutateExecutor(actions: (merged: string) => void): ProjectionExecutor {
  return async cwd => {
    actions(cwd)
    return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
  }
}

/** production-kind backend stub：kind !== "fixture"，但提供最小 instance。 */
function productionKindBackend(instanceOverrides: Partial<ProjectionInstance> = {}): NativeProjectionBackend {
  return {
    id: "stub-production",
    kind: "fuse-overlayfs",
    create(input): ProjectionInstance {
      const merged = join(resolve(input.projectionRoot), "merged-stub")
      mkdirSync(merged, { mode: 0o700 })
      mkdirSync(join(merged, "src"), { recursive: true })
      mkdirSync(join(merged, "docs"), { recursive: true })
      const instance: ProjectionInstance = {
        backend: "fuse-overlayfs",
        mergedPath: merged,
        writeLayerPath: merged,
        assertReady: () => {
          statSync(merged)
        },
        assertMountOwned: () => true,
        sealForScan: () => ({ sealedPath: merged }),
        cleanup: () => {
          if (existsSync(merged)) rmSync(merged, { recursive: true, force: true })
          return true
        },
        ...instanceOverrides,
      }
      return instance
    },
  }
}

/** fake final receipt（digest 自洽；与 r3-counterexamples 同构）。 */
function fakeFinalReceipt(overrides: Partial<SandboxReceipt> = {}): SandboxReceipt {
  return {
    schemaVersion: "1.0",
    cellId: "cell-fake",
    runId: "run-fake",
    nodeRunId: "run-fake:n1",
    attempt: 1,
    backend: "bubblewrap",
    profile: "build",
    capabilitiesDigest: "b".repeat(64),
    cellSpecDigest: "c".repeat(64),
    filesystemPolicyDigest: "d".repeat(64),
    networkPolicyDigest: "e".repeat(64),
    resourcePolicyDigest: "f".repeat(64),
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    oomKilled: false,
    pidLimitHit: false,
    outputLimitHit: false,
    tempLimitHit: false,
    metrics: { status: "unknown", reason: "test fixture" },
    observedWrites: [],
    observedDeletes: [],
    unexpectedWrites: [],
    networkMode: "none",
    secretBindingIds: [],
    violations: [],
    degradationReasons: [],
    cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: true },
    receiptDigest: "",
    ...overrides,
  }
}

function fakeAuthority(overrides: Partial<SandboxReceipt> = {}): ProjectionReceiptAuthority & {
  setIntentDigest(digest: string | undefined): void
  setFilesystemPolicyDigest(digest: string): void
  setCleanupFinalized(finalized: boolean): void
  currentDigest(): string | undefined
} {
  let intentDigest: string | undefined
  // R4-03.4：fake receipt 必须携带 coordinator 派生的期望 policy digest。
  let filesystemPolicyDigest = "d".repeat(64)
  let cleanupFinalized = true
  let latestDigest = fakeFinalReceipt(overrides)
  const { computeReceiptDigest } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
  const inner: ProjectionReceiptAuthority = {
    getFinalReceipt: () => {
      if (intentDigest === undefined) return undefined
      const base = fakeFinalReceipt({ ...overrides, filesystemPolicyDigest })
      const withIntent = { ...base, projectionIntentDigest: intentDigest }
      latestDigest = { ...withIntent, receiptDigest: computeReceiptDigest(withIntent) }
      return latestDigest as SandboxReceipt
    },
    isCleanupFinalized: () => cleanupFinalized,
  }
  return Object.assign(inner, {
    setIntentDigest(digest: string | undefined): void {
      intentDigest = digest
    },
    setFilesystemPolicyDigest(digest: string): void {
      filesystemPolicyDigest = digest
    },
    setCleanupFinalized(finalized: boolean): void {
      cleanupFinalized = finalized
    },
    currentDigest(): string | undefined {
      if (intentDigest === undefined) return latestDigest.receiptDigest
      const base = fakeFinalReceipt({ ...overrides, filesystemPolicyDigest })
      return computeReceiptDigest({ ...base, projectionIntentDigest: intentDigest })
    },
  })
}

function bindIntent(auth: ReturnType<typeof fakeAuthority>, session: ProjectionSession): void {
  const { projectionIntentDigest } = require("../../../src/kernel/projection/contracts") as typeof import("../../../src/kernel/projection/contracts")
  const { expectedProjectionFilesystemPolicyDigest } = require("../../../src/kernel/projection/coordinator") as typeof import("../../../src/kernel/projection/coordinator")
  auth.setIntentDigest(projectionIntentDigest(session.intent))
  auth.setFilesystemPolicyDigest(expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir))
}

function bindOutcome(session: ProjectionSession, auth: ReturnType<typeof fakeAuthority>): void {
  session.outcome = {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    violation: false,
    executionReceiptId: auth.currentDigest()!,
    receiptBinding: {
      runId: "run-fake",
      nodeRunId: "run-fake:n1",
      cellId: "cell-fake",
      cellSpecDigest: "c".repeat(64),
      filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir),
      workspaceHostRoot: session.mergedDir,
    } as ProjectionReceiptBinding,
  }
}

async function sessionAtDeltaReady(
  coord: ProjectionCoordinator,
  plan: WorldProjectionPlan,
  ctx: TestWorldStore,
  actions: (merged: string) => void = merged => writeFileSync(join(merged, "src/main.ts"), "changed\n"),
): Promise<ProjectionSession> {
  const session = coord.start(plan)
  await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(actions))
  coord.scan(session)
  return session
}

/** bwrap argv 挂载三元组解析。 */
function mountArgs(argv: string[]): Array<{ flag: string; source: string; target: string }> {
  const mounts: Array<{ flag: string; source: string; target: string }> = []
  for (let index = 0; index < argv.length - 2; index++) {
    const flag = argv[index]
    if (flag === "--bind" || flag === "--ro-bind") {
      mounts.push({ flag, source: argv[index + 1]!, target: argv[index + 2]! })
    }
  }
  return mounts
}

const caps = probeLinuxCapabilities()

/** 投影形态的 bwrap 编译输入：worktree + 声明 roots（/workspace 目标）。 */
function projectionMountRules(worktree: string, writable: string[], readonly: string[]) {
  return {
    worktreeRoot: worktree,
    extraWritable: writable.map(path => ({ source: join(worktree, path), target: `/workspace/${path}`, mode: "rw" as const, required: true, recursive: true })),
    extraReadonly: readonly.map(path => ({ source: join(worktree, path), target: `/workspace/${path}`, mode: "ro" as const, required: true, recursive: true })),
  }
}

describe("AK2-R4 反例（R4-00 先红冻结）", () => {
  test("R4-00-1：production backend + allowFixtureExecution:true + receiptless 不得 commit（boolean bypass 必须删除）", () => {
    const { ctx } = buildWorld()
    // allowFixtureExecution 是已删除的 bypass —— 用 never 断言它不再存在
    // 于选项面：production backend 缺 receipt authority → 构造即拒绝
    //（WORLD_COMMIT_WITHOUT_RECEIPT = 0；比 commit 更早 fail-closed）。
    let refused = false
    try {
      coordinator(ctx, productionKindBackend(), { allowFixtureExecution: true as never })
    } catch (error) {
      refused = (error as ProjectionError).code === "EXECUTION_RECEIPT_REQUIRED"
    }
    expect(refused).toBe(true)
    if (!refused) {
      throw new Error("R4-00-1 RED: allowFixtureExecution bypass still accepted for production backend")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R4-00-2a：整个 merged root 不得 RW bind 到 /workspace（unscoped 路径不得可读/可写）", () => {
    const worktree = tmpRoot("bw2a")
    mkdirSync(join(worktree, "src"))
    mkdirSync(join(worktree, "docs"))
    const argv = compileBwrapArgv({ command: { cwd: worktree } } as never, caps, projectionMountRules(worktree, ["src"], ["docs"]))
    const mounts = mountArgs(argv)
    const wholeWorkspaceRw = mounts.find(m => m.target === "/workspace" && m.flag === "--bind")
    expect(wholeWorkspaceRw).toBeUndefined()
    if (wholeWorkspaceRw !== undefined) {
      throw new Error(`R4-00-2a RED: ${wholeWorkspaceRw.flag} ${wholeWorkspaceRw.source} /workspace exposes the whole merged root (unscoped paths readable+writable)`)
    }
  })

  test("R4-00-2b：不得存在覆盖 readonly root 的更宽 RW ancestor mount", () => {
    const worktree = tmpRoot("bw2b")
    mkdirSync(join(worktree, "src"))
    mkdirSync(join(worktree, "docs"))
    const argv = compileBwrapArgv({ command: { cwd: worktree } } as never, caps, projectionMountRules(worktree, ["src"], ["docs"]))
    const mounts = mountArgs(argv)
    for (const rw of mounts.filter(m => m.flag === "--bind")) {
      for (const ro of mounts.filter(m => m.flag === "--ro-bind")) {
        if (ro.target === rw.target || ro.target.startsWith(rw.target.replace(/\/$/, "") + "/")) {
          throw new Error(`R4-00-2b RED: RW mount ${rw.target} is an ancestor of readonly mount ${ro.target} (readonly root writable via alias)`)
        }
      }
    }
  })

  test("R4-00-2c：unscoped workspace 路径不得被任何 mount target 覆盖（不可达）", () => {
    const worktree = tmpRoot("bw2c")
    mkdirSync(join(worktree, "src"))
    mkdirSync(join(worktree, "docs"))
    mkdirSync(join(worktree, "secret"))
    const argv = compileBwrapArgv({ command: { cwd: worktree } } as never, caps, projectionMountRules(worktree, ["src"], ["docs"]))
    const targets = mountArgs(argv).map(m => m.target)
    for (const unscoped of ["/workspace/secret", "/workspace/secret/key.txt", "/workspace/other.txt"]) {
      const covered = targets.some(t => unscoped === t || unscoped.startsWith(t.replace(/\/$/, "") + "/"))
      if (covered) {
        throw new Error(`R4-00-2c RED: unscoped path ${unscoped} is covered by a mount target (readable inside sandbox)`)
      }
    }
  })

  test("R4-00-2d：command cwd/executable 必须在该受控视图内解析（unscoped → compile 拒绝）", () => {
    const worktree = tmpRoot("bw2d")
    mkdirSync(join(worktree, "src"))
    mkdirSync(join(worktree, "unscoped"))
    const backend = createBubblewrapBackend()
    // unscoped cwd：视图外路径必须拒绝（当前 guestWorkspacePath 全量映射）。
    const badCwdSpec = {
      schemaVersion: "1.0",
      identity: { cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1 },
      command: { executable: "/bin/true", args: [], cwd: join(worktree, "unscoped"), stdin: "closed" },
      profile: "build",
      isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: false },
      filesystem: {
        readonlyMounts: [{ source: join(worktree, "docs"), target: "/workspace/docs", mode: "ro", required: true, recursive: true }],
        writableMounts: [{ source: join(worktree, "src"), target: "/workspace/src", mode: "rw", required: true, recursive: true }],
        tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: worktree,
      },
      network: { mode: "none" },
      environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
      secrets: [], resources: { memoryMaxBytes: 1024, pidsMax: 128, wallTimeMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
      cache: [], lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
      policyDigest: "",
    }
    let refused = false
    try {
      backend.compile(badCwdSpec as never, caps, undefined)
    } catch (error) {
      refused = (error as { code?: string }).code === "WORKSPACE_PATH_ESCAPE"
    }
    if (!refused) {
      throw new Error("R4-00-2d RED: unscoped cwd compiled successfully (must refuse before spawn)")
    }
    // unscoped executable：同样必须拒绝。
    const badExecSpec = {
      ...badCwdSpec,
      command: { executable: join(worktree, "unscoped/tool"), args: [], cwd: join(worktree, "src"), stdin: "closed" },
    }
    let execRefused = false
    try {
      backend.compile(badExecSpec as never, caps, undefined)
    } catch (error) {
      execRefused = (error as { code?: string }).code === "WORKSPACE_PATH_ESCAPE"
    }
    if (!execRefused) {
      throw new Error("R4-00-2d RED: unscoped executable compiled successfully (must refuse before spawn)")
    }
  })

  describe("R4-00-3：adapter 独立绑定 Intent / Scope / Workspace（spawn 前逐字段验证）", () => {
    // 真实 broker + 真实 bwrap（本机已验证 unprivilegedUsable）：RED 时
    // adapter 无验证 → 照常执行；GREEN 时必须在 spawn 前拒绝。
    const { createLinuxBroker } = require("../../../src/runtime/linux/broker") as typeof import("../../../src/runtime/linux/broker")
    const { WorkspaceAuthorityRegistry } = require("../../../src/runtime/linux/workspace/workspace-authority") as typeof import("../../../src/runtime/linux/workspace/workspace-authority")

    function intentFor(merged: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const stat = lstatSync(merged)
      return {
        intentId: `intent-${Math.random().toString(36).slice(2, 10)}`,
        worldId: "world-c",
        branchId: "branch-main",
        snapshotId: "snap-1",
        projectionId: "proj-1",
        sessionNonce: "nonce-1",
        mergedRootIdentity: { dev: stat.dev, ino: stat.ino },
        command: { executable: "/bin/true", args: [] },
        scopeDigest: "scope-digest",
        // R4-03 新增字段（RED 时不存在 → never）。
        filesystemScope: { writableRoots: ["src"], readonlyRoots: ["docs"] },
        workspaceIdentity: { path: resolve(merged), dev: stat.dev, ino: stat.ino },
        ...overrides,
      }
    }

    function makeExecutor(merged: string) {
      const registry = new WorkspaceAuthorityRegistry()
      const workspace = registry.registerAgentWorktree({
        projectId: "ak2-proj",
        hostRoot: merged,
        access: "readwrite",
        ownerFiles: ["src"],
      })
      const broker = createLinuxBroker({ mode: "enabled" })
      return new LinuxBrokerProjectionExecutor({
        broker,
        authority: { identity: { runId: "run-r4", nodeRunId: "run-r4:n1", attempt: 1 }, workspace },
        writableRoots: ["src"],
        readonlyRoots: ["docs"],
        profile: "build",
      })
    }

    test("R4-00-3a：intent command A 但 adapter 实际执行 command B → spawn 前拒绝", async () => {
      const merged = tmpRoot("ad3a")
      mkdirSync(join(merged, "src"))
      mkdirSync(join(merged, "docs"))
      const executor = makeExecutor(merged)
      const intent = intentFor(merged, { command: { executable: "/bin/echo", args: ["A"] } })
      let rejected = false
      try {
        await executor.execute(merged, { executable: "/bin/echo", args: ["B"], intent: intent as never })
      } catch (error) {
        rejected = (error as ProjectionError).code === "EXECUTION_RECEIPT_BINDING_MISMATCH"
      }
      if (!rejected) {
        throw new Error("R4-00-3a RED: adapter executed command B while intent declared command A (must refuse before spawn)")
      }
    })

    test("R4-00-3b：adapter roots ≠ intent scope → spawn 前拒绝（scopeDigest 参与验证）", async () => {
      const merged = tmpRoot("ad3b")
      mkdirSync(join(merged, "src"))
      mkdirSync(join(merged, "docs"))
      const executor = makeExecutor(merged)
      const intent = intentFor(merged, {
        filesystemScope: { writableRoots: ["src", "extra"], readonlyRoots: ["docs"] },
      })
      let rejected = false
      try {
        await executor.execute(merged, { executable: "/bin/true", args: [], intent: intent as never })
      } catch (error) {
        rejected = (error as ProjectionError).code === "EXECUTION_RECEIPT_BINDING_MISMATCH"
      }
      if (!rejected) {
        throw new Error("R4-00-3b RED: adapter executed with roots differing from intent scope (scope binding not enforced)")
      }
    })

    test("R4-00-3c：adapter workspace dev/ino ≠ intent workspace identity → spawn 前拒绝", async () => {
      const merged = tmpRoot("ad3c")
      mkdirSync(join(merged, "src"))
      mkdirSync(join(merged, "docs"))
      const executor = makeExecutor(merged)
      const intent = intentFor(merged, {
        workspaceIdentity: { path: resolve(merged), dev: 1, ino: 2 },
      })
      let rejected = false
      try {
        await executor.execute(merged, { executable: "/bin/true", args: [], intent: intent as never })
      } catch (error) {
        rejected = (error as ProjectionError).code === "EXECUTION_RECEIPT_BINDING_MISMATCH"
      }
      if (!rejected) {
        throw new Error("R4-00-3c RED: adapter executed with workspace identity differing from intent (workspace binding not enforced)")
      }
    })
  })

  test("R4-00-5：receipt 存在 signal/oomKilled/pidLimitHit/outputLimitHit/tempLimitHit 时不得作为成功执行提交", async () => {
    const cases: Array<Partial<SandboxReceipt>> = [
      { signal: "SIGKILL" },
      { oomKilled: true },
      { pidLimitHit: true },
      { outputLimitHit: true },
      { tempLimitHit: true },
    ]
    for (const overrides of cases) {
      const { ctx, snapshotId } = buildWorld()
      const auth = fakeAuthority(overrides)
      const coord = coordinator(ctx, undefined, { fixtureExecutionToken: Symbol("r4-token"), receiptAuthority: auth })
      const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
      bindIntent(auth, session)
      bindOutcome(session, auth)
      try {
        coord.commit(session)
        throw new Error(`R4-00-5 RED: receipt ${JSON.stringify(overrides)} committed as success`)
      } catch (error) {
        if ((error as Error).message.startsWith("R4-00-5 RED")) throw error
        expect((error as ProjectionError).code).toMatch(/EXECUTION_RECEIPT_BINDING_MISMATCH|EXECUTION_RECEIPT_REPLAY/)
      }
      expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
      ctx.cleanup()
    }
  })

  test("R4-00-6：execute 前 mount ownership 丢失 → 必须进入终态（REJECTED + cleanupState + terminal receipt）", async () => {
    const { ctx, snapshotId } = buildWorld()
    let owned = true
    const backend = productionKindBackend({ assertMountOwned: () => owned })
    const coord = coordinator(ctx, backend, { receiptAuthority: fakeAuthority() })
    const session = coord.start(makePlan(snapshotId))
    owned = false
    try {
      await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(() => {}))
    } catch {
      // execute 前 ownership 复核失败 → 必须 terminalize（R4-00-6）。
    }
    expect(session.worldState).toBe("REJECTED")
    if (session.worldState !== "REJECTED") {
      throw new Error("R4-00-6 RED: execute-pre ownership loss did not terminalize the session (bare throw, no cleanup/receipt)")
    }
    expect(session.cleanupState).toBeDefined()
    expect(session.receipt).toBeDefined()
    expect(session.receipt!.worldState).toBe("REJECTED")
    ctx.cleanup()
  })

  test("R4-00-7：production scan 缺少 finalized receipt/cleanup proof 时必须拒绝（不能跳过）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx, productionKindBackend(), { receiptAuthority: fakeAuthority() })
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(merged => {
      writeFileSync(join(merged, "src/main.ts"), "changed\n")
    }))
    // production backend + receiptless outcome（无 executionReceiptId）：
    // scan 必须拒绝（cleanup proof 缺失 → 执行 writer 可能仍在运行）。
    try {
      coord.scan(session)
      throw new Error("R4-00-7 RED: production scan proceeded without finalized receipt/cleanup proof")
    } catch (error) {
      if ((error as Error).message.startsWith("R4-00-7 RED")) throw error
      expect((error as ProjectionError).code).toMatch(/EXECUTION_RECEIPT_REQUIRED|EXECUTION_RECEIPT_NOT_FINALIZED|PROJECTION_NOT_PROJECTED/)
    }
    expect(session.worldState).toBe("REJECTED")
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R4-00-8：projection root 在外层 lstat 后、fd open 前被替换 → cleanup 不得修改替换目录", async () => {
    const { ctx, snapshotId } = buildWorld()
    let swapped = false
    const coord = coordinator(ctx, undefined, {
      fixtureExecutionToken: Symbol("r4-token"),
      // 测试注入窗口（test-only；生产不传）：lstat 验证后、fd open 前。
      onBeforeProjectionRootOpen: (root: string) => {
        if (swapped) return
        swapped = true
        renameSync(root, `${root}.old`)
        mkdirSync(root, { mode: 0o700 })
        writeFileSync(join(root, "sentinel.txt"), "SENTINEL")
      },
    })
    const session = coord.start(makePlan(snapshotId))
    coord.cancel(session)
    expect(swapped).toBe(true)
    // 替换目录必须原样保留（cleanup 不得删除其中的 sentinel、不得 rmdir 替换目录）。
    expect(readFileSync(join(session.projectionRoot, "sentinel.txt"), "utf8")).toBe("SENTINEL")
    if (!existsSync(join(session.projectionRoot, "sentinel.txt"))) {
      throw new Error("R4-00-8 RED: cleanup deleted contents of the replacement directory (identity check after fd open is too late)")
    }
    ctx.cleanup()
  })

  test("R4-00-9：backend mount 成功后 create 失败 → 不得递归删除仍挂载的 merged（residue 保留）", () => {
    const root = tmpRoot("createfail")
    const lower = join(root, "lower")
    mkdirSync(lower)
    writeFileSync(join(lower, "marker.txt"), "MARKER")
    // 000 模式子目录：真实 mount 成功后 chmodMergedWritable 的 readdir 必然
    // EACCES → create 失败（mount 已成功）。
    mkdirSync(join(lower, "locked"))
    chmodSync(join(lower, "locked"), 0o000)
    chmodSync(lower, 0o755)
    // fake fusermount3/fusermount：unmount（-u）报告成功但不卸载；mount 调用
    // 透传真实 binary（fuse-overlayfs 内部经 fusermount3 挂载 —— 不能破坏
    // mount 本身，只伪造 unmount 结果）。bun 的 execFileSync 使用进程启动
    // 时的 PATH —— 因此经子进程（r4-create-fail-child）注入。
    const fakeBin = join(root, "fakebin")
    mkdirSync(fakeBin, { mode: 0o755 })
    writeFileSync(join(fakeBin, "fusermount3"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then exit 0; fi\nexec /usr/bin/fusermount3 \"$@\"\n", { mode: 0o755 })
    writeFileSync(join(fakeBin, "fusermount"), "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then exit 0; fi\nexec /usr/bin/fusermount \"$@\"\n", { mode: 0o755 })
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const child = spawnSync(process.execPath, [join(__dirname, "r4-create-fail-child.ts")], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        R4_ROOT: root,
        R4_LOWER: lower,
      },
      encoding: "utf8",
      timeout: 120_000,
    })
    expect(child.status).toBe(0)
    if (child.status !== 0) {
      throw new Error(`R4-00-9 child failed: ${child.stderr ?? child.stdout}`)
    }
    const merged = join(root, "merged-m")
    const { statfsSync } = require("node:fs") as typeof import("node:fs")
    // merged 仍挂载（fake unmount 报告成功 ≠ 已卸载）—— create 失败路径
    // 不得递归删除其内容、不得删除挂载的 backing store（upper/work residue
    // 保留）。
    expect(statfsSync(merged).type).toBe(0x65735546)
    expect(existsSync(join(root, "upper-m"))).toBe(true)
    if (!existsSync(join(root, "upper-m"))) {
      throw new Error("R4-00-9 RED: create failure recursively deleted upper/work while merged still mounted")
    }
    expect(existsSync(join(root, "work-m"))).toBe(true)
    // 清理：真实 fusermount3 卸载（fake 只是测试诱饵）。
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
    try {
      execFileSync("/usr/bin/fusermount3", ["-u", merged], { stdio: "ignore" })
    } catch {
      execFileSync("fusermount3", ["-u", merged], { stdio: "ignore" })
    }
    chmodSync(join(lower, "locked"), 0o700)
  })

  describe("R4-00-11：scanner final verification 期间写入必须被拒绝（sealed view）或 fail-closed", () => {
    async function runScanWithFinalWrite(
      backend: NativeProjectionBackend,
      attempt: (merged: string) => void,
    ): Promise<{ writeRejected: boolean; scanFailed: boolean }> {
      const { ctx, snapshotId } = buildWorld()
      const coord = coordinator(ctx, backend, {
        fixtureExecutionToken: Symbol("r4-token"),
        // R4-01：production backend 构造需要 receipt authority（此处只
        // 驱动 start/execute + 直接 scanner，不经 coord.scan 的 proof gate）。
        receiptAuthority: fakeAuthority(),
      })
      let mergedDir = ""
      let writeRejected = false
      const materializer = new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: digest => ctx.store.cas.get(digest),
      })
      // 直接驱动 scanner（注入 finalVerify 窗口）—— 与 coordinator 的
      // seal 语义等价：final verification 期间的写入必须被拒绝或检测。
      const { scanProjectionDelta } = require("../../../src/kernel/projection/scanner") as typeof import("../../../src/kernel/projection/scanner")
      const session = coord.start(makePlan(snapshotId))
      mergedDir = session.mergedDir
      await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(merged => {
        writeFileSync(join(merged, "src/main.ts"), "changed\n")
      }))
      const baseIndex = new Map<string, unknown>()
      let scanFailed = false
      try {
        const baseDir = session.baseDir
        // 与 coordinator.scan 相同路径：生产 backend 先 seal，再扫描 sealed 视图。
        // （R4-06 seam：RED 时 sealForScan 尚不存在 → 回退到未密封视图。）
        const instanceWithSeal = session.instance as { sealForScan?: () => { readonly sealedPath: string } | { readonly error: string } }
        const sealed = instanceWithSeal.sealForScan?.() ?? { sealedPath: mergedDir }
        if ("error" in sealed) {
          scanFailed = true
        } else {
          const { parseFilesystemSection } = require("../../../src/kernel/projection/materializer") as typeof import("../../../src/kernel/projection/materializer")
          const manifest = parseFilesystemSection(ctx.store.cas.get(ctx.store.snapshots.get(snapshotId)!.filesystemDigest))
          for (const entry of manifest.entries) {
            if (entry.path !== undefined) baseIndex.set(entry.path, entry)
          }
          scanProjectionDelta({
            baseDir,
            mergedDir: sealed.sealedPath,
            baseIndex: baseIndex as never,
            cas: { put: c => ctx.store.cas.put(c), has: d => ctx.store.cas.has(d) },
            worldId: "world-c",
            branchId: "branch-main",
            baseRevision: 1n,
            // 测试注入窗口：final verification 完成后（生产不传）。
            onFinalVerifyAfter: (rootPath: string) => {
              if (rootPath !== sealed.sealedPath) return
              try {
                attempt(sealed.sealedPath)
              } catch {
                writeRejected = true
              }
            },
          })
        }
      } catch {
        scanFailed = true
      }
      // 清理 projection 实例（含 sealed ro mount —— R4-05/06 cleanup 契约：
      // 真实卸载 + 确认消失 + rmdir；测试残留必须为 0）。
      try {
        coord.cancel(session)
      } catch {
        // 已终态等 —— cleanup 由 cancel 的幂等路径覆盖
      }
      ctx.cleanup()
      return { writeRejected, scanFailed }
    }

    test("R4-00-11a：final verification 期间新增 sibling → 写入必须被拒绝或 scan fail-closed（fixture lane）", async () => {
      const result = await runScanWithFinalWrite(new CopyProjectionFixtureBackend(), merged => {
        writeFileSync(join(merged, "new-sibling.txt"), "LATE")
      })
      expect(result.writeRejected || result.scanFailed).toBe(true)
      if (!result.writeRejected && !result.scanFailed) {
        throw new Error("R4-00-11a RED: sibling added during final verification was neither rejected nor detected")
      }
    })

    test("R4-00-11b：final verification 期间修改已验证文件 → 写入必须被拒绝或 scan fail-closed（fixture lane）", async () => {
      const result = await runScanWithFinalWrite(new CopyProjectionFixtureBackend(), merged => {
        writeFileSync(join(merged, "src/main.ts"), "tampered-late\n")
      })
      expect(result.writeRejected || result.scanFailed).toBe(true)
      if (!result.writeRejected && !result.scanFailed) {
        throw new Error("R4-00-11b RED: verified file modified during final verification was neither rejected nor detected")
      }
    })

    test("R4-00-11c：final verification 期间删除目录 → 必须被拒绝或 scan fail-closed（fixture lane）", async () => {
      const result = await runScanWithFinalWrite(new CopyProjectionFixtureBackend(), merged => {
        rmSync(join(merged, "src"), { recursive: true, force: true })
      })
      expect(result.writeRejected || result.scanFailed).toBe(true)
      if (!result.writeRejected && !result.scanFailed) {
        throw new Error("R4-00-11c RED: directory deletion during final verification was neither rejected nor detected")
      }
    })

    test("R4-00-11d：真实 FUSE sealed 视图（内核 EROFS）—— final verification 期间写入被内核拒绝", async () => {
      // 真实 fuse-overlayfs ro remount：seal 后 merged 视图不可写（内核
      // MS_RDONLY）—— 这是 scanner sealed view 的真实证明（fixture 的
      // mode-based seal 只是逻辑近似）。不可用 → 显式 ENV_BLOCKED（不算
      // PASS；本机已验证可用）。
      const probe = probeNativeBackends()
      if (!probe.fuseOverlayfs) {
        console.log("ENV_BLOCKED: fuse-overlayfs unavailable; real sealed-view lane not run")
        return
      }
      const result = await runScanWithFinalWrite(new FuseOverlayfsProjectionBackend(), merged => {
        writeFileSync(join(merged, "late-write.txt"), "LATE")
      })
      // sealed 视图拒绝写入（EROFS）或 seal 失败 fail-closed。
      expect(result.writeRejected || result.scanFailed).toBe(true)
      if (!result.writeRejected && !result.scanFailed) {
        throw new Error("R4-00-11d RED: write succeeded on the sealed real-FUSE view (seal is not kernel-enforced)")
      }
    }, 60_000)
  })

  test("R4-00-12：FileManifest JSON 很小但 logical file 很大 → 累计 tree budget 必须在 chunk read/write 前拒绝", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w-bud", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    // 约束：maxTreeBytes >= maxFileBytes —— 单个文件无法单独超预算；反例用
    // 两个文件构造累计超预算：a.bin（raw 2MB）已写后，big.bin（FileManifest
    // JSON 很小但 logical 3MB）的累计预算必须在打开文件前拒绝。
    const aRaw = ctx.store.cas.put(Buffer.alloc(2 * 1024 * 1024, 68), "application/octet-stream")
    const bigChunk = ctx.store.cas.put(Buffer.alloc(3 * 1024 * 1024, 65), "application/octet-stream")
    const fm = { schemaVersion: 1, type: "file", mediaType: "text/plain", size: 3 * 1024 * 1024, chunks: [{ digest: bigChunk.digest, offset: 0, size: 3 * 1024 * 1024 }] }
    const fmBytes = Buffer.from(canonicalJson(fm), "utf8")
    // FileManifest JSON 必须显著小于 tree budget（否则 record.size 预检会
    // 以错误理由拒绝 —— 反例要求 manifest JSON 小、logical file 大）。
    expect(fmBytes.byteLength).toBeLessThan(1024 * 1024)
    const fmRec = ctx.store.cas.putManifest(fmBytes, [bigChunk.digest])
    ctx.store.compareAndCommit({
      worldId: "w-bud",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "data", objectType: "directory", path: "data" },
        { type: "object.put", objectId: "data/a", objectType: "file", path: "data/a.bin", contentRef: aRaw.digest },
        { type: "object.put", objectId: "data/big", objectType: "file", path: "data/big.bin", contentRef: fmRec.digest },
      ],
    })
    ctx.store.createSnapshot("w-bud", "b")
    const snapshot = ctx.store.snapshots.getForRevision("w-bud", "b", 1n)!
    const baseDir = mkdtempSync(join(tmpdir(), "ak2-r4-budget-"))
    try {
      const materializer = new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: digest => ctx.store.cas.get(digest),
      }, {
        maxDepth: 64,
        maxEntries: 100_000,
        maxFileBytes: 4 * 1024 * 1024,
        maxTreeBytes: 4 * 1024 * 1024,
        maxFileChunks: 4096,
        maxManifestBytes: 64 * 1024 * 1024,
        maxMetadataBytes: 1024 * 1024,
      })
      let rejected = false
      try {
        materializer.materialize(snapshot.snapshotId, baseDir)
      } catch (error) {
        rejected = (error as ProjectionError).code === "PROJECTION_RESOURCE_LIMIT"
      }
      expect(rejected).toBe(true)
      if (!rejected) {
        throw new Error("R4-00-12 RED: over-budget FileManifest was not rejected with PROJECTION_RESOURCE_LIMIT")
      }
      // 拒绝必须发生在打开目标文件、读取 chunk、写入任何字节之前。
      expect(existsSync(join(baseDir, "data", "big.bin"))).toBe(false)
      if (existsSync(join(baseDir, "data", "big.bin"))) {
        throw new Error("R4-00-12 RED: target file was created before budget rejection (chunk read/write already started)")
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      ctx.cleanup()
    }
  })

  test("R4-00-13：阶段文档不得包含 trailing whitespace（git diff --check 基线；第 144 行）", () => {
    const doc = readFileSync("docs/agent-os/stages/ak-2-projection-world-commit.md", "utf8")
    const lines = doc.split("\n")
    for (let index = 0; index < lines.length; index++) {
      if (/[ \t]+$/.test(lines[index]!)) {
        throw new Error(`R4-00-13 RED: trailing whitespace at line ${index + 1} (git diff --check would fail)`)
      }
    }
  })

  test("R4-01：FIXTURE_EXECUTION_TOKEN 不得从生产模块公开导出（PUBLIC_FIXTURE_AUTHORITY = 0）", async () => {
    const coordinatorModule = await import("../../../src/kernel/projection/coordinator")
    expect("FIXTURE_EXECUTION_TOKEN" in coordinatorModule).toBe(false)
    if ("FIXTURE_EXECUTION_TOKEN" in coordinatorModule) {
      throw new Error("R4-01 RED: FIXTURE_EXECUTION_TOKEN is publicly exported from a production module")
    }
  })
})
