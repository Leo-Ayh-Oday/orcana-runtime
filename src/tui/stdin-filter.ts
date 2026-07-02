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
 *  支持的鼠标序列：
 *    - SGR (DEC 1006): `\x1B[<button;col;rowM` 或 `\x1B[<button;col;rowm`
 *    - 普通鼠标 (DEC 1000): `\x1B[M` + 3 个字节（button, col, row）
 *    - urxvt (1015): `\x1B[button;col;rowM`
 *
 *  必须在 Ink render 之前调用 installStdinFilter()。
 */

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

// ── 安装 / 卸载 ──

let installed = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalEmit: ((event: string | symbol, ...args: any[]) => boolean) | null = null

/**
 * 安装 stdin 过滤器，拦截鼠标序列。
 *
 * 在 `startInkTUI` 中、`render()` 之前调用。
 * 幂等：重复调用安全。
 */
export function installStdinFilter(): void {
  if (installed) return
  if (!process.stdin || typeof process.stdin.emit !== "function") return

  installed = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalEmit = process.stdin.emit.bind(process.stdin) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdin.emit = function (event: string | symbol, ...args: any[]): boolean {
    if (event === "data" && args.length > 0) {
      const chunk = args[0]
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8")
        const filtered = stripMouseSequences(raw)
        if (filtered !== raw) {
          if (filtered.length === 0) {
            // 全是鼠标序列，吞掉这个 data 事件
            return false
          }
          // 用过滤后的数据替换第一个参数
          const newChunk =
            typeof chunk === "string" ? filtered : Buffer.from(filtered, "utf8")
          return originalEmit!(event, newChunk, ...args.slice(1))
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalEmit!(event as string, ...args as any[])
  } as typeof process.stdin.emit
}

/** 卸载 stdin 过滤器，恢复原始 emit。 */
export function uninstallStdinFilter(): void {
  if (!installed || !originalEmit) return
  process.stdin.emit = originalEmit as typeof process.stdin.emit
  originalEmit = null
  installed = false
}
