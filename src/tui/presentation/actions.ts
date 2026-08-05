/** actions — ActionRegistry（Depthline P3，全量）。
 *
 *  单一数据源：keymap 解析、HintBar、`Ctrl+?` 快捷键面板、测试全部由此派生。
 *
 *  定义与执行分离（评审修正 #9）：
 *    - 本文件只含元数据（id / contexts / shortcuts / label / description / matchable / enabled）
 *    - 执行逻辑在 presentation/dispatcher.ts（ActionHandlerMap）
 *
 *  动作分类：
 *    - matchable：键盘可解析（scroll / clarification / confirm / rewind / runtime.open / run.stop / shortcuts.help）
 *    - metadata-only：由组件内部处理（chat.* 归 TextArea，command.* 归 CommandShelf，settings.* 归 overlay controller）
 *    - reserved（enabled=false）：P4 Block 选择/折叠预留
 */

import type { Key } from "ink"
import type { InputContext } from "../input/types"

// ── 动作 ID ──

export type ActionId =
  // composer 内部（metadata-only）
  | "chat.submit"
  | "chat.newline"
  | "chat.queue"
  | "command.open"
  | "command.previous"
  | "command.next"
  | "command.submit"
  | "command.insert"
  | "command.close"
  // settings 对话框（metadata-only，由 useOverlayController 消费）
  | "settings.confirm"
  | "settings.close"
  // keymap 可解析
  | "scroll.up"
  | "scroll.down"
  | "scroll.pageUp"
  | "scroll.pageDown"
  | "clarification.up"
  | "clarification.down"
  | "clarification.select"
  | "clarification.cancel"
  | "confirm.approve"
  | "confirm.deny"
  | "confirm.denyAll"
  | "confirm.dismiss"
  | "rewind.up"
  | "rewind.down"
  | "rewind.select"
  | "rewind.cancel"
  | "runtime.open"
  | "run.stop"
  | "shortcuts.help"
  // P4 预留（enabled=false）
  | "block.selectUp"
  | "block.selectDown"
  | "block.toggle"

export interface KeyBinding {
  /** 字符键（小写）或方向键名（up/down/pageUp/pageDown/escape/return）。 */
  key: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

export interface ActionDefinition {
  id: ActionId
  contexts: readonly InputContext[]
  shortcuts: readonly KeyBinding[]
  /** HintBar 短标签（如 "send"、"activity"）。 */
  label: string
  /** Ctrl+? 面板描述。 */
  description: string
  /** 是否参与键盘匹配（false = metadata-only，仅供提示/面板）。 */
  matchable?: boolean
  /** 是否启用（P4 reserved 动作为 false，不参与匹配与提示）。 */
  enabled?: boolean
}

// ── 注册表 ──

export const ACTIONS: readonly ActionDefinition[] = [
  // ── composer（metadata-only，TextArea 内部处理） ──
  { id: "chat.submit", contexts: ["Composer"], shortcuts: [{ key: "return" }], label: "send", description: "Send message", matchable: false },
  { id: "chat.newline", contexts: ["Composer"], shortcuts: [{ key: "return", shift: true }], label: "newline", description: "Insert newline", matchable: false },
  { id: "chat.queue", contexts: ["Composer"], shortcuts: [{ key: "return" }], label: "queue", description: "Queue message while agent is running", matchable: false },
  { id: "command.open", contexts: ["Composer"], shortcuts: [{ key: "/" }], label: "commands", description: "Open command palette", matchable: false },

  // ── command shelf（metadata-only，OrcanaComposer 内部处理） ──
  { id: "command.previous", contexts: ["CommandShelf"], shortcuts: [{ key: "up" }], label: "previous", description: "Previous command", matchable: false },
  { id: "command.next", contexts: ["CommandShelf"], shortcuts: [{ key: "down" }], label: "next", description: "Next command", matchable: false },
  { id: "command.submit", contexts: ["CommandShelf"], shortcuts: [{ key: "return" }], label: "run", description: "Run command", matchable: false },
  { id: "command.insert", contexts: ["CommandShelf"], shortcuts: [{ key: "tab" }], label: "insert", description: "Insert command into input", matchable: false },
  { id: "command.close", contexts: ["CommandShelf"], shortcuts: [{ key: "escape" }], label: "close", description: "Close command palette", matchable: false },

  // ── settings 对话框（metadata-only，useOverlayController 消费） ──
  { id: "settings.confirm", contexts: ["RuntimeDialog"], shortcuts: [{ key: "return" }], label: "confirm", description: "Confirm selection", matchable: false },
  { id: "settings.close", contexts: ["RuntimeDialog"], shortcuts: [{ key: "escape" }], label: "close", description: "Close dialog", matchable: false },

  // ── scrollback ──
  { id: "scroll.up", contexts: ["Scrollback"], shortcuts: [{ key: "up", ctrl: true }], label: "scroll up", description: "Scroll transcript up" },
  { id: "scroll.down", contexts: ["Scrollback"], shortcuts: [{ key: "down", ctrl: true }], label: "scroll down", description: "Scroll transcript down" },
  { id: "scroll.pageUp", contexts: ["Scrollback"], shortcuts: [{ key: "pageUp" }], label: "page up", description: "Page transcript up" },
  { id: "scroll.pageDown", contexts: ["Scrollback"], shortcuts: [{ key: "pageDown" }], label: "page down", description: "Page transcript down" },
  { id: "runtime.open", contexts: ["Scrollback"], shortcuts: [{ key: "t", ctrl: true }], label: "activity", description: "Toggle runtime inspector" },
  { id: "run.stop", contexts: ["Scrollback"], shortcuts: [{ key: "escape" }], label: "stop", description: "Stop current run" },
  { id: "shortcuts.help", contexts: ["Scrollback"], shortcuts: [{ key: "?", ctrl: true }], label: "shortcuts", description: "Show shortcut overview" },

  // ── clarification ──
  { id: "clarification.up", contexts: ["Clarification"], shortcuts: [{ key: "k" }, { key: "up" }], label: "up", description: "Previous option" },
  { id: "clarification.down", contexts: ["Clarification"], shortcuts: [{ key: "j" }, { key: "down" }], label: "down", description: "Next option" },
  { id: "clarification.select", contexts: ["Clarification"], shortcuts: [{ key: "return" }], label: "confirm", description: "Confirm selection" },
  { id: "clarification.cancel", contexts: ["Clarification"], shortcuts: [{ key: "escape" }], label: "cancel", description: "Cancel clarification" },

  // ── confirm ──
  { id: "confirm.approve", contexts: ["Confirm"], shortcuts: [{ key: "y" }], label: "approve", description: "Approve request" },
  { id: "confirm.deny", contexts: ["Confirm"], shortcuts: [{ key: "n" }], label: "deny", description: "Deny request" },
  { id: "confirm.denyAll", contexts: ["Confirm"], shortcuts: [{ key: "a" }], label: "deny all", description: "Deny all pending requests" },
  { id: "confirm.dismiss", contexts: ["Confirm"], shortcuts: [{ key: "escape" }], label: "dismiss", description: "Dismiss without decision" },

  // ── rewind ──
  { id: "rewind.up", contexts: ["RewindList"], shortcuts: [{ key: "k" }, { key: "up" }], label: "up", description: "Previous rewind point" },
  { id: "rewind.down", contexts: ["RewindList"], shortcuts: [{ key: "j" }, { key: "down" }], label: "down", description: "Next rewind point" },
  { id: "rewind.select", contexts: ["RewindList", "RewindConfirm"], shortcuts: [{ key: "return" }, { key: "y" }], label: "confirm", description: "Confirm rewind" },
  { id: "rewind.cancel", contexts: ["RewindList", "RewindConfirm"], shortcuts: [{ key: "escape" }, { key: "n" }], label: "cancel", description: "Cancel rewind" },

  // ── P4 reserved：block 选择/折叠 ──
  { id: "block.selectUp", contexts: ["Scrollback"], shortcuts: [{ key: "k" }], label: "select up", description: "Select previous block", enabled: false },
  { id: "block.selectDown", contexts: ["Scrollback"], shortcuts: [{ key: "j" }], label: "select down", description: "Select next block", enabled: false },
  { id: "block.toggle", contexts: ["Scrollback"], shortcuts: [{ key: "return" }, { key: " " }], label: "toggle", description: "Toggle block expansion", enabled: false },
]

// ── 查询 ──

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
  if (Boolean(binding.shift) !== Boolean(key.shift) && binding.shift === true) return false
  const normalized = normalizeKey(key)
  if (normalized && (binding.key === normalized)) return true
  return input.toLowerCase() === binding.key
}

/** 在当前 context 下匹配按键对应的动作（null = 未命中；disabled/metadata-only 不参与匹配）。 */
export function matchAction(input: string, key: Key, context: InputContext): ActionDefinition | null {
  for (const action of ACTIONS) {
    if (action.enabled === false) continue
    if (action.matchable === false) continue
    if (!action.contexts.includes(context)) continue
    for (const binding of action.shortcuts) {
      if (bindingMatches(binding, input, key)) return action
    }
  }
  return null
}

/** 上下文内所有可见动作（面板用，按注册顺序）。 */
export function visibleActionsForContext(context: InputContext): ActionDefinition[] {
  return ACTIONS.filter(a => a.enabled !== false && a.contexts.includes(context))
}
