/** input/types — 键盘输入上下文模型。
 *
 *  Phase 2 设计原则（Orcana TUI 演进计划）：
 *    - 每个 InputContext 拥有自己的键位空间
 *    - 高优先级 context 处理过的键不 fall-through 到低优先级
 *    - OrcanaComposer 只负责文本编辑 + 命令候选，不拥有全局键位
 *    - FooterHints 从 active context 派生，不是硬编码
 *
 *  当前支持的 context：
 *    - Confirm         — y/n/a/Esc 确认模态
 *    - RewindConfirm   — y/n/Esc 回溯确认
 *    - RewindList      — ↑↓/Enter/Esc 回溯列表
 *    - Clarification   — ↑↓/j/k/Enter/Esc 问答面板
 *    - CommandShelf    — PR-5: 命令菜单打开，方向键/Tab/Enter/Esc 归 OrcanaComposer
 *    - Scrollback      — 空闲时，翻页/滚轮归它
 *    - Composer        — 文本编辑（TextArea 内部处理，不经过此系统）
 *    - Global          — 始终激活的 fallback（Ctrl+C 等）
 *
 *  PR-5: 新增 CommandShelf context。
 *  当 CommandShelf 打开时，Scrollback 不再抢键（Ctrl+Up/Down、PageUp/Down 不滚动），
 *  所有键 pass-through 到 TextArea/OrcanaComposer 处理命令导航。
 */

/** 键盘输入上下文。优先级从高到低排列。
 *  Phase 5: 新增 Confirm、RewindList、RewindConfirm 上下文。
 *  PR-5: 新增 CommandShelf 上下文。 */
export type InputContext = "Confirm" | "RewindConfirm" | "RewindList" | "Clarification" | "CommandShelf" | "Scrollback" | "Composer" | "Global"

/**
 * 上下文优先级数值。越大越优先。
 * 高优先级 context 处理键位后立即返回，阻止低优先级 context 看到该键。
 */
export const CONTEXT_PRIORITY: Record<InputContext, number> = {
  Confirm: 5,
  RewindConfirm: 4,
  RewindList: 3,
  Clarification: 3,
  CommandShelf: 2,
  Scrollback: 1,
  Composer: 0,
  Global: -1,
}

/** PR-5: TuiAction 命名空间 — 文档化全部 action 类型。
 *
 *  chat.*     — 由 TextArea/OrcanaComposer 内部处理（不经 keymap 分发）
 *  command.*  — 由 OrcanaComposer 内部处理（不经 keymap 分发）
 *  scroll.*   — 由 keymap.ts resolveScrollback 处理
 *  clarification.* / confirm.* / rewind.* — 由 keymap.ts 对应 resolver 处理
 *  app.*      — 全局键（Ctrl+C 等），由 main.tsx useInput 处理
 *
 *  当前 KeyAction 类型覆盖 scroll/clarification/confirm/rewind，
 *  chat/command 类 action 在组件内部直接处理。 */
export type TuiAction =
  | "chat.submit"
  | "chat.newline"
  | "chat.cancel"
  | "command.next"
  | "command.previous"
  | "command.submit"
  | "command.insert"
  | "command.close"
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
  | "tool.toggleExpand"
  | "app.interrupt"
  | "app.toggleTranscript"

/** 确定当前激活的最高优先级 context。
 *  PR-5: 新增 commandOpen 参数 → CommandShelf context。 */
export function resolveActiveContext(opts: {
  clarificationActive: boolean
  confirmActive?: boolean
  rewindListActive?: boolean
  rewindConfirmActive?: boolean
  /** PR-5: 命令菜单打开时 → CommandShelf context（优先于 Scrollback） */
  commandOpen?: boolean
}): InputContext {
  if (opts.confirmActive) return "Confirm"
  if (opts.rewindConfirmActive) return "RewindConfirm"
  if (opts.rewindListActive) return "RewindList"
  if (opts.clarificationActive) return "Clarification"
  if (opts.commandOpen) return "CommandShelf"
  return "Scrollback"
}
