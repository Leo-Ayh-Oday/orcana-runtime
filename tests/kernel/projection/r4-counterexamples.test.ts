/**
 * AK2-R4 Correction Gate —— R4-00 先红反例冻结。
 *
 * 每个反例在修复前必须 RED（断言生产代码当前错误行为），修复后 GREEN。
 *
 * 覆盖（R4-00）：
 * - R4-00-1  production backend + allowFixtureExecution:true + receiptless
 *   仍可 commit（boolean bypass 必须删除）
 * - R4-00-2  Bubblewrap：/workspace 整树 RW bind（unscoped 可见 +
 *   readonly root 被更宽 RW ancestor 覆盖）+ cwd/executable 无受控视图覆盖
 * - R4-00-3  adapter 实际执行 command ≠ intent command（pre-spawn 必须拒绝）
 * - R4-00-3b adapter roots ≠ intent scope（scopeDigest 必须参与验证）
 * - R4-00-3c adapter workspace dev/ino ≠ intent.mergedRootIdentity
 * - R4-00-5  receipt 存在 signal/oomKilled/pidLimitHit/outputLimitHit/
 *   tempLimitHit 时不得作为成功执行提交
 * - R4-00-6  execute 前 mount ownership 丢失必须 terminalize
 * - R4-00-7  production scan 缺少 finalized receipt/cleanup proof 必须拒绝
 * - R4-00-8  projection root 在 lstat 后、fd open 前被替换 → cleanup 不得
 *   修改替换目录
 * - R4-00-9  backend mount 成功后 create 失败 → 不得递归删除仍挂载的 merged
 * - R4-00-11 scanner final verification 期间新增 sibling / 修改已验证文件 /
 *   删除替换目录 → 写入必须被拒绝或 scanner fail-closed（sealed view）
 * - R4-00-12 FileManifest JSON 很小但 logical file 很大 → 累计 tree budget
 *   必须在 chunk read/write 前拒绝
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
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import {
  ProjectionCoordinator,
  type ProjectionExecutor,
  type ProjectionSession,
} from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import {
  CopyProjectionFixtureBackend,
  FuseOverlayfsProjectionBackend,
  type NativeProjectionBackend,
  type ProjectionInstance,
} from "../../../src/kernel/projection/backend"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { CasDigest } from "../../../src/kernel/world"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"
import type { ProjectionReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
import { createHash } from "node:crypto"
import { compileBwrapArgv, createBubblewrapBackend } from "../../../src/runtime/linux/backends/bubblewrap"
import { probeLinuxCapabilities } from "../../../src/runtime/linux/capability-probe"
import { LinuxBrokerProjectionExecutor } from "../../../src/kernel/projection/broker-adapter"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { WorkspaceAuthorityRegistry } from "../../../src/runtime/linux/workspace/workspace-authority"
import { canonicalJson, sha256Digest } from "../../../src/kernel/world/canonical"

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
  options: ConstructorParameters<typeof ProjectionCoordinator>[0] & { backend?: NativeProjectionBackend } = {},
): ProjectionCoordinator {
  const materializer = new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
  return new ProjectionCoordinator({
    store: ctx.store,
    materializer,
    backend: options.backend ?? new CopyProjectionFixtureBackend(),
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

/** fake final receipt（digest 自洽；与 r3-counterexamples.test.ts 同构）。 */
function fakeFinalReceipt(overrides: Partial<SandboxReceipt> = {}): SandboxReceipt {
  const base = {
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
    ...overrides,
  } as Omit<SandboxReceipt, "receiptDigest">
  const { computeReceiptDigest } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
  return { ...base, receiptDigest: computeReceiptDigest(base) }
}

function fakeAuthority(overrides: Partial<SandboxReceipt> & { hidden?: boolean } = {}): ProjectionReceiptAuthority & {
  setIntentDigest(digest: string | undefined): void
  currentDigest(): string | undefined
} {
  const { hidden, ...receiptOverrides } = overrides
  let intentDigest: string | undefined
  const seedReceipt = fakeFinalReceipt(receiptOverrides)
  let latestDigest: string | undefined = seedReceipt.receiptDigest
  const inner: ProjectionReceiptAuthority = {
    getFinalReceipt: () => {
      if (hidden === true) return undefined
      if (intentDigest === undefined) return undefined
      const receipt = fakeFinalReceipt(receiptOverrides)
      const { receiptDigest: _rd, ...content } = receipt
      const withIntent = { ...content, projectionIntentDigest: intentDigest }
      const { computeReceiptDigest: crd } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
      latestDigest = crd(withIntent)
      return { ...content, projectionIntentDigest: intentDigest, receiptDigest: latestDigest }
    },
    isCleanupFinalized: () => true,
  }
  return Object.assign(inner, {
    setIntentDigest(digest: string | undefined): void {
      intentDigest = digest
    },
    currentDigest(): string | undefined {
      if (intentDigest === undefined) return latestDigest
      const { computeReceiptDigest: crd } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
      const { receiptDigest: _rd, ...content } = fakeFinalReceipt(receiptOverrides)
      return crd({ ...content, projectionIntentDigest: intentDigest })
    },
  })
}

function bindIntent(auth: ReturnType<typeof fakeAuthority>, session: ProjectionSession): void {
  const { projectionIntentDigest } = require("../../../src/kernel/projection/contracts") as typeof import("../../../src/kernel/projection/contracts")
  auth.setIntentDigest(projectionIntentDigest(session.intent))
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
      filesystemPolicyDigest: "d".repeat(64),
      workspaceHostRoot: session.mergedDir,
    },
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

describe("AK2-R4 反例（R4-00 先红冻结）", () => {
  test("R4-00-1：production backend + allowFixtureExecution:true + receiptless 仍可 commit（boolean bypass 必须删除）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx, { backend: productionKindBackend(), allowFixtureExecution: true })
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    // receiptless + production backend：即使 allowFixtureExecution=true 也
    // 绝不允许 commit —— 该 boolean bypass 必须完全删除（R4-01）。
    try {
      coord.commit(session)
      throw new Error("R4-00-1 RED: production backend committed receiptless with allowFixtureExecution=true")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_REQUIRED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  describe("R4-00-2：Bubblewrap /workspace 受控视图", () => {
    const caps = probeLinuxCapabilities()
    const wt = "/tmp/wt-r4"
    const spec = {
      schemaVersion: "1.0",
      identity: { cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1 },
      command: { executable: "/bin/true", args: [], cwd: `${wt}/src`, stdin: "closed" },
      profile: "build",
      isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: false },
      filesystem: {
        readonlyMounts: [{ source: `${wt}/docs`, target: "/workspace/docs", mode: "ro", required: true, recursive: true }],
        writableMounts: [{ source: `${wt}/src`, target: "/workspace/src", mode: "rw", required: true, recursive: true }],
        tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: wt,
      },
      network: { mode: "none" },
      environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
      secrets: [],
      resources: { memoryMaxBytes: 1024, pidsMax: 128, wallTimeMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
      cache: [],
      lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
      policyDigest: "",
    } as never
    const mountArgs = (argv: string[]): Array<{ flag: string; source: string; target: string }> => {
      const mounts: Array<{ flag: string; source: string; target: string }> = []
      for (let index = 0; index < argv.length; index++) {
        const flag = argv[index]!
        if (flag === "--bind" || flag === "--ro-bind") {
          mounts.push({ flag, source: argv[index + 1]!, target: argv[index + 2]! })
        }
      }
      return mounts
    }

    test("R4-00-2a：整个 worktree 不得 RW bind 到 /workspace（unscoped path 不得可读/可写）", () => {
      const argv = compileBwrapArgv(spec, caps, {
        worktreeRoot: wt,
        extraReadonly: [{ source: `${wt}/docs`, target: "/workspace/docs", mode: "ro", required: true, recursive: true }],
        extraWritable: [{ source: `${wt}/src`, target: "/workspace/src", mode: "rw", required: true, recursive: true }],
      })
      for (const mount of mountArgs(argv)) {
        if (mount.target === "/workspace") {
          throw new Error(
            `R4-00-2a RED: ${mount.flag} ${mount.source} /workspace exposes the whole worktree (unscoped paths readable+writable)`,
          )
        }
      }
    })

    test("R4-00-2b：不得存在覆盖 readonly root 的更宽 RW ancestor mount", () => {
      const argv = compileBwrapArgv(spec, caps, {
        worktreeRoot: wt,
        extraReadonly: [{ source: `${wt}/docs`, target: "/workspace/docs", mode: "ro", required: true, recursive: true }],
        extraWritable: [{ source: `${wt}/src`, target: "/workspace/src", mode: "rw", required: true, recursive: true }],
      })
      const mounts = mountArgs(argv)
      for (const rw of mounts.filter(m => m.flag === "--bind")) {
        for (const ro of mounts.filter(m => m.flag === "--ro-bind")) {
          if (ro.target === rw.target || ro.target.startsWith(rw.target.replace(/\/$/, "") + "/")) {
            throw new Error(
              `R4-00-2b RED: rw bind ${rw.source} -> ${rw.target} is a broader RW ancestor of ro bind ${ro.target} (readonly root writable alias)`,
            )
          }
        }
      }
    })

    test("R4-00-2c：unscoped workspace 路径不得被任何 mount target 覆盖（不可达）", () => {
      const argv = compileBwrapArgv(spec, caps, {
        worktreeRoot: wt,
        extraReadonly: [{ source: `${wt}/docs`, target: "/workspace/docs", mode: "ro", required: true, recursive: true }],
        extraWritable: [{ source: `${wt}/src`, target: "/workspace/src", mode: "rw", required: true, recursive: true }],
      })
      const targets = mountArgs(argv).map(m => m.target)
      // unscoped：/workspace/package.json（不在 src/docs 声明内）→ 不可达。
      const unscoped = "/workspace/package.json"
      for (const target of targets) {
        if (unscoped === target || unscoped.startsWith(target.replace(/\/$/, "") + "/")) {
          throw new Error(`R4-00-2c RED: unscoped path ${unscoped} is covered by mount target ${target}`)
        }
      }
    })

    test("R4-00-2d：command cwd 位于未声明路径时 compile 必须拒绝（cwd 必须在受控视图内）", () => {
      const backend = createBubblewrapBackend()
      const wtDir = tmpRoot("bwrap-cwd")
      mkdirSync(join(wtDir, "src"), { recursive: true })
      mkdirSync(join(wtDir, "docs"), { recursive: true })
      mkdirSync(join(wtDir, "unscoped"), { recursive: true })
      // cwd 在未声明的 unscoped 目录内：编译必须 fail-closed。
      const badSpec = {
        ...spec,
        command: { executable: "/bin/true", args: [], cwd: join(wtDir, "unscoped"), stdin: "closed" },
        filesystem: {
          readonlyMounts: [{ source: join(wtDir, "docs"), target: "/workspace/docs", mode: "ro", required: true, recursive: true }],
          writableMounts: [{ source: join(wtDir, "src"), target: "/workspace/src", mode: "rw", required: true, recursive: true }],
          tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: wtDir,
        },
      } as never
      let compileError: unknown
      try {
        backend.compile(badSpec, caps)
      } catch (error) {
        compileError = error
      }
      expect(compileError).toBeDefined()
      expect(String((compileError as Error).message)).toMatch(/WORKSPACE|workspace|cwd/i)
    })
  })

  describe("R4-00-3：adapter pre-spawn intent/scope/workspace 绑定", () => {
    function mergedDir(label: string): string {
      const dir = tmpRoot(`adapter-${label}`)
      mkdirSync(join(dir, "src"), { recursive: true })
      mkdirSync(join(dir, "docs"), { recursive: true })
      return dir
    }

    function brokerExecutor(merged: string, roots: { writable: string[]; readonly: string[] }) {
      const registry = new WorkspaceAuthorityRegistry()
      const workspace = registry.registerAgentWorktree({
        projectId: "ak2-r4",
        hostRoot: merged,
        access: "readwrite",
        ownerFiles: [merged],
      })
      return new LinuxBrokerProjectionExecutor({
        broker: createLinuxBroker({ mode: "enabled" }),
        authority: { identity: { runId: `run-${process.pid}`, nodeRunId: `run-${process.pid}:n1`, attempt: 1 }, workspace },
        writableRoots: roots.writable,
        readonlyRoots: roots.readonly,
        profile: "build",
      })
    }

    test("R4-00-3：intent command A 但 adapter 实际执行 command B → spawn 前拒绝", async () => {
      const merged = mergedDir("cmd")
      const executor = brokerExecutor(merged, { writable: ["src"], readonly: ["docs"] })
      const mergedStat = lstatSync(merged)
      const intent = {
        intentId: "intent-r4-cmd",
        worldId: "world-c",
        branchId: "branch-main",
        snapshotId: "snapshot:1",
        projectionId: "proj-r4",
        sessionNonce: "nonce",
        mergedRootIdentity: { dev: mergedStat.dev, ino: mergedStat.ino },
        command: { executable: "/bin/echo", args: ["intended"] },
        scopeDigest: sha256Digest(Buffer.from(canonicalJson({ writableRoots: ["src"], readonlyRoots: ["docs"] }), "utf8")),
      }
      // intent 声明 executable=/bin/echo args=[intended]；实际请求执行
      // /bin/echo [actual] —— adapter 必须 spawn 前拒绝（binding 冲突）。
      await expect(
        executor.execute(merged, {
          executable: "/bin/echo",
          args: ["actual"],
          intent: intent as never,
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_RECEIPT_BINDING_MISMATCH" })
    })

    test("R4-00-3b：adapter roots ≠ intent scope → spawn 前拒绝（scopeDigest 参与验证）", async () => {
      const merged = mergedDir("scope")
      const executor = brokerExecutor(merged, { writable: ["other-root"], readonly: ["docs"] })
      const mergedStat = lstatSync(merged)
      const intent = {
        intentId: "intent-r4-scope",
        worldId: "world-c",
        branchId: "branch-main",
        snapshotId: "snapshot:1",
        projectionId: "proj-r4",
        sessionNonce: "nonce",
        mergedRootIdentity: { dev: mergedStat.dev, ino: mergedStat.ino },
        command: { executable: "/bin/true", args: [] },
        // intent scope 声明 src（kernel-owned）；adapter 配置的是 other-root。
        scopeDigest: sha256Digest(Buffer.from(canonicalJson({ writableRoots: ["src"], readonlyRoots: ["docs"] }), "utf8")),
      }
      await expect(
        executor.execute(merged, {
          executable: "/bin/true",
          args: [],
          intent: intent as never,
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_RECEIPT_BINDING_MISMATCH" })
    })

    test("R4-00-3c：adapter workspace dev/ino ≠ intent.mergedRootIdentity → spawn 前拒绝", async () => {
      const merged = mergedDir("wsid")
      const executor = brokerExecutor(merged, { writable: ["src"], readonly: ["docs"] })
      const intent = {
        intentId: "intent-r4-wsid",
        worldId: "world-c",
        branchId: "branch-main",
        snapshotId: "snapshot:1",
        projectionId: "proj-r4",
        sessionNonce: "nonce",
        // 伪造的 mergedRootIdentity（与实际 merged dev/ino 不同）。
        mergedRootIdentity: { dev: 1, ino: 2 },
        command: { executable: "/bin/true", args: [] },
        scopeDigest: sha256Digest(Buffer.from(canonicalJson({ writableRoots: ["src"], readonlyRoots: ["docs"] }), "utf8")),
      }
      await expect(
        executor.execute(merged, {
          executable: "/bin/true",
          args: [],
          intent: intent as never,
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_RECEIPT_BINDING_MISMATCH" })
    })
  })

  test("R4-00-5：receipt 存在 signal/oomKilled/pidLimitHit/outputLimitHit/tempLimitHit 时不得作为成功执行提交", async () => {
    for (const overrides of [
      { signal: "SIGKILL" },
      { oomKilled: true },
      { pidLimitHit: true },
      { outputLimitHit: true },
      { tempLimitHit: true },
    ]) {
      const { ctx, snapshotId } = buildWorld()
      const auth = fakeAuthority(overrides as Partial<SandboxReceipt>)
      const coord = coordinator(ctx, { backend: new CopyProjectionFixtureBackend(), fixtureExecutionToken: Symbol("r4-token"), receiptAuthority: auth })
      const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
      bindIntent(auth, session)
      bindOutcome(session, auth)
      try {
        coord.commit(session)
        throw new Error(`R4-00-5 RED: receipt with ${Object.keys(overrides)[0]} accepted as success`)
      } catch (error) {
        expect((error as ProjectionError).code).toMatch(/EXECUTION_RECEIPT_BINDING_MISMATCH|EXECUTION_RECEIPT_REPLAY/)
      }
      expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
      ctx.cleanup()
    }
  })

  test("R4-00-6：execute 前 mount ownership 丢失 → 必须进入终态（REJECTED + cleanupState + terminal receipt）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx, { backend: productionKindBackend({ assertMountOwned: () => false }) })
    const session = coord.start(makePlan(snapshotId))
    try {
      await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(() => {}))
      throw new Error("R4-00-6 RED: execute did not refuse after ownership loss")
    } catch {
      // execute 前 ownership 复核失败 → 必须 terminalize（不是裸 throw）。
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.cleanupState).toBeDefined()
    expect(session.receipt).toBeDefined()
    expect(session.receipt!.worldState).toBe("REJECTED")
    ctx.cleanup()
  })

  test("R4-00-7：production scan 缺少 finalized receipt/cleanup proof 时必须拒绝（不能跳过）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, { backend: productionKindBackend(), receiptAuthority: auth })
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(() => {}))
    // production backend + 无 receipt/cleanup proof → scan 必须拒绝。
    try {
      coord.scan(session)
      throw new Error("R4-00-7 RED: production scan proceeded without finalized receipt/cleanup proof")
    } catch (error) {
      expect((error as ProjectionError).code).toMatch(/PROJECTION_NOT_PROJECTED|EXECUTION_RECEIPT/)
    }
    expect(session.worldState).toBe("REJECTED")
    ctx.cleanup()
  })

  test("R4-00-8：projection root 在外层 lstat 后、fd open 前被替换 → cleanup 不得修改替换目录", async () => {
    const { ctx, snapshotId } = buildWorld()
    let swapped = false
    const coord = coordinator(ctx, {
      backend: new CopyProjectionFixtureBackend(),
      fixtureExecutionToken: Symbol("r4-token"),
      onBeforeProjectionRootOpen: (root: string) => {
        if (swapped) return
        swapped = true
        // 在 lstat 验证后、open 前替换 root 路径为另一目录（含 sentinel）。
        renameSync(root, `${root}.old`)
        mkdirSync(root, { mode: 0o700 })
        writeFileSync(join(root, "sentinel.txt"), "SENTINEL")
      },
    })
    const session = coord.start(makePlan(snapshotId))
    coord.cancel(session)
    expect(swapped).toBe(true)
    // 替换目录必须原样保留（cleanup 不得 chmod/删除其中的 sentinel）。
    expect(readFileSync(join(session.projectionRoot, "sentinel.txt"), "utf8")).toBe("SENTINEL")
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
    // fake fusermount3/fusermount：exit 0 但不卸载（unmount 报告成功 ≠ 已卸载）。
    const fakeBin = join(root, "fakebin")
    mkdirSync(fakeBin, { mode: 0o755 })
    writeFileSync(join(fakeBin, "fusermount3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(fakeBin, "fusermount"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const backend = new FuseOverlayfsProjectionBackend()
    let threw = false
    const originalPath = process.env.PATH
    // fake fusermount3 必须优先于真实 binary（unmount 报告成功 ≠ 已卸载）。
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`
    try {
      backend.create({ lowerDir: lower, projectionRoot: root, label: "m" })
    } catch {
      threw = true
    } finally {
      process.env.PATH = originalPath
    }
    expect(threw).toBe(true)
    const merged = join(root, "merged-m")
    const { statfsSync } = require("node:fs") as typeof import("node:fs")
    // merged 仍挂载（mount 真实存在）—— create 失败路径不得递归删除其内容、
    // 不得删除挂载的 backing store（upper/work residue 保留）。
    expect(statfsSync(merged).type).toBe(0x65735546)
    expect(existsSync(join(root, "upper-m"))).toBe(true)
    expect(existsSync(join(root, "work-m"))).toBe(true)
    expect(readFileSync(join(merged, "marker.txt"), "utf8")).toBe("MARKER")
    // 清理：真实 fusermount3 卸载（fake 只是测试诱饵）。
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
    try {
      execFileSync("/usr/bin/fusermount3", ["-u", merged], { stdio: "ignore" })
    } catch {
      execFileSync("fusermount3", ["-u", merged], { stdio: "ignore" })
    }
  })

  describe("R4-00-11：scanner final verification 期间写入必须被拒绝（sealed view）或 fail-closed", () => {
    const caps = probeLinuxCapabilities()
    const realAvailable = (() => {
      try {
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
        execFileSync("fuse-overlayfs", ["--version"], { stdio: "ignore" })
        return true
      } catch {
        return false
      }
    })()

    async function runScanWithFinalWrite(attempt: (merged: string) => void): Promise<{ writeRejected: boolean; scanFailed: boolean }> {
      const root = tmpRoot("seal")
      const backend = new FuseOverlayfsProjectionBackend()
      const { ctx, snapshotId } = buildWorld()
      const materializer = new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: digest => ctx.store.cas.get(digest),
      })
      let mergedDir = ""
      let writeRejected = false
      const coord = new ProjectionCoordinator({
        store: ctx.store,
        materializer,
        backend,
        projectionRoot: root,
        onFinalVerifyAfter: (rootPath: string) => {
          if (rootPath !== mergedDir) return
          try {
            attempt(mergedDir)
          } catch {
            writeRejected = true
          }
        },
      })
      const session = coord.start(makePlan(snapshotId))
      mergedDir = session.mergedDir
      await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(merged => {
        writeFileSync(join(merged, "src/main.ts"), "changed\n")
      }))
      let scanFailed = false
      try {
        coord.scan(session)
      } catch {
        scanFailed = true
      }
      return { writeRejected, scanFailed }
    }

    test("R4-00-11a：final verification 期间新增 sibling → 写入必须被拒绝或 scan fail-closed", async () => {
      if (!realAvailable) return
      const result = await runScanWithFinalWrite(merged => {
        writeFileSync(join(merged, "new-sibling.txt"), "LATE")
      })
      // 写入被拒绝（sealed）或 scanner fail-closed —— 二者必须至少发生其一。
      expect(result.writeRejected || result.scanFailed).toBe(true)
    })

    test("R4-00-11b：final verification 期间修改已验证文件 → 写入必须被拒绝或 scan fail-closed", async () => {
      if (!realAvailable) return
      const result = await runScanWithFinalWrite(merged => {
        writeFileSync(join(merged, "src/main.ts"), "tampered-late\n")
      })
      expect(result.writeRejected || result.scanFailed).toBe(true)
    })

    test("R4-00-11c：final verification 期间删除目录 → 必须被拒绝或 scan fail-closed", async () => {
      if (!realAvailable) return
      const result = await runScanWithFinalWrite(merged => {
        // fuse-overlayfs 的目录 rename 会 EXDEV（天然拒绝）—— 这里用真实
        // 删除操作（rmSync 递归删除 src 目录）。
        rmSync(join(merged, "src"), { recursive: true, force: true })
      })
      expect(result.writeRejected || result.scanFailed).toBe(true)
    })
  })

  test("R4-00-12：FileManifest JSON 很小但 logical file 很大 → 累计 tree budget 必须在 chunk read/write 前拒绝", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w-bud", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const a1 = ctx.store.cas.put(Buffer.alloc(1024 * 1024, 65), "application/octet-stream").digest
    const a2 = ctx.store.cas.put(Buffer.alloc(512 * 1024, 66), "application/octet-stream").digest
    const b1 = ctx.store.cas.put(Buffer.alloc(1024 * 1024, 67), "application/octet-stream").digest
    const b2 = ctx.store.cas.put(Buffer.alloc(512 * 1024, 68), "application/octet-stream").digest
    const fmA = { schemaVersion: 1, type: "file", mediaType: "text/plain", size: 1536 * 1024, chunks: [{ digest: a1, offset: 0, size: 1024 * 1024 }, { digest: a2, offset: 1024 * 1024, size: 512 * 1024 }] }
    const fmB = { schemaVersion: 1, type: "file", mediaType: "text/plain", size: 1536 * 1024, chunks: [{ digest: b1, offset: 0, size: 1024 * 1024 }, { digest: b2, offset: 1024 * 1024, size: 512 * 1024 }] }
    const fmBytesA = Buffer.from(canonicalJson(fmA), "utf8")
    const fmBytesB = Buffer.from(canonicalJson(fmB), "utf8")
    const fmRecA = ctx.store.cas.putManifest(fmBytesA, [a1, a2])
    const fmRecB = ctx.store.cas.putManifest(fmBytesB, [b1, b2])
    const fakeSnapshot = {
      snapshotId: "snapshot:bud", worldId: "w-bud", branchId: "b", revision: 0n,
      manifestDigest: "sha256:1" as CasDigest, filesystemDigest: "sha256:2" as CasDigest,
      memoryDigest: "sha256:3" as CasDigest, taskStateDigest: "sha256:4" as CasDigest,
      capabilityStateDigest: "sha256:5" as CasDigest, serviceStateDigest: "sha256:6" as CasDigest,
      artifactStateDigest: "sha256:7" as CasDigest, createdAt: 1,
    }
    const worldManifest = canonicalJson({
      schemaVersion: 1, type: "world", worldId: "w-bud", branchId: "b", revision: "0", worldStatus: "active",
      rootObjectId: "root", filesystemDigest: "sha256:2", memoryDigest: "sha256:3", taskStateDigest: "sha256:4",
      capabilityStateDigest: "sha256:5", serviceStateDigest: "sha256:6", artifactStateDigest: "sha256:7",
    })
    const sectionManifest = canonicalJson({
      schemaVersion: 1, type: "world-section", section: "filesystem",
      entries: [
        { id: "FA", kind: "file", path: "big-a.bin", contentRef: fmRecA.digest },
        { id: "FB", kind: "file", path: "big-b.bin", contentRef: fmRecB.digest },
      ],
    })
    let readsB = 0
    const materializer = new SnapshotMaterializer({
      getSnapshot: () => fakeSnapshot as never,
      getCasRecord: (digest: CasDigest) => {
        if (/^sha256:[1-7]$/.test(digest) || digest === fmRecA.digest || digest === fmRecB.digest) {
          return {
            digest,
            size: digest === "sha256:1" ? Buffer.byteLength(worldManifest) : digest === "sha256:2" ? Buffer.byteLength(sectionManifest) : digest === fmRecA.digest ? fmBytesA.byteLength : fmBytesB.byteLength,
            mediaType: "application/vnd.orcana.manifest+json", mediaTypes: [], isManifest: true, createdAt: 0, refCount: 0,
          }
        }
        if (digest === a1 || digest === a2) return { digest, size: digest === a1 ? 1024 * 1024 : 512 * 1024, mediaType: "application/octet-stream", mediaTypes: [], isManifest: false, createdAt: 0, refCount: 0 }
        if (digest === b1 || digest === b2) return { digest, size: digest === b1 ? 1024 * 1024 : 512 * 1024, mediaType: "application/octet-stream", mediaTypes: [], isManifest: false, createdAt: 0, refCount: 0 }
        return undefined
      },
      readCasObject: (digest: CasDigest) => {
        if (digest === "sha256:1") return Buffer.from(worldManifest)
        if (digest === "sha256:2") return Buffer.from(sectionManifest)
        if (digest === fmRecA.digest) return Buffer.from(fmBytesA)
        if (digest === fmRecB.digest) return Buffer.from(fmBytesB)
        if (digest === b1 || digest === b2) {
          readsB++
          return ctx.store.cas.get(digest)
        }
        return ctx.store.cas.get(digest)
      },
    }, { maxDepth: 64, maxEntries: 100, maxFileBytes: 2 * 1024 * 1024, maxTreeBytes: 2 * 1024 * 1024, maxFileChunks: 100, maxManifestBytes: 1024 * 1024, maxMetadataBytes: 1024 })
    const base = join(tmpRoot("bud"), "base")
    mkdirSync(base)
    let code = ""
    try {
      materializer.materialize("snapshot:bud", base)
    } catch (error) {
      code = (error as ProjectionError).code
    }
    // 必须 PROJECTION_RESOURCE_LIMIT 且第二个文件的 chunk 从未被读取
    //（拒绝发生在 chunk read/write 之前）。
    expect(code).toBe("PROJECTION_RESOURCE_LIMIT")
    expect(readsB).toBe(0)
    ctx.cleanup()
  })
})
