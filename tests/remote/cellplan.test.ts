/** LR2-7（P7-B）验收：RemoteCellPlan + 签名/验证。 */

import { describe, test, expect } from "bun:test"
import {
  cellPlanSigner,
  cellplanPayloadDigest,
  validateCellPlanShape,
  CELLPLAN_SCHEMA_VERSION,
  type RemoteCellPlan,
} from "../../src/remote/cellplan"
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
    secretHandles: [{ handleId: "h1", purpose: "git-token" }],
    environment: { PATH: "/usr/bin:/bin" },
    ...overrides,
  }
}

describe("P7-B: RemoteCellPlan", () => {
  const key = ed25519.generate()

  test("sign/verify round-trip", () => {
    const signed = cellPlanSigner.signPlan(basePlan(), key.privateKeyPem)
    expect(signed.signature).toHaveLength(128) // ed25519 sig hex
    const v = cellPlanSigner.verifyPlan(signed, key.publicKeyPem)
    expect(v.ok).toBe(true)
  })

  test("CELLPLAN_TAMPER_ACCEPTED: tampered executable → verification fails", () => {
    const signed = cellPlanSigner.signPlan(basePlan(), key.privateKeyPem)
    signed.executable = "/bin/rm"
    const v = cellPlanSigner.verifyPlan(signed, key.publicKeyPem)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("invalid")
  })

  test("tampered secretHandles → verification fails", () => {
    const signed = cellPlanSigner.signPlan(basePlan(), key.privateKeyPem)
    signed.secretHandles = [{ handleId: "evil", purpose: "steal" }]
    expect(cellPlanSigner.verifyPlan(signed, key.publicKeyPem).ok).toBe(false)
  })

  test("wrong key → verification fails", () => {
    const other = ed25519.generate()
    const signed = cellPlanSigner.signPlan(basePlan(), other.privateKeyPem)
    expect(cellPlanSigner.verifyPlan(signed, key.publicKeyPem).ok).toBe(false)
  })

  test("schema version mismatch rejected", () => {
    const signed = cellPlanSigner.signPlan(basePlan(), key.privateKeyPem)
    signed.planSchemaVersion = "0.9"
    expect(cellPlanSigner.verifyPlan(signed, key.publicKeyPem).ok).toBe(false)
  })

  test("payload digest is deterministic", () => {
    const a = cellplanPayloadDigest(basePlan())
    const b = cellplanPayloadDigest(basePlan())
    expect(a).toHaveLength(64)
    expect(a).toBe(b)
  })

  test("SECRET_VALUE_LEAK_IN_PLAN: shape validation rejects secret-looking env keys", () => {
    const bad = basePlan({ environment: { GITHUB_TOKEN: "ghp_xxx" } })
    const v = validateCellPlanShape(bad)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join()).toContain("secret")
  })

  test("shape validation: missing executable rejected", () => {
    const v = validateCellPlanShape(basePlan({ executable: "" }))
    expect(v.ok).toBe(false)
  })

  test("shape validation: bad workloadKind rejected", () => {
    const v = validateCellPlanShape(basePlan({ workloadKind: "evil" as never }))
    expect(v.ok).toBe(false)
  })

  test("shape validation: valid plan passes", () => {
    expect(validateCellPlanShape(basePlan()).ok).toBe(true)
  })
})
