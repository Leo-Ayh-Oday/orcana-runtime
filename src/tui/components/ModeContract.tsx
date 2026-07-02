/** ModeContract — 当前模式的能力合同。
 *
 *  Phase 3: 每个 TuiMode 对应一个能力合同，告诉用户：
 *    - 当前模式允许什么操作
 *    - 哪些能力受限
 *
 *  模式语义（来自 runtime/modes）：
 *    discussion  — 只读分析 + 讨论，不写文件
 *    readonly    — 纯只读，不进行任何修改
 *    narrow_edit — 限定范围的编辑（单文件/单函数）
 *    long_task   — 长时间任务，允许跨文件修改
 *    planner     — 只输出计划，不执行
 *    executor    — 执行已批准的计划
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import { getGlyphTheme } from "../tokens"
import type { TuiMode } from "../state/types"

// ── 模式元数据（图标使用主题 glyph，延迟解析避免硬编码 Unicode） ──

interface ModeMeta {
  label: string
  description: string
  color: string
  allows: string
  restricts: string
  /** 图标 key — 运行时从 glyph theme 解析 */
  iconKey: "circleEmpty" | "readonly" | "circleHalf" | "circleFill"
}

const MODE_META: Record<TuiMode, ModeMeta> = {
  discussion: {
    iconKey: "circleEmpty",
    label: "Discussion",
    description: "Read-only analysis + discussion",
    color: C.green,
    allows: "read, search, analyze",
    restricts: "no writes, no mutations",
  },
  readonly: {
    iconKey: "readonly",
    label: "Read Only",
    description: "Pure read-only, zero changes",
    color: C.green,
    allows: "read, search",
    restricts: "no writes, no edits, no executions",
  },
  narrow_edit: {
    iconKey: "circleHalf",
    label: "Narrow Edit",
    description: "Scoped editing (single file/function)",
    color: C.yellow,
    allows: "read, write (scoped), search",
    restricts: "mutations limited to target scope",
  },
  long_task: {
    iconKey: "circleHalf",
    label: "Long Task",
    description: "Extended task, cross-file changes allowed",
    color: C.blue,
    allows: "read, write, execute, multi-file",
    restricts: "none (gated by policy)",
  },
  planner: {
    iconKey: "circleEmpty",
    label: "Planner",
    description: "Output plan only, no execution",
    color: C.cyan,
    allows: "read, plan, propose",
    restricts: "no writes, no tool execution",
  },
  executor: {
    iconKey: "circleFill",
    label: "Executor",
    description: "Execute approved plan step-by-step",
    color: C.blue,
    allows: "write, execute (scoped to plan)",
    restricts: "deviation requires re-plan",
  },
}

function modeIcon(key: ModeMeta["iconKey"]): string {
  const g = getGlyphTheme()
  switch (key) {
    case "circleEmpty": return g.circleEmpty
    case "readonly": return g.readonlyIcon
    case "circleHalf": return g.circleHalf
    case "circleFill": return g.circleFill
  }
}

// ── ModeContract 组件 ──

export interface ModeContractProps {
  mode: TuiMode
  width?: number
}

export const ModeContract = React.memo(function ModeContract({ mode, width }: ModeContractProps) {
  const meta = MODE_META[mode]
  if (!meta) return null

  const icon = modeIcon(meta.iconKey)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={meta.color}>{icon} </Text>
        <Text bold color={meta.color}>{meta.label}</Text>
      </Box>
      <Text color={C.dim}>  {meta.description}</Text>
      <Box flexDirection="row">
        <Text color={C.green}>  allows </Text>
        <Text color={C.dim}>{meta.allows}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={C.yellow}>  limits </Text>
        <Text color={C.dim}>{meta.restricts}</Text>
      </Box>
    </Box>
  )
})

// ── 导出供 StatusBar 使用的紧凑模式指示器 ──

/** 模式紧凑标签（用于 HeaderBar 或 StatusBar 单行显示）。 */
export function ModeBadge({ mode }: { mode: TuiMode }) {
  const meta = MODE_META[mode]
  if (!meta) return <Text color={C.dim}>mode ?</Text>
  const icon = modeIcon(meta.iconKey)
  return (
    <Text color={meta.color}>{icon} {meta.label}</Text>
  )
}
