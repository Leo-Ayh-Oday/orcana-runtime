/** LR2-7（P7-E）Gate 验收：8 项 LR2-7 Gate，每项一条验收测试。
 *
 *  WORKER_HOLDS_COMPLETION_AUTHORITY    = 0
 *  UNSIGNED_RECEIPT_ACCEPTED            = 0
 *  RECEIPT_ASSIGNMENT_MISMATCH          = 0
 *  SECRET_VALUE_LEAK_IN_PLAN            = 0
 *  CELLPLAN_TAMPER_ACCEPTED             = 0
 *  UNMATCHED_CAPABILITY_ASSIGNMENT      = 0
 *  LEASE_FENCING_ABSENT                 = 0
 *  ARTIFACT_DIGEST_UNVERIFIED           = 0
 */

import { describe, test, expect } from "bun:test"
import { ed25519 } from "../../src/remote/wire"
import { cellPlanSigner, validateCellPlanShape, CELLPLAN_SCHEMA_VERSION, type RemoteCellPlan } from "../../src/remote/cellplan"
import { RemoteCoordinator, createCoordinatorKeypair } from "../../src/remote/coordinator"
import { RemoteWorker, verifyArtifactDigest } from "../../src/remote/worker"

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

describe("LR2-7 Gates", () => {
  test("WORKER_HOLDS_COMPLETION_AUTHORITY = 0: worker receipt carries no completion judgment", async () => {
    const coord = createCoordinatorKeypair()
    const w = new RemoteWorker({ workerId: "w1", capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", privateKeyPem: ed25519.generate().privateKeyPem })
    const signed = cellPlanSigner.signPlan(basePlan(), coord.privateKeyPem)
    const res = await w.execute(signed, "asg-1")
    if (!res.ok) throw new Error("execute failed")
    // 收据只含观测事实：无完成/证据绑定/晋升判断
    expect(res.receipt.exitCode).toBe(0)
    expect("completionAuthority" in res.receipt).toBe(false)
    expect("evidenceBound" in res.receipt).toBe(false)
    expect("promoted" in res.receipt).toBe(false)
  })

  test("UNSIGNED_RECEIPT_ACCEPTED = 0: empty signature rejected by coordinator", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const v = c.verifyReceipt({
      receiptId: "r1", assignmentId: asg.assignment.assignmentId, workerId: "w1",
      exitCode: 0, observed: { metrics: {}, writes: [] }, signature: "",
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("UNSIGNED_RECEIPT")
  })

  test("RECEIPT_ASSIGNMENT_MISMATCH = 0: receipt for another assignment rejected", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    c.assign(basePlan(), "run_process")
    const { sign, createPrivateKey } = require("node:crypto") as typeof import("node:crypto")
    const { receiptDigest } = require("../../src/remote/coordinator") as typeof import("../../src/remote/coordinator")
    const base = { receiptId: "r2", assignmentId: "asg-nonexistent", workerId: "w1", exitCode: 0, observed: { metrics: {}, writes: [] } }
    const sig = sign(null, Buffer.from(receiptDigest(base), "utf8"), createPrivateKey(workerKey.privateKeyPem)).toString("hex")
    const v = c.verifyReceipt({ ...base, signature: sig })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("RECEIPT_ASSIGNMENT_MISMATCH")
  })

  test("SECRET_VALUE_LEAK_IN_PLAN = 0: secret-looking env key rejected at plan shape validation", () => {
    const v = validateCellPlanShape(basePlan({ environment: { API_KEY: "sk-123" } }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join()).toContain("secret")
    // 合法路径：走 secretHandles（值不外传）
    const ok = validateCellPlanShape(basePlan({ secretHandles: [{ handleId: "h1", purpose: "api" }] }))
    expect(ok.ok).toBe(true)
  })

  test("CELLPLAN_TAMPER_ACCEPTED = 0: worker rejects tampered plan", () => {
    const coord = createCoordinatorKeypair()
    const w = new RemoteWorker({ workerId: "w1", capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", privateKeyPem: ed25519.generate().privateKeyPem })
    const signed = cellPlanSigner.signPlan(basePlan(), coord.privateKeyPem)
    signed.executable = "/bin/rm"
    signed.args = ["-rf", "/"]
    expect(w.verifyPlan(signed, coord.publicKeyPem).ok).toBe(false)
  })

  test("UNMATCHED_CAPABILITY_ASSIGNMENT = 0: coordinator never assigns without matching capability", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["git"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const sel = c.selectWorker("run_process")
    expect(sel.ok).toBe(false)
    const asg = c.assign(basePlan(), "run_process")
    expect(asg.ok).toBe(false)
  })

  test("LEASE_FENCING_ABSENT = 0: renew/cancel require matching fencing token", () => {
    const coord = createCoordinatorKeypair()
    const workerKey = ed25519.generate()
    const c = new RemoteCoordinator({ coordinatorId: "c1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("w1", workerKey.publicKeyPem, { capabilities: ["run_process"], runtimeVersion: "1.0", platform: "linux", status: "online" })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    expect(c.renewLease(asg.assignment.assignmentId, "forged", 1000).ok).toBe(false)
    expect(c.cancel(asg.assignment.assignmentId, "forged").ok).toBe(false)
    // 正确 token 可续期
    expect(c.renewLease(asg.assignment.assignmentId, asg.assignment.leaseToken, 1000).ok).toBe(true)
  })

  test("ARTIFACT_DIGEST_UNVERIFIED = 0: tampered artifact content detected", () => {
    const w = new RemoteWorker({ workerId: "w1", capabilities: [], runtimeVersion: "1.0", platform: "linux", privateKeyPem: ed25519.generate().privateKeyPem })
    const art = w.publishArtifact("report.json", '{"ok":true}')
    expect(verifyArtifactDigest(art.digest, '{"ok":true}').ok).toBe(true)
    expect(verifyArtifactDigest(art.digest, '{"ok":false}').ok).toBe(false)
  })
})
