/** input/keymap — 键位 → 动作映射 + 上下文分发。
 *
 *  Phase 2 只覆盖 Scrollback 和 Clarification 两个 context。
 *  每个 context 的处理器返回 true 表示"已处理，不放行"。
 */

import type { Key } from "ink"
import type { InputContext } from "./types"

// ── 动作类型 ──

export type ScrollAction =
  | { type: "scroll.up"; amount: number }
  | { type: "scroll.down"; amount: number }
  | { type: "scroll.pageUp"; amount: number }
  | { type: "scroll.pageDown"; amount: number }

export type ClarificationAction =
  | { type: "clarification.up" }
  | { type: "clarification.down" }
  | { type: "clarification.select" }
  | { type: "clarification.cancel" }

export type KeyAction = ScrollAction | ClarificationAction

// ── 分发上下文 ──

export interface KeyResolveContext {
  context: InputContext
  bodyHeight: number
  scrollStep: number
}

/**
 * 根据当前 context 解析键位输入。
 * 返回 null 表示该键未被当前 context 处理（放行到下游）。
 */
export function resolveKeyAction(
  input: string,
  key: Key,
  ctx: KeyResolveContext,
): KeyAction | null {
  switch (ctx.context) {
    case "Clarification":
      return resolveClarification(input, key)
    case "Scrollback":
      return resolveScrollback(key, ctx)
    default:
      return null
  }
}

// ── Clarification context ──

function resolveClarification(input: string, key: Key): KeyAction | null {
  if (input === "k" || key.upArrow) return { type: "clarification.up" }
  if (input === "j" || key.downArrow) return { type: "clarification.down" }
  if (key.return) return { type: "clarification.select" }
  if (key.escape) return { type: "clarification.cancel" }
  return null
}

// ── Scrollback context ──

function resolveScrollback(key: Key, ctx: KeyResolveContext): KeyAction | null {
  if (key.pageUp) return { type: "scroll.pageUp", amount: Math.max(3, ctx.bodyHeight - 4) }
  if (key.pageDown) return { type: "scroll.pageDown", amount: Math.max(3, ctx.bodyHeight - 4) }
  if (key.ctrl && key.upArrow) return { type: "scroll.up", amount: ctx.scrollStep }
  if (key.ctrl && key.downArrow) return { type: "scroll.down", amount: ctx.scrollStep }
  return null
}
