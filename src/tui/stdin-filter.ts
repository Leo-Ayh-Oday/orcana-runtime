/** stdin-filter — 拦截 stdin 中的鼠标序列，防止泄漏到 react-ink-textarea。
 *
 *  背景：
 *    Ink 通过 paused mode 的 'readable' 事件 + stdin.read() 读取输入（App.js line 205-206），
 *    而非 flowing mode 的 'data' 事件。因此 patch process.stdin.emit('data', ...) 无效 —
 *    鼠标序列直接进入 Ink 的 input-parser，到达 react-ink-textarea 的 fallback 分支，
 *    被作为普通文本插入 composer，产生乱码。
 *
 *  方案：
 *    Patch stdin.read() — 在每次 read() 返回后过滤 chunk 中的鼠标序列。
 *    这是 Ink 读取输入的唯一路径，覆盖所有鼠标协议。
 *
 *  鼠标滚轮支持：
 *    解析 SGR 鼠标序列中的滚轮事件（button 64 = 向上, button 65 = 向下），
 *    通过 EventEmitter 发出 scroll 事件。
 *
 *  支持的鼠标序列：
 *    - SGR (DEC 1006): `\x1B[<button;col;rowM` 或 `\x1B[<button;col;rowm`
 *    - 普通鼠标 (DEC 1000): `\x1B[M` + 3 个字节（button, col, row）
 *    - urxvt (1015): `\x1B[button;col;rowM`
 *
 *  必须在 Ink render 之前调用 installStdinFilter()。
 */

import { EventEmitter } from "events"

// ── 鼠标滚轮事件 ──

/** 鼠标事件总线。ChatApp 监听 "scroll" 事件实现滚轮滚动。 */
export const mouseEvents = new EventEmitter()

// SGR 鼠标序列：\x1B[<button;col;rowM 或 m
const SGR_MOUSE_REGEX = /\x1B\[<(\d+);\d+;\d+[mM]/g
const DEC1000_MOUSE_REGEX = /\x1B\[M([^\x1B])([^\x1B])([^\x1B])/g

/** 防御性正则：匹配没有 ESC 前缀的孤立鼠标序列体。
 *  当 \x1B 已被消费但序列体 [<button;col;rowM 仍残留在输入流中时，
 *  作为最后安全网。图案 [<\d+;\d+;\d+[mM] 在正常用户输入中不存在。 */
const ORPHAN_SGR_BODY_REGEX = /\[<(\d+);\d+;\d+[mM]/g
const ORPHAN_DEC1000_BODY_REGEX = /\[M([\x20-\x23\x60-\x61])([^\x1B])([^\x1B])/g

function isPlausibleDec1000MouseBody(buttonChar: string, colChar: string, rowChar: string): boolean {
  const button = buttonChar.charCodeAt(0) - 32
  const col = colChar.charCodeAt(0) - 32
  const row = rowChar.charCodeAt(0) - 32
  const maxCols = (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 160) + 2
  const maxRows = (process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 60) + 2
  const knownButton = (button >= 0 && button <= 35) || (button >= 64 && button <= 95)
  return knownButton && col >= 1 && row >= 1 && col <= maxCols && row <= maxRows
}

/** 从字符串中移除孤立鼠标序列体（无 ESC 前缀）。 */
function stripOrphanMouseBodies(data: string): string {
  return data
    .replace(ORPHAN_SGR_BODY_REGEX, "")
    .replace(ORPHAN_DEC1000_BODY_REGEX, (match, button: string, col: string, row: string) =>
      isPlausibleDec1000MouseBody(button, col, row) ? "" : match,
    )
}

/** 从原始数据中提取滚轮事件并发出 scroll 事件。
 *  先用完整 SGR 正则匹配；若无匹配，fallback 到孤立序列体正则以防 ESC 丢失。 */
function extractScrollEvents(data: string): void {
  const tryRegex = (regex: RegExp, source = data): boolean => {
    regex.lastIndex = 0
    let found = false
    let match: RegExpExecArray | null
    while ((match = regex.exec(source)) !== null) {
      found = true
      const rawButton = match[1]
      if (!rawButton) continue
      const button = parseInt(rawButton, 10)
      if (button === 64 || button === 68) {
        mouseEvents.emit("scroll", -1, button === 68)
      } else if (button === 65 || button === 69) {
        mouseEvents.emit("scroll", 1, button === 69)
      }
    }
    return found
  }

  const tryDec1000Regex = (regex: RegExp, source = data): boolean => {
    regex.lastIndex = 0
    let found = false
    let match: RegExpExecArray | null
    while ((match = regex.exec(source)) !== null) {
      found = true
      const rawButton = match[1]?.charCodeAt(0)
      const col = match[2]
      const row = match[3]
      if (rawButton === undefined || !col || !row || !isPlausibleDec1000MouseBody(match[1]!, col, row)) continue
      const button = rawButton - 32
      if (button === 64 || button === 68) {
        mouseEvents.emit("scroll", -1, button === 68)
      } else if (button === 65 || button === 69) {
        mouseEvents.emit("scroll", 1, button === 69)
      }
    }
    return found
  }

  tryRegex(SGR_MOUSE_REGEX)
  tryDec1000Regex(DEC1000_MOUSE_REGEX)

  const orphanSource = data
    .replace(SGR_MOUSE_REGEX, "")
    .replace(DEC1000_MOUSE_REGEX, "")
  tryRegex(ORPHAN_SGR_BODY_REGEX, orphanSource)
  tryDec1000Regex(ORPHAN_DEC1000_BODY_REGEX, orphanSource)
}

// ── 鼠标序列检测 ──

/**
 * 匹配终端鼠标序列。
 *
 * 注意：普通鼠标模式（DEC 1000）的 `\x1B[M` 后跟 3 个字节，这 3 个字节
 * 可能是任意值（0-255）。为避免过度匹配（吃到下一个转义序列或正常输入），
 * 用 `[^\x1B]{3}` 限定为 3 个非 ESC 字节。若鼠标序列跨 chunk 边界，
 * 这个简化方案可能漏匹配，但实际场景中终端通常一次性发送完整序列。
 */
const MOUSE_SEQUENCE_REGEX = new RegExp(
  [
    // SGR (DEC 1006): \x1B[<button;col;rowM 或 m
    "\\x1B\\[<\\d+;\\d+;\\d+[mM]",
    // 普通鼠标 (DEC 1000): \x1B[M + 3 个非 ESC 字节
    "\\x1B\\[M[^\\x1B]{3}",
    // urxvt (1015): \x1B[button;col;rowM
    "\\x1B\\[\\d+;\\d+;\\d+M",
  ].join("|"),
  "g",
)

/** 检测字符串是否包含鼠标序列。 */
export function containsMouseSequence(data: string): boolean {
  MOUSE_SEQUENCE_REGEX.lastIndex = 0
  return MOUSE_SEQUENCE_REGEX.test(data)
}

/** 从字符串中移除所有鼠标序列。 */
export function stripMouseSequences(data: string): string {
  return data.replace(MOUSE_SEQUENCE_REGEX, "")
}

// ── 鼠标模式启用/禁用 ──

/** 全部常见鼠标模式（用于清理）。 */
const ALL_MOUSE_MODES = [
  "?1000", // DEC 1000 — 基础鼠标追踪
  "?1002", // DEC 1002 — 按钮事件追踪（拖动时）
  "?1003", // DEC 1003 — 任意移动追踪
  "?1005", // DEC 1005 — UTF-8 坐标编码
  "?1006", // DEC 1006 — SGR 坐标编码
  "?1015", // urxvt — urxvt 坐标编码
] as const

/** 启用 SGR 鼠标模式前先做完整清理，防止继承脏终端状态。 */
export function enableMouseMode(): void {
  // 先关闭所有已知 mouse mode
  process.stdout.write(ALL_MOUSE_MODES.map(m => `\x1B[${m}l`).join(""))
  // 再启用需要的：SGR (1006) + 基础鼠标追踪 (1000)
  process.stdout.write("\x1B[?1006h\x1B[?1000h")
}

/** 禁用全部常见鼠标模式。 */
export function disableMouseMode(): void {
  process.stdout.write(ALL_MOUSE_MODES.map(m => `\x1B[${m}l`).join(""))
}

// ── 跨 chunk 边界处理 ──

/**
 * 匹配末尾可能不完整的 SGR 鼠标序列前缀。
 *
 * 终端快速滚动时，TCP/管道可能将一个鼠标序列拆分到多个 data chunk。
 * 例如 chunk1 = "\x1B[<64;40;", chunk2 = "10M"。如果只按完整序列匹配，
 * 不完整前缀会漏 strip，到达 Ink 后产生乱码。
 */
const INCOMPLETE_MOUSE_PREFIX_REGEX = /\x1B\[(?:<(?:\d+;(?:\d+;(?:\d+)?)?)?)?$/
const INCOMPLETE_ORPHAN_SGR_BODY_REGEX = /\[<\d*(?:;\d*){0,2}$/
const INCOMPLETE_DEC1000_MOUSE_REGEX = /\x1B\[M[^\x1B]{0,2}$/
const INCOMPLETE_ORPHAN_DEC1000_BODY_REGEX = /\[M(?:[\x20-\x23\x60-\x61][^\x1B]{0,1})?$/

// ── 安装 / 卸载 ──

let installed = false
/** 跨 chunk 边界的不完整鼠标序列前缀缓冲区。 */
let pendingBuffer = ""
/** stdin.read() 的原始实现。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalRead: ((size?: number) => any) | null = null

/**
 * 过滤单个 chunk：合并 pendingBuffer → 提取滚轮事件 → strip 鼠标序列 →
 * 检测不完整前缀 → 返回过滤后的字符串（可能为空字符串，表示全为鼠标序列）。
 */
function filterChunk(chunkStr: string): string {
  const raw = pendingBuffer + chunkStr
  pendingBuffer = ""

  // 提取滚轮事件（在 strip 之前解析）
  if (raw.includes("[<") || raw.includes("\x1B[M") || raw.includes("[M")) {
    extractScrollEvents(raw)
  }

  // strip 完整的鼠标序列和孤立序列体
  let filtered = stripOrphanMouseBodies(stripMouseSequences(raw))

  // 检查末尾是否有不完整的鼠标序列前缀（跨 chunk 边界）
  const incompleteMatch = filtered.match(INCOMPLETE_MOUSE_PREFIX_REGEX)
    ?? filtered.match(INCOMPLETE_ORPHAN_SGR_BODY_REGEX)
    ?? filtered.match(INCOMPLETE_DEC1000_MOUSE_REGEX)
    ?? filtered.match(INCOMPLETE_ORPHAN_DEC1000_BODY_REGEX)
  if (incompleteMatch) {
    pendingBuffer = incompleteMatch[0]
    filtered = filtered.slice(0, incompleteMatch.index)
  }

  return filtered
}

/**
 * 安装 stdin 过滤器，拦截鼠标序列并提取滚轮事件。
 *
 * Patch stdin.read() — Ink 通过 paused mode 的 'readable' 事件 + read() 读取输入，
 * 这是唯一的输入路径。每次 read() 返回的 chunk 在返回给调用方之前被过滤。
 *
 * 在 `startInkTUI` 中、`render()` 之前调用。
 * 幂等：重复调用安全。
 */
export function installStdinFilter(): void {
  if (installed) return
  if (!process.stdin || typeof process.stdin.read !== "function") return

  installed = true
  originalRead = process.stdin.read

  process.stdin.read = function (size?: number) {
    const chunk = originalRead!.call(process.stdin, size)
    if (chunk === null) return null

    const chunkStr: string = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    const filtered = filterChunk(chunkStr)

    if (filtered.length === 0) {
      // 全是鼠标序列 — 不返回数据给 Ink，等待下一批数据
      return null
    }

    // 保持与原始 chunk 相同的类型
    return typeof chunk === "string" ? filtered : Buffer.from(filtered, "utf8")
  } as typeof process.stdin.read
}

/** 卸载 stdin 过滤器，恢复原始 read。 */
export function uninstallStdinFilter(): void {
  if (!installed || !originalRead) return
  process.stdin.read = originalRead as typeof process.stdin.read
  originalRead = null
  installed = false
  pendingBuffer = ""
  mouseEvents.removeAllListeners("scroll")
}

/** 统一终端清理：恢复鼠标模式 + 卸载 stdin filter。
 *  所有退出路径（正常退出、Ctrl+C、SIGINT、/exit 命令）统一调用此函数。 */
export function cleanupTerminal(): void {
  process.stdout.write("\x1B[?25h") // 显示光标
  process.stdout.write("\x1B]0;\x07") // 重置终端标题
  disableMouseMode()
  uninstallStdinFilter()
}

/** 测试用：获取当前 pendingBuffer 状态（跨 chunk 缓冲区）。 */
export function _getPendingBuffer(): string {
  return pendingBuffer
}
