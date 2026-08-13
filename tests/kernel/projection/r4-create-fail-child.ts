/**
 * AK2-R4 R4-00-9 反例的 child helper —— 在受控 PATH（fake fusermount
 * 优先）的子进程中执行 FuseOverlayfsProjectionBackend.create()。
 *
 * bun 的 execFileSync 使用进程启动时的 PATH 解析二进制 —— 子进程以
 * 修改后的 PATH 环境启动，使 backend 的 unmount() 命中 fake
 * fusermount3（unmount 报告成功但不实际卸载）—— 确定性复现
 * 「unmount 报告成功 ≠ 已卸载」窗口。
 *
 * 环境变量：R4_ROOT（projection root）、R4_LOWER（lower base）。
 * 退出码：create 抛错 → 0；未抛错 → 1（测试应失败）。
 */

import { FuseOverlayfsProjectionBackend } from "../../../src/kernel/projection/backend"

const root = process.env.R4_ROOT
const lower = process.env.R4_LOWER
if (!root || !lower) {
  console.error("R4_ROOT/R4_LOWER required")
  process.exit(2)
}

try {
  new FuseOverlayfsProjectionBackend().create({ lowerDir: lower, projectionRoot: root, label: "m" })
  console.error("create() unexpectedly succeeded")
  process.exit(1)
} catch (error) {
  console.log(`create threw: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(0)
}
