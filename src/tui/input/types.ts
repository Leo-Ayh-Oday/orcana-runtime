/** input/types — 键盘输入上下文模型。
 *
 *  Phase 2 设计原则（Orcana TUI 演进计划）：
 *    - 每个 InputContext 拥有自己的键位空间
 *    - 高优先级 context 处理过的键不 fall-through 到低优先级
 *    - OrcanaComposer 只负责文本编辑 + 命令候选，不拥有全局键位
 *    - FooterHints 从 active context 派生，不是硬编码
 *
 *  当前支持的 context（Phase 2 实现 Clarification + Scrollback）：
 *    - Clarification  — 问答面板打开时，方向键/Enter/Esc 归它
 *    - Scrollback      — 空闲时，翻页/滚轮归它
 *    - Composer        — 文本编辑（TextArea 内部处理，不经过此系统）
 *    - Global          — 始终激活的 fallback（Ctrl+C 等）
 *
 *  未来扩展（Phase 5 modal workflows）：
 *    - CommandPalette、Confirm、Rewind
 */

/** 键盘输入上下文。优先级从高到低排列。 */
export type InputContext = "Clarification" | "Scrollback" | "Composer" | "Global"

/**
 * 上下文优先级数值。越大越优先。
 * 高优先级 context 处理键位后立即返回，阻止低优先级 context 看到该键。
 */
export const CONTEXT_PRIORITY: Record<InputContext, number> = {
  Clarification: 3,
  Scrollback: 1,
  Composer: 0,
  Global: -1,
}

/** 确定当前激活的最高优先级 context。 */
export function resolveActiveContext(opts: {
  clarificationActive: boolean
}): InputContext {
  if (opts.clarificationActive) return "Clarification"
  // 空闲状态：Scrollback 活跃（翻页/滚轮），但 Composer 始终接收文本输入
  return "Scrollback"
}
