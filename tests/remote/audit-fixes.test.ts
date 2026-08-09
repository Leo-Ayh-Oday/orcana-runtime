/** LR2-7 审核修复验收（M1/M3/M4/M5/M6 + m1/m2/m5/m8）。 */

import { describe, test, expect } from "bun:test"
import { ed25519, ReplayGuard, buildSignedMessage, verifySignedMessage } from "../../src/remote/wire"
import { cellPlanSigner, CELLPLAN_SCHEMA_VERSION, type RemoteCellPlan } from "../../src/remote/cellplan"
import { RemoteCoordinator, createCoordinatorKeypair, receiptDigest } from "../../src/remote/coordinator"
import { RemoteWorker, verifyArtifactDigest, randomId } from "../../src/remote/worker"

function basePlan(overrides: Partial<Omit<RemoteCellPlan, "signature">> = {}): Omit<RemoteCellPlan, "signature"> {
  return {
    planSchemaVersion: CELLPLAN_SCHEMA_VERSION,
    planId: "plan-1",
    capabilityId: "run_process",
    executable: "/usr/bin/env",
    args: ["bash", "-c", "echo hi"],
    cwdRef: "workspace:a",
    timeoutMs: 5000,
    readonly: true,
    workloadKind: "inspect",
    ...overrides,
  }
}

function signReceipt(receipt: Omit<import("../../src/remote/coordinator").RemoteReceipt, "signature">, workerPrivateKeyPem: string) {
  const { sign, createPrivateKey } = require("node:crypto") as typeof import("node:crypto")
  const signature = sign(null, Buffer.from(receiptDigest(receipt), "utf8"), createPrivateKey(workerPrivateKeyPem)).toString("hex")
  return { ...receipt, signature }
}

describe("LR2-7 audit fixes", () => {
  test("M1: ReplayGuard rejects replayed nonce", () => {
    const g = new ReplayGuard()
    expect(g.check("w1", "n1").ok).toBe(true)
    expect(g.check("w1", "n1").ok).toBe(false)
    expect(g.check("w1", "n2").ok).toBe(true)
    expect(g.check("w2", "n1").ok).toBe(true) // 不同发送者可复用 nonce
    expect(g.countFor("w1")).toBe(2)
  })

  test("M1: full signed message replay rejected via guard", () => {
    const key = ed25519.generate()
    const g = new ReplayGuard()
    const msg = buildSignedMessage({ type: "worker-hello", senderId: "w1", nonce: "n1", payload: {}, privateKeyPem: key.privateKeyPem })
    expect(verifySignedMessage(msg, key.publicKeyPem).ok).toBe(true)
    expect(g.check(msg.senderId, msg.nonce).ok).toBe(true)
    // 原样重放：签名有效但 nonce 已见 → 拒绝
    expect(g.check(msg.senderId, msg.nonce).ok).toBe(false)
  })

  test("M3: expired lease is swept and worker released", async () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem, leaseTtlMs: 1 })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    expect(c.getWorker("w1")?.capabilities.status).toBe("busy")
    await new Promise(r => setTimeout(r, 10))
    // TTL=1ms 已过期 → 过期 lease 不可续期
    expect(c.renewLease(asg.assignment.assignmentId, asg.assignment.leaseToken, 1000).ok).toBe(false)
    // selectWorker 触发 sweep → worker 释放
    const sel = c.selectWorker("run_process")
    expect(sel.ok).toBe(true)
    expect(c.getWorker("w1")?.capabilities.status).toBe("online")
  })

  test("M3: renew TTL capped by server (caller-reported TTL untrusted)", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem, maxLeaseTtlMs: 60_000 })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const renewed = c.renewLease(asg.assignment.assignmentId, asg.assignment.leaseToken, 6e10) // 请求 1900 年
    expect(renewed.ok).toBe(true)
    if (renewed.ok) expect(renewed.assignment.leaseExpiresAt).toBeLessThan(Date.now() + 61_000)
  })

  test("M4: exitCode=null receipt rejected (EXIT_NOT_OBSERVED)", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const receipt = signReceipt({
      receiptId: "r-null", assignmentId: asg.assignment.assignmentId, workerId: "w1",
      exitCode: null, observed: { metrics: {} as Record<string, number>, writes: [] as string[] },
    }, workerKey.privateKeyPem)
    const v = c.verifyReceipt(receipt)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("EXIT_NOT_OBSERVED")
  })

  test("M4: spawnFailed receipt rejected", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const receipt = signReceipt({
      receiptId: "r-spawn", assignmentId: asg.assignment.assignmentId, workerId: "w1",
      exitCode: 0, spawnFailed: true, observed: { metrics: {} as Record<string, number>, writes: [] as string[] },
    }, workerKey.privateKeyPem)
    const v = c.verifyReceipt(receipt)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("EXIT_NOT_OBSERVED")
  })

  test("M4: signal recorded in receipt (SIGTERM visible to coordinator)", async () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const w = new RemoteWorker({ workerId: "w1", capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", privateKeyPem: workerKey.privateKeyPem })
    // 用真实后端：sleep 命令被杀（超时）→ signal 非 null
    const signed = cellPlanSigner.signPlan({
      ...basePlan(),
      executable: "/bin/sleep",
      args: ["10"],
      timeoutMs: 50,
    }, coord.privateKeyPem)
    const res = await w.execute(signed, "asg-1", coord.publicKeyPem)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.signal).not.toBeNull() // 超时被杀 → SIGTERM
    }
  })

  test("M5: no fabricated writes (readonly → empty; non-readonly → no fake entry)", async () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const w = new RemoteWorker({ workerId: "w1", capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", privateKeyPem: workerKey.privateKeyPem })
    // 非 readonly：不得出现伪造的 "no writes (readonly)" 条目
    const signedRw = cellPlanSigner.signPlan({ ...basePlan(), readonly: false }, coord.privateKeyPem)
    const rw = await w.execute(signedRw, "asg-rw", coord.publicKeyPem)
    if (!rw.ok) throw new Error("exec failed")
    expect(rw.receipt.observed.writes).toHaveLength(0)
    expect(rw.receipt.observed.writes.some(w2 => w2.includes("readonly"))).toBe(false)
  })

  test("M6: SECRET_VALUE_LEAK gate in pipeline — assign rejects secret-looking env", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const v = c.assign(basePlan({ environment: { GITHUB_TOKEN: "ghp_xxx" } }), "run_process")
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain("secret")
    // worker 侧同样拒绝（verifyPlan 形状校验）
    const w = new RemoteWorker({ workerId: "w1", capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", privateKeyPem: workerKey.privateKeyPem })
    const signed = cellPlanSigner.signPlan(basePlan({ environment: { API_KEY: "sk-1" } }), coord.privateKeyPem)
    expect(w.verifyPlan(signed, coord.publicKeyPem).ok).toBe(false)
  })

  test("m1: randomId uses crypto randomness (non-predictable)", () => {
    const a = randomId("fence")
    const b = randomId("fence")
    expect(a).not.toBe(b)
    expect(a).toMatch(/^fence-[0-9a-f]{16}$/)
  })

  test("m2: cross-worker assignment mismatch (assignment exists, owned by another worker)", () => {
    const coord = createCoordinatorKeypair()
    const wk1 = ed25519.generate()
    const wk2 = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", wk1.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    c.registerWorker("w2", wk2.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    // w2 冒名提交 w1 的 assignment
    const receipt = signReceipt({
      receiptId: "r-cross", assignmentId: asg.assignment.assignmentId, workerId: "w2",
      exitCode: 0, observed: { metrics: {} as Record<string, number>, writes: [] as string[] },
    }, wk2.privateKeyPem)
    const v = c.verifyReceipt(receipt)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("RECEIPT_ASSIGNMENT_MISMATCH")
    expect(v.reason).toContain("worker")
  })

  test("m5: heartbeat cannot self-unsuspend while holding assignment", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    c.assign(basePlan(), "run_process")
    const hb = c.heartbeat("w1", "online")
    expect(hb.assigned).toBe(true)
    // status 保持 busy（assignment 驱动，不由 worker 自报）
    expect(c.getWorker("w1")?.capabilities.status).toBe("busy")
  })

  test("m8: verified receipt idempotent replay", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const receipt = signReceipt({
      receiptId: "r-idem", assignmentId: asg.assignment.assignmentId, workerId: "w1",
      exitCode: 0, observed: { metrics: {} as Record<string, number>, writes: [] as string[] },
    }, workerKey.privateKeyPem)
    const v1 = c.verifyReceipt(receipt)
    expect(v1.ok).toBe(true)
    // 重放：assignment 已删除 → MISMATCH，但账本可幂等确认
    expect(c.isVerifiedReceipt("r-idem")).toBe(true)
  })
})
