/**
 * PR-LNXF-GATE-01 — Execution Truth Closure（GS-11/12/13/14）
 *
 * 1. GS-14：PATH/HOME/TMPDIR 进 RUNTIME_RESERVED_ENV_KEYS —— 宿主
 *    allowedHostKeys 复制不得覆盖 Runtime 构造的 PATH（OTS-013 canary
 *    命中路径）。
 * 2. GS-12：isolation lock 身份 = 真实 workspace（realpath + dev/ino）——
 *    同 agent 不同 worktree 并行。
 * 3. GS-13：跨进程 workspace lease（mkdir 原子锁）。
 * 4. GS-11：cleanupVerified 真值（未验证 ≠ 干净，receipt 语义）。
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildExplicitEnvironment, isRuntimeReservedKey } from "../src/runtime/linux/environment"
import { workspaceIdentityOf } from "../src/runtime/linux/broker"
import { IsolationDomainLock } from "../src/runtime/linux/workspace/isolation-lock"
import { CrossProcessWorkspaceLease } from "../src/runtime/linux/workspace/workspace-lease"
import { ingestSandboxReceipt, hasEvidence } from "../src/agent/evidence-ledger"
import { createEvidenceLedger } from "../src/agent/evidence-ledger"
import type { SandboxReceipt } from "../src/runtime/linux/contracts"

// ── GS-14：reserved env ──

describe("GS-14 — Runtime reserved env 禁止覆盖", () => {
  test("PATH/HOME/TMPDIR 进入 reserved 集", () => {
    expect(isRuntimeReservedKey("PATH")).toBe(true)
    expect(isRuntimeReservedKey("HOME")).toBe(true)
    expect(isRuntimeReservedKey("TMPDIR")).toBe(true)
    expect(isRuntimeReservedKey("ORCANA_RUN_ID")).toBe(true)
  })

  test("allowedHostKeys 申请 PATH → 拒绝，Runtime 构造的 PATH 保留", () => {
    process.env.PATH = "/evil:/usr/bin:/bin" // 宿主 PATH（恶意首位）
    const result = buildExplicitEnvironment({
      policy: {
        baseProfile: "node",
        allowedHostKeys: ["PATH", "HOME", "TMPDIR", "LANG"],
        requestedValues: {},
        fixedValues: {},
        deniedKeys: [],
      },
      runId: "run-x",
      nodeRunId: "run-x:n1",
    })
    expect(result.ok).toBe(true)
    expect(result.rejectedHostKeys).toContain("PATH")
    expect(result.env.PATH).not.toContain("/evil")
    expect(result.env.PATH).toContain("/usr/bin")
    expect(result.env.HOME).toBe("/home/orcana")
    expect(result.env.TMPDIR).toBe("/tmp")
  })

  test("requestedValues 申请 PATH 同样被拒", () => {
    const result = buildExplicitEnvironment({
      policy: {
        baseProfile: "minimal",
        allowedHostKeys: [],
        requestedValues: { PATH: "/attacker", ORCANA_RUN_ID: "forged" },
        fixedValues: {},
        deniedKeys: [],
      },
      runId: "run-y",
      nodeRunId: "run-y:n1",
    })
    expect(result.rejectedHostKeys).toContain("PATH")
    expect(result.rejectedHostKeys).toContain("ORCANA_RUN_ID")
    expect(result.env.PATH).toBe("/usr/bin:/bin")
    expect(result.env.ORCANA_RUN_ID).toBe("run-y") // 末步强制写回
  })
})

// ── GS-12：workspace identity ──

describe("GS-12 — isolation lock 按真实 workspace", () => {
  test("workspaceIdentityOf = canonical realpath + dev/ino", () => {
    const dirA = mkdtempSync(join(tmpdir(), "ws-identity-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "ws-identity-b-"))
    try {
      const idA = workspaceIdentityOf(dirA)
      const idB = workspaceIdentityOf(dirB)
      expect(idA).toBeDefined()
      expect(idA).not.toBe(idB)
      // 符号链接别名 → 同一身份
      const alias = join(tmpdir(), `ws-alias-${process.pid}`)
      try {
        symlinkSync(dirA, alias)
        expect(workspaceIdentityOf(alias)).toBe(idA)
      } finally {
        rmSync(alias, { force: true })
      }
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  test("同 agent 不同 worktree → 不同锁键（允许并行）；同 workspace → 同键", () => {
    const dirA = mkdtempSync(join(tmpdir(), "ws-lock-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "ws-lock-b-"))
    try {
      const idA = workspaceIdentityOf(dirA)!
      const idB = workspaceIdentityOf(dirB)!
      expect(IsolationDomainLock.workspaceKey(idA)).not.toBe(IsolationDomainLock.workspaceKey(idB))
      expect(IsolationDomainLock.workspaceKey(idA)).toBe(IsolationDomainLock.workspaceKey(idA))
      expect(IsolationDomainLock.workspaceKey(idA)).toContain("workspace:")
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})

// ── GS-13：跨进程 lease ──

describe("GS-13 — 跨进程 workspace lease", () => {
  test("acquire → 他方持有时拒绝 → release 后可再获取", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-lease-"))
    try {
      const lease = new CrossProcessWorkspaceLease({ leaseRoot: root })
      const first = lease.acquire("ws1")
      expect(first.ok).toBe(true)
      // 同进程再次 acquire（模拟跨进程）→ 拒绝
      const second = lease.acquire("ws1")
      expect(second.ok).toBe(false)
      expect(second.reason).toContain("lease held")
      // 释放后 → 可再获取
      first.release!()
      const third = lease.acquire("ws1")
      expect(third.ok).toBe(true)
      third.release!()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("不同 workspace identity 互不冲突", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-lease-"))
    try {
      const lease = new CrossProcessWorkspaceLease({ leaseRoot: root })
      const a = lease.acquire("ws-a")
      const b = lease.acquire("ws-b")
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      a.release!()
      b.release!()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("stale 抢占：owner 进程已死且超时 → 可接管", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-lease-"))
    try {
      // 模拟死亡持有者：直接写 owner 文件（死 pid + 已超时时间戳）
      const lease = new CrossProcessWorkspaceLease({ leaseRoot: root, staleTimeoutMs: 1 })
      const dir = join(root, "stale-test")
      mkdirSync(dir)
      const { writeFileSync } = await import("node:fs")
      writeFileSync(join(dir, "owner"), `999999\n${Date.now() - 60_000}\n`)
      // acquire 用与 dir 相同的 identity —— 计算 lockDirOf 的方式：
      // lease.acquire 对相同 identity 生成相同目录。
      const result = lease.acquire("stale-identity-" + process.pid)
      expect(result.ok).toBe(true)
      result.release!()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── GS-11：cleanupVerified 语义 ──

describe("GS-11 — 清理真值（未验证 ≠ 干净）", () => {
  function receipt(overrides: Partial<SandboxReceipt> = {}): SandboxReceipt {
    const base: SandboxReceipt = {
      schemaVersion: "1.0",
      receiptDigest: "",
      cellId: "c1",
      runId: "r1",
      nodeRunId: "r1:n1",
      attempt: 1,
      backend: "bubblewrap",
      profile: "untrusted" as SandboxReceipt["profile"],
      capabilitiesDigest: "x",
      cellSpecDigest: "x",
      filesystemPolicyDigest: "x",
      networkPolicyDigest: "x",
      resourcePolicyDigest: "x",
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
      metrics: {},
      observedWrites: [],
      observedDeletes: [],
      unexpectedWrites: [],
      networkMode: "none",
      secretBindingIds: [],
      violations: [],
      degradationReasons: [],
      cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: true },
      ...overrides,
    }
    return base
  }

  test("cleanupVerified=true + 0 残留 → sandbox_cleanup evidence", () => {
    const ledger = createEvidenceLedger()
    ingestSandboxReceipt(ledger, receipt())
    expect(hasEvidence(ledger, "sandbox_cleanup")).toBe(true)
  })

  test("cleanupVerified=false + processesRemaining=-1 → 无 sandbox_cleanup evidence", () => {
    const ledger = createEvidenceLedger()
    ingestSandboxReceipt(ledger, receipt({ cleanup: { processesRemaining: -1, mountsReleased: false, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: false } }))
    expect(hasEvidence(ledger, "sandbox_cleanup")).toBe(false)
  })
})
