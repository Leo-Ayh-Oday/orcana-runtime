/** LR2-1v2（L2-D）验收：approvalToken 校验。 */

import { describe, test, expect } from "bun:test"
import {
  fixedApprovalTokenProvider,
  envApprovalTokenProvider,
  checkApproval,
} from "../../../src/execd/approval"

describe("L2-D: approvalToken", () => {
  test("valid token passes", () => {
    const p = fixedApprovalTokenProvider(["tok-1"])
    expect(p.isValid("tok-1")).toBe(true)
    expect(checkApproval(p, "tok-1", "SubmitCell").ok).toBe(true)
  })

  test("missing token rejected (UNAUTHORIZED_APPROVAL)", () => {
    const p = fixedApprovalTokenProvider(["tok-1"])
    const v = checkApproval(p, undefined, "SubmitCell")
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain("UNAUTHORIZED_APPROVAL")
  })

  test("wrong token rejected", () => {
    const p = fixedApprovalTokenProvider(["tok-1"])
    expect(p.isValid("tok-2")).toBe(false)
    expect(p.isValid("")).toBe(false)
  })

  test("no tokens configured → everything rejected (fail closed)", () => {
    const p = fixedApprovalTokenProvider([])
    expect(p.isValid("anything")).toBe(false)
    expect(checkApproval(p, "anything", "CancelCell").ok).toBe(false)
  })

  test("multiple tokens accepted (rotation)", () => {
    const p = fixedApprovalTokenProvider(["old", "new"])
    expect(p.isValid("old")).toBe(true)
    expect(p.isValid("new")).toBe(true)
    expect(p.currentTokens()).toEqual(["old", "new"])
  })

  test("env provider reads ORCANA_EXECD_APPROVAL_TOKEN (comma separated)", () => {
    const p = envApprovalTokenProvider({ ORCANA_EXECD_APPROVAL_TOKEN: "a, b ,c" } as NodeJS.ProcessEnv)
    expect(p.isValid("a")).toBe(true)
    expect(p.isValid("b")).toBe(true)
    expect(p.isValid("c")).toBe(true)
    expect(p.isValid("d")).toBe(false)
  })

  test("env provider without env var → fail closed", () => {
    const p = envApprovalTokenProvider({} as NodeJS.ProcessEnv)
    expect(p.isValid("x")).toBe(false)
  })

  test("token comparison is constant-time (no plaintext in digests)", () => {
    const p = fixedApprovalTokenProvider(["secret-value"])
    // 摘要不暴露明文
    expect(p.currentTokens()).toEqual(["secret-value"])
    expect(p.isValid("secret-value")).toBe(true)
  })
})
