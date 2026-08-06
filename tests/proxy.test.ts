/** proxy.ts 单元测试 — 验证 env 代理 dispatcher 的安装逻辑。 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici"
import { applyEnvProxy } from "../src/proxy"

// proxy.ts 模块加载时会按当前环境副作用执行 applyEnvProxy()，
// 因此每个用例前重置 dispatcher 与 env，保证用例隔离。
const savedEnv = { ...process.env }

beforeEach(() => {
  setGlobalDispatcher(new Agent())
})

afterEach(() => {
  // 还原 process.env（先清掉用例新增的 key，再赋回保存值）
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  setGlobalDispatcher(new Agent())
})

describe("applyEnvProxy", () => {
  test("设置了 HTTPS_PROXY 时安装 EnvHttpProxyAgent", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890"
    applyEnvProxy()
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
  })

  test("小写 http_proxy 会被归一到大写 HTTP_PROXY", () => {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    process.env.http_proxy = "http://127.0.0.1:7890"
    applyEnvProxy()
    // delete 后 TS 把该 key 收窄成 undefined，需显式恢复为 string | undefined
    expect(process.env.HTTP_PROXY as string | undefined).toBe("http://127.0.0.1:7890")
  })

  test("没有代理 env 时保留默认 dispatcher", () => {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
    applyEnvProxy()
    expect(getGlobalDispatcher()).toBeInstanceOf(Agent)
  })
})
