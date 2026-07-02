/** stdin-filter — 拦截 stdin 中的鼠标序列，防止泄漏到 react-ink-textarea。
 *
 *  背景：
 *    PR-3 用 react-ink-textarea 替换了旧的 InputLine。旧 InputLine 在 useInput
 *    handler 开头有 isMouseSequence(input) 过滤，但 TextArea 的 useKeyboardInput
 *    没有——其 fallback 分支（useKeyboardInput.ts 第 356-362 行）会插入任何非空
 *    input，包括 `\x1B[<0;40;10M` 这样的 SGR 鼠标序列，导致滚轮在输入框产生乱码。
 *
 *  方案：
 *    Ink 的 useInput 没有 stopPropagation，无法在 React 层阻止 TextArea 收到鼠标序列。
 *    因此在 stdin 层面 patch emit('data', ...)，在数据到达 Ink 之前移除鼠标序列。
 *
 *  鼠标滚轮支持：
 *    解析 SGR 鼠标序列中的滚轮事件（button 64 = 向上, button 65 = 向下），
 *    通过 EventEmitter 发出 scroll 事件，ChatApp 监听后调用 scrollUp/scrollDown。
 *    所有鼠标序列（包括滚轮）仍然被 strip，不会到达 TextArea。
 *
 *  支持的鼠标序列：
 *    - SGR (DEC 1006): `\x1B[<button;col;rowM` 或 `\x1B[<button;col;rowm`
 *    - 普通鼠标 (DEC 1000): `\x1B[M` + 3 个字节（button, col, row）
 *    - urxvt (1015): `\x1B[button;col;rowM`
 *
 *  必须在 Ink render 之前调用 installStdinFilter()。
 *  启用鼠标模式：startInkTUI 中写入 `\x1B[?1006h\x1B[?1000h`
 */

import { EventEmitter } from "events"

// ── 鼠标滚轮事件 ──

/** 鼠标事件总线。ChatApp 监听 "scroll" 事件实现滚轮滚动。 */
export const mouseEvents = new EventEmitter()

// SGR 鼠标序列：\x1B[<button;col;rowM 或 m
const SGR_MOUSE_REGEX = /\x1B\[<(\d+);\d+;\d+[mM]/g

/** 从原始数据中提取滚轮事件并发出 scroll 事件。 */
function extractScrollEvents(data: string): void {
  SGR_MOUSE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SGR_MOUSE_REGEX.exec(data)) !== null) {
    const button = parseInt(match[1], 10)
    // SGR 滚轮编码：64 = 向上滚, 65 = 向下滚
    // 带修饰键的滚轮：68 = Ctrl+向上, 69 = Ctrl+向下
    if (button === 64 || button === 68) {
      mouseEvents.emit("scroll", -1, button === 68)
    } else if (button === 65 || button === 69) {
      mouseEvents.emit("scroll", 1, button === 69)
    }
  }
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

/** 启用 SGR 鼠标模式（DEC 1006 + DEC 1000）。 */
export function enableMouseMode(): void {
  process.stdout.write("\x1B[?1006h\x1B[?1000h")
}

/** 禁用鼠标模式。 */
export function disableMouseMode(): void {
  process.stdout.write("\x1B[?1000l\x1B[?1006l")
}

// ── 跨 chunk 边界处理 ──

/**
 * 匹配末尾可能不完整的 SGR 鼠标序列前缀。
 *
 * 终端快速滚动时，TCP/管道可能将一个鼠标序列拆分到多个 data chunk。
 * 例如 chunk1 = "\x1B[<64;40;", chunk2 = "10M"。如果只按完整序列匹配，
 * 不完整前缀会漏 strip，到达 Ink 后产生乱码。
 *
 * 此正则匹配以 \x1B[ 开头的不完整前缀：
 *   \x1B[, \x1B[<, \x1B[<64, \x1B[<64;, \x1B[<64;40, \x1B[<64;40;, \x1B[<64;40;10
 *
 * 注意：不匹配单独的 \x1B（ESC 键），避免 Esc 取消 clarification 等功能延迟。
 * 跨 chunk 将 \x1B 和 [ 分开的情况极罕见（终端通常一次发完整序列），可接受。
 */
const INCOMPLETE_MOUSE_PREFIX_REGEX = /\x1B\[(?:<(?:\d+;(?:\d+;(?:\d+)?)?)?)?$/

// ── 安装 / 卸载 ──

let installed = false
/** 跨 chunk 边界的不完整鼠标序列前缀缓冲区。 */
let pendingBuffer = ""
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalEmit: ((event: string | symbol, ...args: any[]) => boolean) | null = null

/**
 * 安装 stdin 过滤器，拦截鼠标序列并提取滚轮事件。
 *
 * 在 `startInkTUI` 中、`render()` 之前调用。
 * 幂等：重复调用安全。
 *
 * 跨 chunk 边界处理：
 *   维护 pendingBuffer，当 chunk 末尾有不完整的鼠标序列前缀时（如 \x1B 或 \x1B[<64），
 *   保留在 buffer 中等待下一个 chunk 合并处理，避免漏 strip 导致乱码。
 */
export function installStdinFilter(): void {
  if (installed) return
  if (!process.stdin || typeof process.stdin.emit !== "function") return

  installed = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalEmit = process.stdin.emit as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdin.emit = function (event: string | symbol, ...args: any[]): boolean {
    if (event === "data" && args.length > 0) {
      const chunk = args[0]
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        const chunkStr = typeof chunk === "string" ? chunk : chunk.toString("utf8")
        // 合并 pendingBuffer 和新数据，处理跨 chunk 边界的鼠标序列
        const raw = pendingBuffer + chunkStr
        pendingBuffer = ""

        // 提取滚轮事件（在 strip 之前解析）
        if (raw.includes("\x1B[<")) {
          extractScrollEvents(raw)
        }

        // strip 完整的鼠标序列
        let filtered = stripMouseSequences(raw)

        // 检查末尾是否有不完整的鼠标序列前缀（跨 chunk 边界）
        // 如果有，保留在 pendingBuffer 中，等下一个 chunk 合并处理
        const incompleteMatch = filtered.match(INCOMPLETE_MOUSE_PREFIX_REGEX)
        if (incompleteMatch) {
          pendingBuffer = incompleteMatch[0]
          filtered = filtered.slice(0, incompleteMatch.index)
        }

        if (filtered.length === 0) {
          // 没有数据要 emit（全是鼠标序列，或只有不完整前缀等待下一个 chunk）
          return false
        }

        // 用过滤后的数据替换第一个参数
        const newChunk =
          typeof chunk === "string" ? filtered : Buffer.from(filtered, "utf8")
        return originalEmit!.call(process.stdin, event, newChunk, ...args.slice(1))
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalEmit!.call(process.stdin, event as string, ...args as any[])
  } as typeof process.stdin.emit
}

/** 卸载 stdin 过滤器，恢复原始 emit。 */
export function uninstallStdinFilter(): void {
  if (!installed || !originalEmit) return
  process.stdin.emit = originalEmit as typeof process.stdin.emit
  originalEmit = null
  installed = false
  pendingBuffer = ""
  mouseEvents.removeAllListeners("scroll")
}

/** 测试用：获取当前 pendingBuffer 状态（跨 chunk 缓冲区）。 */
export function _getPendingBuffer(): string {
  return pendingBuffer
}
