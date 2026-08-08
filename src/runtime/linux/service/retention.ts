/** LR2-5（P5-D）：Lease 到期 + Retention 决策。
 *
 *  核心原则（计划 §9）：**Lease 到期 ≠ 立即盲杀** —— 到期后按
 *  retentionPolicy 决策（retain / pause / terminate / transfer）；
 *  Owner Run 中断 → retentionPolicy 同样适用（OWNER_LOST）。
 */

import type { RetentionPolicy } from "./spec"
import type { ServiceManager } from "./lifecycle"

export type RetentionEvent = "lease-expired" | "owner-lost"

export interface RetentionDecision {
  action: "retain" | "pause" | "terminate" | "transfer"
  /** 决策理由（可解释）。 */
  reason: string
  /** transfer 时的目标 owner（若有）。 */
  transferTo?: string
}

/** Retention 决策（纯函数 —— 可测；执行由调用方驱动）。 */
export function decideRetention(
  policy: RetentionPolicy,
  event: RetentionEvent,
  context: { transferCandidate?: string } = {},
): RetentionDecision {
  switch (policy) {
    case "retain":
      return { action: "retain", reason: `${event}: retain policy — service continues` }
    case "pause":
      return { action: "pause", reason: `${event}: pause policy — service paused` }
    case "terminate":
      return { action: "terminate", reason: `${event}: terminate policy — service stopped` }
    case "transfer":
      if (!context.transferCandidate) {
        // 无转移候选 → 降级为 retain（不盲杀）
        return { action: "retain", reason: `${event}: transfer requested but no candidate — retaining` }
      }
      return { action: "transfer", transferTo: context.transferCandidate, reason: `${event}: transfer to ${context.transferCandidate}` }
  }
}

/** 执行 retention 决策（Lease 到期 / Owner 中断入口）。
 *  不盲杀：retain 不触碰服务；terminate 才停止。 */
export async function applyRetention(
  decision: RetentionDecision,
  service: ServiceManager,
): Promise<void> {
  switch (decision.action) {
    case "retain":
    case "transfer":
      // 服务继续运行（transfer 的所有权转移由上层完成 —— 本层不触碰）
      return
    case "pause":
      // v1：pause = 停止健康监测（进程保留）—— 由调用方执行；
      // 本层只记录语义（完整 pause 需 freeze 能力）。
      return
    case "terminate":
      await service.stop()
      return
  }
}

/** Owner 中断处理：按 retentionPolicy 决策（OWNER_LOST 状态由调用方置）。 */
export function onOwnerLost(policy: RetentionPolicy, transferCandidate?: string): RetentionDecision {
  return decideRetention(policy, "owner-lost", { transferCandidate })
}
