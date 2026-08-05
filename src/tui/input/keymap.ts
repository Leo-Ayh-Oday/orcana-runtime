/** input/keymap — 键位 → ActionId 解析（Depthline P3）。
 *
 *  keymap 是 ActionRegistry（presentation/actions.ts）的薄封装：
 *  resolveKeyAction(input, key, ctx) === matchAction(input, key, ctx.context)。
 *
 *  语义保持不变：
 *    - Confirm / RewindList / RewindConfirm / Clarification / Scrollback 各有键位空间
 *    - RuntimeDialog / CommandShelf context 返回 null（键由内部组件处理）
 *    - 返回 null = 未命中，放行到 composer
 */

import type { Key } from "ink"
import type { InputContext } from "./types"
import { matchAction, type ActionId } from "../presentation/actions"

/** 兼容类型：动作结果 = ActionId。 */
export type KeyAction = ActionId
export type ScrollAction = ActionId
export type ClarificationAction = ActionId
export type ConfirmAction = ActionId
export type RewindAction = ActionId

// ── 分发上下文 ──

export interface KeyResolveContext {
  context: InputContext
  /** 保留向后兼容（amount 计算已移入 presentation/dispatcher.ts）。 */
  bodyHeight: number
  scrollStep: number
}

/**
 * 根据当前 context 解析键位输入。
 * 返回 null 表示该键未被当前 context 处理（放行到下游）。
 * 动态量（pageUp/pageDown 的行数）由 dispatcher 根据 bodyHeight 计算。
 */
export function resolveKeyAction(
  input: string,
  key: Key,
  ctx: KeyResolveContext,
): KeyAction | null {
  return matchAction(input, key, ctx.context)?.id ?? null
}
