/** useStablePrefix — PR-6: stable-prefix 锁定算法。
 *
 *  规则（spec D.4）：
 *    - 仅对 unstable suffix 重新 parse，stable prefix 缓存
 *    - 防御性 reset：文本被替换（非前缀扩展）时重置
 *    - 找到最后一个块边界（段落 \n\n），锁定前缀
 *    - stable prefix 用 useMemo 缓存，永不重 parse
 *    - unstable suffix 每次 delta 重新 lex
 *
 *  注意：本项目不使用 marked，formatDisplayText 是基于 \n + 表格识别的简单 formatter。
 *  因此 stable-prefix 的"块边界"采用段落分隔符 \n\n — 表格行内无 \n\n，
 *  所以表格不会跨越 stable/unstable 边界，formatting 结果与整体 format 等价。
 *
 *  使用方式：
 *    const { stable, unstable } = useStablePrefix(text)
 *    const stableLines = useMemo(() => formatDisplayText(stable, width), [stable, width])
 *    const unstableLines = formatDisplayText(unstable, width)
 */

import { useRef } from "react"

/** 纯函数：根据 prevStable 和当前 text，计算新的 stable 边界。
 *  抽离为纯函数便于单元测试。 */
export function advanceStablePrefix(prevStable: string, text: string): string {
  // 防御性 reset：text 不是 prevStable 的扩展（被替换）
  if (prevStable.length > 0 && !text.startsWith(prevStable)) {
    return ""
  }

  // 在新增部分中找最后一个段落边界 \n\n
  const newPortion = text.substring(prevStable.length)
  const lastBoundary = newPortion.lastIndexOf("\n\n")
  if (lastBoundary < 0) {
    return prevStable // 没有新边界，不推进
  }

  // 推进 stable 到包含 \n\n
  const advance = lastBoundary + 2 // 包含 \n\n
  return text.substring(0, prevStable.length + advance)
}

export interface StablePrefixState {
  /** 已锁定的前缀（可安全缓存 format 结果）。 */
  stable: string
  /** 未锁定的后缀（每次 delta 重新 format）。 */
  unstable: string
}

/** stable-prefix 锁定 hook。
 *  内部用 useRef 持久化 stable 边界，跨渲染保持。
 *  文本被替换（非扩展）时自动重置。 */
export function useStablePrefix(text: string): StablePrefixState {
  const stableRef = useRef("")
  stableRef.current = advanceStablePrefix(stableRef.current, text)
  return {
    stable: stableRef.current,
    unstable: text.substring(stableRef.current.length),
  }
}
