/** 环境代理接入 — 让 Node 运行时的 fetch 走 HTTP(S)_PROXY。
 *
 *  Node 的全局 fetch（undici）默认忽略 HTTP(S)_PROXY 环境变量，而 Bun 的
 *  fetch 原生遵守，导致同一份配置在 Node 下报 network、Bun 下正常。当检测到
 *  代理时，安装 EnvHttpProxyAgent 为全局 dispatcher，provider 请求即走代理；
 *  NO_PROXY 会被尊重，本地流量（LSP、MCP、知识库等）保持直连。
 *
 *  必须在任何请求发起之前被 import —— 模块加载时副作用执行，模式同 env-compat。
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici"

/** 把常见的小写代理变量补齐到大写形式（EnvHttpProxyAgent 只读大写）。 */
function normalizeProxyEnv(): void {
  for (const [lower, upper] of [
    ["http_proxy", "HTTP_PROXY"],
    ["https_proxy", "HTTPS_PROXY"],
    ["no_proxy", "NO_PROXY"],
  ] as const) {
    if (process.env[lower] && process.env[upper] === undefined) {
      process.env[upper] = process.env[lower]
    }
  }
}

export function applyEnvProxy(): void {
  normalizeProxyEnv()
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (!proxy) return
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent())
  } catch (error) {
    // 非致命：代理装不上就继续用当前 dispatcher（例如代理 URL 非法）。
    console.warn(`[proxy] 安装 EnvHttpProxyAgent 失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// 模块加载时即执行 —— 保持与 env-compat 一致的模式。
applyEnvProxy()
