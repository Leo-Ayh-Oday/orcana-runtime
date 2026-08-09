/** LR2-7（P7-C）验收：Coordinator。 */

import { describe, test, expect } from "bun:test"
import {
  RemoteCoordinator,
  createCoordinatorKeypair,
  receiptDigest,
  type RemoteReceipt,
} from "../../src/remote/coordinator"
import { CELLPLAN_SCHEMA_VERSION, type RemoteCellPlan } from "../../src/remote/cellplan"
import { ed25519 } from "../../src/remote/wire"

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

function setup() {
  const coord = createCoordinatorKeypair()
  const worker = ed25519.generate()
  const c = new RemoteCoordinator({ coordinatorId: "coord-1", privateKeyPem: coord.privateKeyPem })
  const reg = c.registerWorker("worker-1", worker.publicKeyPem, {
    capabilities: ["run_process", "git"],
    runtimeVersion: "1.0",
    platform: "linux",
    status: "online",
  })
  expect(reg.ok).toBe(true)
  return { coord, worker, c }
}

function signReceipt(receipt: Omit<RemoteReceipt, "signature">, workerPrivateKeyPem: string): RemoteReceipt {
  const { sign, createPrivateKey } = require("node:crypto") as typeof import("node:crypto")
  const signature = sign(null, Buffer.from(receiptDigest(receipt), "utf8"), createPrivateKey(workerPrivateKeyPem)).toString("hex")
  return { ...receipt, signature }
}

describe("P7-C: RemoteCoordinator", () => {
  test("register + select + assign happy path", () => {
    const { c } = setup()
    const sel = c.selectWorker("run_process")
    expect(sel.ok).toBe(true)
    if (!sel.ok) return
    expect(sel.worker.workerId).toBe("worker-1")
    const asg = c.assign(basePlan(), "run_process")
    expect(asg.ok).toBe(true)
    if (!asg.ok) return
    expect(asg.assignment.leaseToken).toContain("fence-")
    expect(asg.assignment.plan.signature).toHaveLength(128)
    // worker 转 busy
    expect(c.getWorker("worker-1")?.capabilities.status).toBe("busy")
  })

  test("UNMATCHED_CAPABILITY_ASSIGNMENT: no capability → no assignment", () => {
    const { c } = setup()
    const sel = c.selectWorker("python")
    expect(sel.ok).toBe(false)
    if (!sel.ok) expect(sel.reason).toContain("no online worker")
  })

  test("busy worker not selected (no double assignment)", () => {
    const { c } = setup()
    const a1 = c.assign(basePlan({ planId: "p1" }), "run_process")
    expect(a1.ok).toBe(true)
    const a2 = c.assign(basePlan({ planId: "p2" }), "run_process")
    expect(a2.ok).toBe(false)
  })

  test("LEASE_FENCING_ABSENT: wrong token cannot renew or cancel", () => {
    const { c } = setup()
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    expect(c.renewLease(asg.assignment.assignmentId, "wrong-token", 1000).ok).toBe(false)
    expect(c.cancel(asg.assignment.assignmentId, "wrong-token").ok).toBe(false)
    // 正确 token 有效
    expect(c.renewLease(asg.assignment.assignmentId, asg.assignment.leaseToken, 1000).ok).toBe(true)
    expect(c.cancel(asg.assignment.assignmentId, asg.assignment.leaseToken).ok).toBe(true)
  })

  test("verified receipt releases worker; completion is NOT granted by coordinator", () => {
    const { c, worker } = setup()
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const receipt = signReceipt({
      receiptId: "r-1",
      assignmentId: asg.assignment.assignmentId,
      workerId: "worker-1",
      exitCode: 0,
      observed: { cgroupRemoved: true, metrics: { cpuUsec: 10 }, writes: [] },
    }, worker.privateKeyPem)
    const v = c.verifyReceipt(receipt)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.reason).toContain("Graph")
    // worker 释放回 online
    expect(c.getWorker("worker-1")?.capabilities.status).toBe("online")
  })

  test("UNSIGNED_RECEIPT_ACCEPTED: missing signature rejected", () => {
    const { c } = setup()
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const v = c.verifyReceipt({
      receiptId: "r-2",
      assignmentId: asg.assignment.assignmentId,
      workerId: "worker-1",
      exitCode: 0,
      observed: { metrics: {}, writes: [] },
      signature: "",
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("UNSIGNED_RECEIPT")
  })

  test("RECEIPT_ASSIGNMENT_MISMATCH: receipt from another assignment rejected", () => {
    const { c, worker } = setup()
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const receipt = signReceipt({
      receiptId: "r-3",
      assignmentId: "asg-other", // 不存在的 assignment
      workerId: "worker-1",
      exitCode: 0,
      observed: { metrics: {}, writes: [] },
    }, worker.privateKeyPem)
    const v = c.verifyReceipt(receipt)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("RECEIPT_ASSIGNMENT_MISMATCH")
  })

  test("signature invalid: receipt signed by another worker rejected", () => {
    const { c } = setup()
    const impostor = ed25519.generate()
    const asg = c.assign(basePlan(), "run_process")
    if (!asg.ok) throw new Error("assign failed")
    const receipt = signReceipt({
      receiptId: "r-4",
      assignmentId: asg.assignment.assignmentId,
      workerId: "worker-1",
      exitCode: 0,
      observed: { metrics: {}, writes: [] },
    }, impostor.privateKeyPem) // 冒名 worker-1 但用别人私钥
    const v = c.verifyReceipt(receipt)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("SIGNATURE_INVALID")
  })

  test("unknown worker receipt rejected", () => {
    const { c, worker } = setup()
    const receipt = signReceipt({
      receiptId: "r-5",
      assignmentId: "asg-x",
      workerId: "ghost",
      exitCode: 0,
      observed: { metrics: {}, writes: [] },
    }, worker.privateKeyPem)
    const v = c.verifyReceipt(receipt)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe("WORKER_UNKNOWN")
  })

  test("heartbeat updates status", () => {
    const { c } = setup()
    expect(c.heartbeat("worker-1", "busy").ok).toBe(true)
    expect(c.getWorker("worker-1")?.capabilities.status).toBe("busy")
    expect(c.heartbeat("ghost", "online").ok).toBe(false)
  })
})
