/** hints — HintBar 派生层（Depthline P3）。
 *
 *  HintBar 只从 ActionRegistry 读取，不再维护第二套文案（消除漂移）。
 *  主表面 ≤3 动作；modal 上下文用注册表动作 + 少量静态引导文本。
 */

import type { InputContext } from "../input/types"
import { findAction } from "./actions"

export interface HintEntry {
  shortcut: string
  label: string
  /** 省略时用 brand 色。 */
  color?: string
}

/** 把 KeyBinding 渲染成快捷键文本（人类可读键名）。 */
export function shortcutLabel(key: string, ctrl?: boolean, shift?: boolean): string {
  const display = HUMAN_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  const mods = [ctrl ? "Ctrl" : "", shift ? "Shift" : ""].filter(Boolean)
  return [...mods, display].join("+")
}

const HUMAN_KEYS: Record<string, string> = {
  return: "Enter",
  escape: "Esc",
  tab: "Tab",
  up: "↑",
  down: "↓",
  pageUp: "PgUp",
  pageDown: "PgDn",
  backspace: "⌫",
}

function actionEntry(id: "runtime.open" | "run.stop" | "shortcuts.help"): HintEntry {
  const action = findAction(id)!
  const binding = action.shortcuts[0]!
  return { shortcut: shortcutLabel(binding.key, binding.ctrl, binding.shift), label: ` ${action.label}` }
}

export interface HintBarModel {
  /** 是否隐藏 HintBar（无可用提示）。 */
  hidden: boolean
  entries: HintEntry[]
}

/** 主表面提示（≤3 动作）。 */
function mainSurfaceHints(busy: boolean, width: number): HintBarModel {
  if (busy) {
    if (width < 60) {
      return { hidden: false, entries: [{ shortcut: "Enter", label: " queue" }] }
    }
    return {
      hidden: false,
      entries: [
        { shortcut: "Enter", label: " queue" },
        actionEntry("run.stop"),
        actionEntry("runtime.open"),
      ],
    }
  }
  if (width < 60) {
    return {
      hidden: false,
      entries: [
        { shortcut: "Enter", label: " send" },
        { shortcut: "/", label: " commands" },
      ],
    }
  }
  return {
    hidden: false,
    entries: [
      { shortcut: "Enter", label: " send" },
      { shortcut: "/", label: " commands" },
      actionEntry("shortcuts.help"),
    ],
  }
}

function modalHints(entries: HintEntry[], staticLead?: string): HintBarModel {
  return { hidden: false, entries: staticLead ? [{ shortcut: staticLead, label: " " }, ...entries] : entries }
}

/** 当前上下文提示（≤3 动作为主，modal 上下文可略多引导文本）。 */
export function hintsForContext(context: InputContext, busy: boolean, width: number): HintBarModel {
  switch (context) {
    case "Confirm":
      return modalHints([
        actionEntryBy("confirm.approve", "approve"),
        actionEntryBy("confirm.deny", "deny"),
        actionEntryBy("confirm.denyAll", "deny all"),
      ])
    case "RewindList":
    case "RewindConfirm":
      return modalHints([
        actionEntryBy("rewind.select", "confirm"),
        actionEntryBy("rewind.cancel", "cancel"),
      ], "↑↓ select")
    case "Clarification":
      return modalHints([
        actionEntryBy("clarification.select", "confirm"),
        actionEntryBy("clarification.cancel", "cancel"),
      ], "↑↓ or j/k select")
    case "RuntimeDialog":
      return modalHints([
        actionEntryBy("settings.confirm", "confirm"),
        actionEntryBy("settings.close", "close"),
      ], "↑↓ select · type search/key")
    case "CommandShelf":
      return modalHints([
        actionEntryBy("command.submit", "run"),
        actionEntryBy("command.insert", "insert"),
        actionEntryBy("command.close", "close"),
      ], "↑↓ select")
    case "Scrollback":
      return mainSurfaceHints(busy, width)
    default:
      return { hidden: true, entries: [] }
  }
}

function actionEntryBy(id: "confirm.approve" | "confirm.deny" | "confirm.denyAll" | "rewind.select" | "rewind.cancel" | "clarification.select" | "clarification.cancel" | "settings.confirm" | "settings.close" | "command.submit" | "command.insert" | "command.close", label: string): HintEntry {
  const action = findAction(id)!
  const binding = action.shortcuts[0]!
  return { shortcut: shortcutLabel(binding.key, binding.ctrl, binding.shift), label: ` ${label}` }
}
