/** LR2-7（P7-D）验收：RemoteWorker。 */

import { describe, test, expect } from "bun:test"
import {
  RemoteWorker,
  verifyArtifactDigest,
  workerReceiptDigest,
} from "../../src/remote/worker"
import { cellPlanSigner, CELLPLAN_SCHEMA_VERSION, type RemoteCellPlan } from "../../src/remote/cellplan"
import { ed25519 } from "../../src/remote/wire"
import { createCoordinatorKeypair, RemoteCoordinator, type RemoteReceipt } from "../../src/remote/coordinator"

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

function setup(workerCaps = ["run_process"]) {
  const coord = createCoordinatorKeypair()
  const workerKey = ed25519.generate()
  const w = new RemoteWorker({
    workerId: "worker-1",
    capabilities: workerCaps,
    runtimeVersion: "1.0",
    platform: "linux",
    privateKeyPem: workerKey.privateKeyPem,
  })
  return { coord, workerKey, w }
}

describe("P7-D: RemoteWorker", () => {
  test("capability declaration", () => {
    const { w } = setup()
    const decl = w.declareCapabilities()
    expect(decl.workerId).toBe("worker-1")
    expect(decl.capabilities).toContain("run_process")
    expect(decl.status).toBe("online")
  })

  test("verifyPlan: signed plan from coordinator accepted", () => {
    const { coord, w } = setup()
    const signed = cellPlanSigner.signPlan(basePlan(), coord.privateKeyPem)
    expect(w.verifyPlan(signed, coord.publicKeyPem).ok).toBe(true)
  })

  test("CELLPLAN_TAMPER_ACCEPTED: tampered plan rejected by worker", () => {
    const { coord, w } = setup()
    const signed = cellPlanSigner.signPlan(basePlan(), coord.privateKeyPem)
    signed.executable = "/bin/rm"
    expect(w.verifyPlan(signed, coord.publicKeyPem).ok).toBe(false)
  })

  test("UNMATCHED_CAPABILITY_ASSIGNMENT: worker rejects plan for capability it lacks", () => {
    const { coord, w } = setup(["git"]) // 无 run_process
    const signed = cellPlanSigner.signPlan(basePlan(), coord.privateKeyPem)
    const v = w.verifyPlan(signed, coord.publicKeyPem)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain("lacks capability")
  })

  test("execute produces signed receipt with real observations", async () => {
    const { coord, w, workerKey } = setup()
    const signed = cellPlanSigner.signPlan(basePlan(), coord.privateKeyPem)
    const res = await w.execute(signed, "asg-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.receipt.assignmentId).toBe("asg-1")
    expect(res.receipt.workerId).toBe("worker-1")
    expect(res.receipt.signature).toHaveLength(128)
    expect(res.receipt.exitCode).toBe(0)
    // 未观测字段不写假事实（函数执行器无 cgroup → undefined）
    expect(res.receipt.observed.cgroupRemoved).toBeUndefined()
    // 签名可验证
    const { verify, createPublicKey } = require("node:crypto") as typeof import("node:crypto")
    const digest = workerReceiptDigest(res.receipt)
    const ok = verify(null, Buffer.from(digest, "utf8"), createPublicKey(workerKey.publicKeyPem), Buffer.from(res.receipt.signature, "hex"))
    expect(ok).toBe(true)
  })

  test("WORKER_HOLDS_COMPLETION_AUTHORITY: receipt has no completion judgment, coordinator still verifies", async () => {
    const { coord, w } = setup()
    const signed = cellPlanSigner.signPlan(basePlan(), coord.privateKeyPem)
    const res = await w.execute(signed, "asg-1")
    if (!res.ok) throw new Error("execute failed")
    // 收据形状：无完成判断字段
    expect("completionAuthority" in res.receipt).toBe(false)
    expect("evidenceBound" in res.receipt).toBe(false)
  })

  test("full loop: coordinator assigns → worker verifies+executes → coordinator verifies receipt", async () => {
    const { coord, workerKey, w } = setup()
    const c = new RemoteCoordinator({ coordinatorId: "coord-1", privateKeyPem: coord.privateKeyPem })
    c.registerWorker("worker-1", workerKey.publicKeyPem, {
      capabilities: ["run_process"],
      runtimeVersion: "1.0",
      platform: "linux",
      status: "online",
    })
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    // worker 验证并执行
    expect(w.verifyPlan(asg.assignment.plan, coord.publicKeyPem).ok).toBe(true)
    const res = await w.execute(asg.assignment.plan, asg.assignment.assignmentId)
    if (!res.ok) throw new Error("execute failed")
    // worker 收据（线上形状）直接交给 coordinator 验证
    const v = c.verifyReceipt(res.receipt)
    expect(v.ok).toBe(true)
  })

  test("ARTIFACT_DIGEST_UNVERIFIED: publish + verify round-trip; tampered content detected", () => {
    const { w } = setup()
    const art = w.publishArtifact("build.log", "line1\nline2\n")
    expect(art.digest).toHaveLength(64)
    expect(verifyArtifactDigest(art.digest, "line1\nline2\n").ok).toBe(true)
    expect(verifyArtifactDigest(art.digest, "line1\nline2\nline3\n").ok).toBe(false)
  })
})
