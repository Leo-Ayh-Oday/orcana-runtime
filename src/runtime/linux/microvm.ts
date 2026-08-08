/** LR2-4（P4-D）：MicroVM 后端探测 —— KVM 可用性。
 *
 *  MICROVM_WITHOUT_KVM = 0：无 KVM 必须明确拒绝（不静默降级为普通
 *  执行）—— 探测失败即 `available: false`，严格 Profile 选择 microvm
 *  时拒绝执行。
 */

import { accessSync, constants, statSync } from "node:fs"

export interface MicrovmAvailability {
  available: boolean
  reasons: string[]
}

export function detectKvm(): MicrovmAvailability {
  const reasons: string[] = []
  if (process.platform !== "linux") {
    reasons.push("MicroVM is Linux-only")
  }
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    // m6（LR2-4 审核）：必须真是字符设备 —— 容器内伪造节点/普通文件
    // 不得被当作可用 KVM（accessSync 只查权限位）。
    const stat = statSync("/dev/kvm")
    if (!stat.isCharacterDevice()) {
      reasons.push("/dev/kvm is not a character device (fake node)")
    }
  } catch {
    reasons.push("/dev/kvm not accessible (no KVM)")
  }
  return { available: reasons.length === 0, reasons }
}

/** 严格 Profile 的 microvm 选择校验：不可用 → 拒绝（不降级）。 */
export function requireMicrovm(): MicrovmAvailability {
  const probe = detectKvm()
  if (!probe.available) {
    throw new Error(`MICROVM_WITHOUT_KVM: ${probe.reasons.join("; ")}`)
  }
  return probe
}
