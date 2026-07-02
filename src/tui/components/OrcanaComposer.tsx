/** OrcanaComposer — 基于 react-ink-textarea 的多行输入组件。
 *
 *  职责：
 *    - 多行编辑（Enter 发送，Shift+Enter 换行 —— TextArea 默认行为）
 *    - 大粘贴 placeholder 系统（diff 检测 → 替换为 PASTE:N token → 可展开/折叠）
 *    - 命令面板（/ 开头时禁用 TextArea 方向键导航，由 wrapper 的 onFirstLineUp/onLastLineDown 处理）
 *      Enter 始终由 TextArea 触发 onSubmit → handleSubmit 中做命令选择
 *    - 历史导航（onFirstLineUp/onLastLineDown → history 或 scroll）
 *    - 修复"英文说明吞掉正文"问题（TextArea 有自己的 viewport，不靠 displayWindow 切片）
 *
 *  设计原则：
 *    - TextArea 负责文本编辑和光标管理（CJK/emoji 宽度、撤销、bracketed paste）
 *    - OrcanaComposer 负责 paste block 系统、命令面板、历史导航
 *    - controlled mode：value/cursorPosition 由 wrapper 管理，便于 paste token 替换
 *
 *  未来替换：如果 react-ink-textarea 不再维护，只需替换 TextArea import，
 *  OrcanaComposer 的 paste block / 命令面板 / 历史逻辑不受影响。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text } from "ink"
import { TextArea } from "react-ink-textarea"
import { C } from "../theme/theme"
import type { SlashCommandHint } from "../input"

// ── Paste block 系统（从 input.tsx 适配） ──

export interface PasteBlock {
  id: number
  token: string
  text: string
  lines: number
  chars: number
}

const PASTE_PREFIX = "PASTE:"
const PASTE_SUFFIX = ""
const pasteTokenRegex = /PASTE:(\d+)/g
const pasteTriggerChars = Number(process.env.DEEPSEEK_TUI_PASTE_CHARS ?? "800")
const pasteTriggerLines = Number(process.env.DEEPSEEK_TUI_PASTE_LINES ?? "2")

export function pasteToken(id: number): string {
  return `${PASTE_PREFIX}${id}${PASTE_SUFFIX}`
}

export function countLines(text: string): number {
  if (!text) return 0
  return text.split("\n").length
}

export function labelForPaste(block: PasteBlock): string {
  const linePart = block.lines > 1 ? ` +${block.lines} lines` : ""
  return `[Pasted text #${block.id}${linePart}, ${block.chars} chars loaded]`
}

export function displayDraft(value: string, blocks: PasteBlock[]): string {
  const byId = new Map(blocks.map(block => [String(block.id), block]))
  return value.replace(pasteTokenRegex, (_token, id: string) => {
    const block = byId.get(id)
    return block ? labelForPaste(block) : `[Pasted text #${id}]`
  })
}

export function expandDraft(value: string, blocks: PasteBlock[]): string {
  const byId = new Map(blocks.map(block => [String(block.id), block]))
  return value.replace(pasteTokenRegex, (_token, id: string) => byId.get(id)?.text ?? "")
}

export function shouldStagePaste(text: string): boolean {
  if (!text) return false
  const lines = countLines(text)
  return lines >= pasteTriggerLines || text.length >= pasteTriggerChars
}

/** 找出 newValue 相对于 oldValue 的插入文本。
 *  通过公共前缀/后缀计算，返回插入的位置和内容。 */
export function findInsertedText(
  oldValue: string,
  newValue: string,
): { inserted: string; start: number; end: number } | null {
  // 剪枝：如果 newValue 更短，说明是删除操作，不是粘贴
  if (newValue.length <= oldValue.length) return null
  // 剪枝：如果差值太小，不可能是大粘贴
  const diffLen = newValue.length - oldValue.length
  if (diffLen < pasteTriggerChars && countLines(newValue) - countLines(oldValue) < pasteTriggerLines) {
    // 可能是多行小粘贴，继续检查
    if (diffLen < 40) return null
  }

  // 找公共前缀
  let prefixLen = 0
  const minLen = Math.min(oldValue.length, newValue.length)
  while (prefixLen < minLen && oldValue[prefixLen] === newValue[prefixLen]) {
    prefixLen++
  }

  // 找公共后缀
  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    oldValue[oldValue.length - 1 - suffixLen] === newValue[newValue.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const inserted = newValue.slice(prefixLen, newValue.length - suffixLen)
  if (!inserted) return null

  return {
    inserted,
    start: prefixLen,
    end: newValue.length - suffixLen,
  }
}

/** 将 flat string position 转换为 [row, col] tuple（TextArea 的 cursorPosition 格式）。 */
export function flatToRowCol(text: string, pos: number): [number, number] {
  const clampedPos = Math.max(0, Math.min(pos, text.length))
  let row = 0
  let lastNewline = -1
  for (let i = 0; i < clampedPos; i++) {
    if (text[i] === "\n") {
      row++
      lastNewline = i
    }
  }
  const col = clampedPos - lastNewline - 1
  return [row, col < 0 ? 0 : col]
}

// ── 历史项（结构化存储，修复大粘贴历史丢失问题） ──

interface ComposerHistoryItem {
  /** 用户输入的原始 draft（含 paste token） */
  draft: string
  /** 展开 paste token 后的完整文本 */
  expanded: string
  /** 粘贴块快照（深拷贝，避免引用污染） */
  pasteBlocks: PasteBlock[]
  /** 预览文本（用于可能的未来历史面板） */
  preview: string
}

function buildHistoryItem(rawValue: string, pasteBlocks: PasteBlock[]): ComposerHistoryItem {
  const expanded = expandDraft(rawValue, pasteBlocks)
  return {
    draft: rawValue,
    expanded,
    pasteBlocks: pasteBlocks.map(b => ({ ...b })),
    preview: displayDraft(rawValue, pasteBlocks).trim().slice(0, 240),
  }
}

// ── OrcanaComposer ──

export interface OrcanaComposerProps {
  onSubmit: (value: string) => void
  disabled?: boolean
  placeholder?: string
  status?: string
  rightStatus?: string
  commands?: SlashCommandHint[]
  focused?: boolean
  onChromeChange?: (state: { commandOpen: boolean; pasteCount: number; textRows: number }) => void
}

export function OrcanaComposer({
  onSubmit,
  disabled = false,
  placeholder,
  status,
  rightStatus,
  commands = [],
  focused = true,
  onChromeChange,
}: OrcanaComposerProps) {
  // ── 状态 ──
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState<[number, number]>([0, 0])
  const [history, setHistory] = useState<ComposerHistoryItem[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [commandIdx, setCommandIdx] = useState(0)
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([])
  const [nextPasteId, setNextPasteId] = useState(1)
  // 当用户浏览历史时，保存当前未发送的草稿（用于回到 "现在" 时恢复）
  const savedDraftRef = useRef<{ value: string; cursor: [number, number]; pasteBlocks: PasteBlock[] } | null>(null)

  // ── 派生数据 ──
  const visibleDraft = useMemo(() => displayDraft(value, pasteBlocks), [pasteBlocks, value])
  const showCommands = !disabled && value.trimStart().startsWith("/")
  const slashQuery = value.trimStart().startsWith("/")
    ? (value.trimStart().slice(1).split(/\s+/)[0] ?? "")
    : ""
  const commandMatches = commands.filter(cmd => cmd.name.startsWith(slashQuery)).slice(0, 3)
  const selectedCommand = commandMatches[Math.min(commandIdx, Math.max(0, commandMatches.length - 1))]
  const pasteCount = pasteBlocks.filter(block => value.includes(block.token)).length
  // TextArea 当前行数（1-3），用于让 parent 动态计算 footerHeight
  const textRows = Math.min(3, Math.max(1, value ? value.split("\n").length : 1))

  // ── 通知 parent chrome 状态 ──
  useEffect(() => {
    onChromeChange?.({ commandOpen: showCommands, pasteCount, textRows })
  }, [onChromeChange, pasteCount, showCommands, textRows])

  // ── onChange：处理 paste 检测 ──
  const handleChange = useCallback(
    (newValue: string) => {
      // 检测大粘贴插入
      const diff = findInsertedText(value, newValue)
      if (diff && shouldStagePaste(diff.inserted)) {
        const id = nextPasteId
        const token = pasteToken(id)
        const block: PasteBlock = {
          id,
          token,
          text: diff.inserted,
          lines: countLines(diff.inserted),
          chars: diff.inserted.length,
        }
        setNextPasteId(id + 1)
        setPasteBlocks(blocks => [...blocks, block])
        setHistoryIdx(-1)
        setCommandIdx(0)
        // 用 token 替换插入的大文本
        const tokenizedValue = newValue.slice(0, diff.start) + token + newValue.slice(diff.end)
        setValue(tokenizedValue)
        // 设置光标到 token 之后
        setCursor(flatToRowCol(tokenizedValue, diff.start + token.length))
        return
      }

      setHistoryIdx(-1)
      setCommandIdx(0)
      setValue(newValue)
    },
    [value, nextPasteId],
  )

  // ── onCursorChange ──
  const handleCursorChange = useCallback((pos: [number, number]) => {
    setCursor(pos)
  }, [])

  // ── onSubmit：展开 paste token 后提交 ──
  const handleSubmit = useCallback(
    (rawValue: string) => {
      const expanded = expandDraft(rawValue, pasteBlocks)
      const trimmed = expanded.trim()
      if (!trimmed) return

      // 命令面板选择
      const hasCommandArgs = trimmed.startsWith("/") && /\s/.test(trimmed.slice(1))
      const finalValue =
        showCommands && selectedCommand && !hasCommandArgs ? `/${selectedCommand.name}` : trimmed

      // 保存历史（结构化 → 回溯时恢复原始 draft + pasteBlocks）
      const historyItem = buildHistoryItem(rawValue, pasteBlocks)
      setHistory(h => [...h.slice(-50), historyItem])
      setHistoryIdx(-1)
      setCommandIdx(0)
      savedDraftRef.current = null

      // Bug 修复：先清空输入框，再调用 onSubmit。
      // 之前顺序：onSubmit → setValue，若 onSubmit 同步抛错则输入框不清空，
      // 且错误冒泡到 react-ink-textarea 的 useInput handler 可能导致 TUI 异常。
      // 先清空确保用户输入不丢失（history 已保存），且 onSubmit 抛错不影响 UI 状态。
      setValue("")
      setCursor([0, 0])
      setPasteBlocks([])
      try {
        onSubmit(finalValue)
      } catch {
        // onSubmit 错误由 runAgent 的 try-catch 处理（dispatch error_line + assistant.final）
        // 这里静默捕获，防止错误冒泡到 useInput handler 导致 TUI 渲染崩溃
      }
    },
    [pasteBlocks, showCommands, selectedCommand, onSubmit],
  )

  // ── onTab：命令面板导航 ──
  const handleTab = useCallback(
    (shift: boolean) => {
      if (showCommands && commandMatches.length > 0) {
        setCommandIdx(idx => {
          const delta = shift ? -1 : 1
          return (idx + delta + commandMatches.length) % commandMatches.length
        })
      }
    },
    [showCommands, commandMatches.length],
  )

  // ── onFirstLineUp：第一行按 Up → 命令面板或历史导航 ──
  const handleFirstLineUp = useCallback(() => {
    if (showCommands && commandMatches.length > 0) {
      setCommandIdx(idx => (idx <= 0 ? commandMatches.length - 1 : idx - 1))
      return
    }
    if (history.length > 0) {
      const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
      // 首次进入历史时保存当前草稿，以便回到 "现在" 时恢复
      if (historyIdx === -1) {
        savedDraftRef.current = { value, cursor, pasteBlocks: pasteBlocks.map(b => ({ ...b })) }
      }
      const item = history[newIdx]!
      setHistoryIdx(newIdx)
      setValue(item.draft)
      setCursor(flatToRowCol(item.draft, item.draft.length))
      setPasteBlocks(item.pasteBlocks.map(b => ({ ...b })))
      setCommandIdx(0)
    }
  }, [showCommands, commandMatches.length, history, historyIdx, value, cursor, pasteBlocks])

  // ── onLastLineDown：最后一行按 Down → 命令面板或历史导航 ──
  const handleLastLineDown = useCallback(() => {
    if (showCommands && commandMatches.length > 0) {
      setCommandIdx(idx => (idx + 1) % commandMatches.length)
      return
    }
    if (historyIdx >= 0) {
      const newIdx = historyIdx + 1
      if (newIdx >= history.length) {
        // 回到 "现在"：恢复进入历史前保存的草稿
        setHistoryIdx(-1)
        const saved = savedDraftRef.current
        if (saved) {
          setValue(saved.value)
          setCursor(saved.cursor)
          setPasteBlocks(saved.pasteBlocks.map(b => ({ ...b })))
        } else {
          setValue("")
          setCursor([0, 0])
          setPasteBlocks([])
        }
        savedDraftRef.current = null
      } else {
        const item = history[newIdx]!
        setHistoryIdx(newIdx)
        setValue(item.draft)
        setCursor(flatToRowCol(item.draft, item.draft.length))
        setPasteBlocks(item.pasteBlocks.map(b => ({ ...b })))
      }
    }
  }, [showCommands, commandMatches.length, history, historyIdx])

  // ── 输入状态行 ──
  const compactInputStatus = disabled
    ? "运行中"
    : showCommands
      ? "↑/↓ 选择 · Tab 切换 · Enter 发送"
      : pasteCount > 0
        ? `已载入 ${pasteCount} 段粘贴内容 · Backspace 移除`
        : ""

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 命令面板 */}
      {showCommands && (
        <Box flexDirection="column" marginBottom={1} marginLeft={2}>
          {commandMatches.length === 0 ? (
            <Text color={C.dim}>无匹配命令</Text>
          ) : (
            commandMatches.map((cmd, index) => (
              <Text key={cmd.name} color={index === commandIdx ? C.cyan : C.dim}>
                {index === commandIdx ? ">" : " "} /{cmd.name} <Text color={C.dim}>{cmd.description}</Text>
              </Text>
            ))
          )}
        </Box>
      )}

      {/* 粘贴内容指示器 */}
      {pasteCount > 0 && !showCommands && (
        <Box marginLeft={2} marginBottom={0}>
          <Text color={C.yellow}>{compactInputStatus}</Text>
        </Box>
      )}

      {/* TextArea：多行输入核心
          不再禁用 Enter —— handleSubmit 已有命令面板选择逻辑，
          禁用 Enter 会导致用户在命令面板打开时无法提交。 */}
      <TextArea
        focus={focused && !disabled}
        value={value}
        cursorPosition={cursor}
        onChange={handleChange}
        onCursorChange={handleCursorChange}
        onSubmit={handleSubmit}
        onTab={handleTab}
        onFirstLineUp={handleFirstLineUp}
        onLastLineDown={handleLastLineDown}
        placeholder={placeholder || "Message Orcana... (Enter send · Shift+Enter newline)"}
        disableArrowNavigation={showCommands}
        viewportLines={3}
        initialLineCount={1}
        cursorInterval={500}
        typingPause={450}
      />

      {/* 状态行 */}
      {status && !showCommands && (
        <Box flexDirection="row">
          <Text color={C.dim}> {status}</Text>
          {rightStatus && (
            <Box flexGrow={1} justifyContent="flex-end">
              <Text color={C.dim}>{rightStatus}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
