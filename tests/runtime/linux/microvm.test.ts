/** LR2-4（P4-D）：MicroVM 探测验收 —— 无 KVM 明确拒绝（不静默降级）。 */

import { describe, expect, test } from "bun:test"
import { detectKvm, requireMicrovm } from "../../../src/runtime/linux/microvm"

describe("MicroVM detection (P4-D)", () => {
  test("detectKvm returns availability with reasons", () => {
    const probe = detectKvm()
    expect(typeof probe.available).toBe("boolean")
    expect(Array.isArray(probe.reasons)).toBe(true)
  })

  test("MICROVM_WITHOUT_KVM: unavailable backend refuses, never degrades", () => {
    const probe = detectKvm()
    if (!probe.available) {
      // 无 KVM（本机 WSL）：requireMicrovm 必须抛错（不静默降级）
      expect(() => requireMicrovm()).toThrow(/MICROVM_WITHOUT_KVM/)
    } else {
      // 有 KVM：正常返回
      expect(requireMicrovm().available).toBe(true)
    }
  })
})
