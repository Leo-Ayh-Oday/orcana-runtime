/** input/keymap — 键位 → 动作映射 + 上下文分发。
 *
 *  Phase 5: 新增 Confirm / RewindList / RewindConfirm 上下文。
 *  PR-5: 新增 CommandShelf 上下文 — 所有键 pass-through，不抢键。
 *  每个 context 的处理器返回非 null 表示"已处理，不放行"。 */

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

export type ConfirmAction =
  | { type: "confirm.approve" }
  | { type: "confirm.deny" }
  | { type: "confirm.denyAll" }
  | { type: "confirm.dismiss" }

export type RewindAction =
  | { type: "rewind.up" }
  | { type: "rewind.down" }
  | { type: "rewind.select" }
  | { type: "rewind.cancel" }

export type KeyAction = ScrollAction | ClarificationAction | ConfirmAction | RewindAction

// ── 分发上下文 ──

export interface KeyResolveContext {
  context: InputContext
  bodyHeight: number
  scrollStep: number
}

/**
 * 根据当前 context 解析键位输入。
 * 返回 null 表示该键未被当前 context 处理（放行到下游）。
 *
 * PR-5: CommandShelf context 返回 null（所有键 pass-through 到 OrcanaComposer）。
 * 这确保 Scrollback 不抢键：Ctrl+Up/Down、PageUp/Down 在命令菜单打开时不滚动。
 */
export function resolveKeyAction(
  input: string,
  key: Key,
  ctx: KeyResolveContext,
): KeyAction | null {
  switch (ctx.context) {
    case "Confirm":
      return resolveConfirm(input, key)
    case "RewindConfirm":
      return resolveRewindConfirm(input, key)
    case "RewindList":
      return resolveRewindList(input, key)
    case "Clarification":
      return resolveClarification(input, key)
    case "CommandShelf":
      // PR-5: 命令菜单打开时，所有键 pass-through 到 TextArea/OrcanaComposer。
      // 命令导航（↑↓/Tab/Enter/Esc）由 OrcanaComposer 内部处理。
      // 关键：Scrollback 的 Ctrl+Up/Down、PageUp/Down 不再抢键。
      return null
    case "Scrollback":
      return resolveScrollback(key, ctx)
    default:
      return null
  }
}

// ── Confirm context ──

function resolveConfirm(input: string, key: Key): KeyAction | null {
  if (input === "y" || input === "Y") return { type: "confirm.approve" }
  if (input === "n" || input === "N") return { type: "confirm.deny" }
  if (input === "a" || input === "A") return { type: "confirm.denyAll" }
  if (key.escape) return { type: "confirm.dismiss" }
  return null
}

// ── RewindList context ──

function resolveRewindList(input: string, key: Key): KeyAction | null {
  if (key.upArrow || input === "k") return { type: "rewind.up" }
  if (key.downArrow || input === "j") return { type: "rewind.down" }
  if (key.return) return { type: "rewind.select" }
  if (key.escape) return { type: "rewind.cancel" }
  return null
}

// ── RewindConfirm context ──

function resolveRewindConfirm(input: string, key: Key): KeyAction | null {
  if (input === "y" || input === "Y") return { type: "rewind.select" }
  if (input === "n" || input === "N" || key.escape) return { type: "rewind.cancel" }
  return null
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
