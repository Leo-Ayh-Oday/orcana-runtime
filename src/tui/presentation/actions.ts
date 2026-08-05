/** actions — ActionRegistry 最小 seam（Depthline P2）。
 *
 *  P3 将扩展为完整注册表（全部键位 + dispatcher + ? 面板 + palette 单一数据源）。
 *  P2 只注册：
 *    - runtime.open（Ctrl+T 打开/关闭 RuntimeInspector）
 *    - scroll.*（保留 keymap 兼容，供 HintBar 派生）
 *
 *  定义与执行分离（评审修正 #9）：本文件只含元数据，
 *  执行逻辑在 main.tsx / dispatcher（P3 统一到 ActionHandlerMap）。
 */

import type { Key } from "ink"
import type { InputContext } from "../input/types"

export type ActionId =
  | "runtime.open"
  | "scroll.up"
  | "scroll.down"
  | "scroll.pageUp"
  | "scroll.pageDown"

export interface KeyBinding {
  /** 字符键（小写）或方向键名（up/down/pageUp/pageDown）。 */
  key: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

export interface ActionDefinition {
  id: ActionId
  contexts: readonly InputContext[]
  shortcuts: readonly KeyBinding[]
  /** HintBar 短标签（如 "activity"）。 */
  label: string
  /** ? 面板描述（P3 使用）。 */
  description: string
}

// ── 注册表 ──

export const ACTIONS: readonly ActionDefinition[] = [
  {
    id: "runtime.open",
    contexts: ["Scrollback"],
    shortcuts: [{ key: "t", ctrl: true }],
    label: "activity",
    description: "Toggle runtime inspector",
  },
  {
    id: "scroll.up",
    contexts: ["Scrollback"],
    shortcuts: [{ key: "up", ctrl: true }],
    label: "scroll up",
    description: "Scroll transcript up",
  },
  {
    id: "scroll.down",
    contexts: ["Scrollback"],
    shortcuts: [{ key: "down", ctrl: true }],
    label: "scroll down",
    description: "Scroll transcript down",
  },
  {
    id: "scroll.pageUp",
    contexts: ["Scrollback"],
    shortcuts: [{ key: "pageUp" }],
    label: "page up",
    description: "Page transcript up",
  },
  {
    id: "scroll.pageDown",
    contexts: ["Scrollback"],
    shortcuts: [{ key: "pageDown" }],
    label: "page down",
    description: "Page transcript down",
  },
]

export function findAction(id: ActionId): ActionDefinition | undefined {
  return ACTIONS.find(a => a.id === id)
}

/** 把 ink Key 归一化为可匹配的键名。 */
function normalizeKey(key: Key): string | null {
  if (key.return) return "return"
  if (key.escape) return "escape"
  if (key.upArrow) return "up"
  if (key.downArrow) return "down"
  if (key.pageUp) return "pageUp"
  if (key.pageDown) return "pageDown"
  if (key.tab) return "tab"
  if (key.backspace || key.delete) return "backspace"
  return null
}

function bindingMatches(binding: KeyBinding, input: string, key: Key): boolean {
  if (Boolean(binding.ctrl) !== Boolean(key.ctrl)) return false
  if (Boolean(binding.meta) !== Boolean(key.meta)) return false
  const normalized = normalizeKey(key)
  if (binding.key === "up" || binding.key === "down" || binding.key === "pageUp" || binding.key === "pageDown") {
    return normalized === binding.key
  }
  return input.toLowerCase() === binding.key
}

/** 在当前 context 下匹配按键对应的动作（null = 未命中）。 */
export function matchAction(input: string, key: Key, context: InputContext): ActionDefinition | null {
  for (const action of ACTIONS) {
    if (!action.contexts.includes(context)) continue
    for (const binding of action.shortcuts) {
      if (bindingMatches(binding, input, key)) return action
    }
  }
  return null
}
