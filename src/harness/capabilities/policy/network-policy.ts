/** Tool Runtime 2.0 (RT-5): network policy — the canonical network tool set
 *  and the web-search-failure gate. SSRF/IP-level checks land with the
 *  fetch hardening (RT-11); this module owns the declarative boundary.
 */

export const NETWORK_TOOL_NAMES = ["web_fetch", "web_search", "exa_web_search_exa"] as const

export function isNetworkTool(name: string): boolean {
  return (NETWORK_TOOL_NAMES as readonly string[]).includes(name)
}

export interface NetworkGateDecision {
  reason: "web_search_failed"
  blockMessage: string
  priority: 7
}

/** Gate: a failed web search this turn blocks further web_search calls
 *  (existing Gate 7 semantics extracted — the block message tells the model
 *  the recovery options instead of silently retrying). */
export function networkToolBlocked(
  toolName: string,
  webSearchFailedThisTurn: boolean,
  webSearchFailReason: string,
): NetworkGateDecision | null {
  if (toolName !== "web_search" || !webSearchFailedThisTurn) return null
  return {
    reason: "web_search_failed",
    blockMessage: `⚠️ 网页搜索不可用：${webSearchFailReason || "SearXNG Docker 未运行"}。\n\n解决方案（你来决定）：\n1) 启动 SearXNG Docker 容器修复搜索\n2) 用 web_fetch 直接访问已知 URL\n3) 用本地代码搜索 (findstr / grep) 代替\n4) 向用户报告搜索不可用，继续现有的本地分析`,
    priority: 7,
  }
}
