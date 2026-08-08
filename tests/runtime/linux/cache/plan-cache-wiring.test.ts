/** LR2-2（P2-D）：Plan Cache 接线验收 —— 同 workspace 同策略第二次
 *  命中（跳过完整编译）；命中产物与全编译等价（策略字段一致、身份不同）；
 *  跨 workspace 不共享。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlanCache } from "../../../../src/runtime/linux/cache/plan-cache"
import { compileCapabilityRequest, compileCapabilityRequestCached } from "../../../../src/runtime/linux/policy-compiler"
import { createLinuxBroker } from "../../../../src/runtime/linux/broker"
import type { TrustedExecutionAuthority, UntrustedCapabilityRequest } from "../../../../src/runtime/linux/contracts"

function wsAuthority(hostRoot: string, runId: string): TrustedExecutionAuthority {
  return {
    identity: { runId, nodeRunId: `${runId}:n1`, attempt: 1 },
    workspace: {
      workspaceId: "ws", projectId: "p", hostRoot, kind: "main",
      access: "readwrite", physicalWorkspaceKey: `wp_${runId}`, ownerFiles: [],
    },
  }
}

function request(overrides: Partial<UntrustedCapabilityRequest> = {}): UntrustedCapabilityRequest {
  return {
    command: { executable: "/bin/true", args: ["--flag"], relativeCwd: ".", stdin: "closed" },
    profile: "build",
    ...overrides,
  }
}

describe("Plan Cache wiring (P2-D)", () => {
  test("same workspace same request: second compile hits the cache with fresh identity", () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-ws-"))
    try {
      const cache = new PlanCache()
      const auth1 = wsAuthority(ws, "run-1")
      const first = compileCapabilityRequestCached(request(), auth1, cache, ws)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = compileCapabilityRequestCached(request(), wsAuthority(ws, "run-2"), cache, ws)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      // 命中：策略字段一致，身份不同
      expect(second.spec.policyDigest).toBe(first.spec.policyDigest)
      expect(second.spec.filesystem).toEqual(first.spec.filesystem)
      expect(second.spec.environment).toEqual(first.spec.environment)
      expect(second.spec.identity.cellId).not.toBe(first.spec.identity.cellId)
      expect(second.spec.identity.runId).toBe("run-2")
      expect(cache.size).toBe(1)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("different workspace never shares the template (cross-workspace isolation)", () => {
    const ws1 = mkdtempSync(join(tmpdir(), "pc-ws1-"))
    const ws2 = mkdtempSync(join(tmpdir(), "pc-ws2-"))
    try {
      const cache = new PlanCache()
      const r1 = compileCapabilityRequestCached(request(), wsAuthority(ws1, "r1"), cache, ws1)
      const r2 = compileCapabilityRequestCached(request(), wsAuthority(ws2, "r2"), cache, ws2)
      expect(r1.ok && r2.ok).toBe(true)
      if (r1.ok && r2.ok) {
        expect(r2.spec.filesystem.worktreeRoot).toBe(ws2)
        expect(r1.spec.filesystem.worktreeRoot).toBe(ws1)
      }
      expect(cache.size).toBe(2) // 两个 workspace 各一份模板
    } finally {
      rmSync(ws1, { recursive: true, force: true })
      rmSync(ws2, { recursive: true, force: true })
    }
  })

  test("B1: different timeoutMs/memory never share the cached template", () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-ws-"))
    try {
      const cache = new PlanCache()
      const a = compileCapabilityRequestCached(request({ timeoutMs: 5000, memoryMaxBytes: 64 * 1024 * 1024 }), wsAuthority(ws, "r1"), cache, ws)
      expect(a.ok).toBe(true)
      const b = compileCapabilityRequestCached(request({ timeoutMs: 120_000, memoryMaxBytes: 2 * 1024 * 1024 * 1024 }), wsAuthority(ws, "r2"), cache, ws)
      expect(b.ok).toBe(true)
      if (a.ok && b.ok) {
        // 键含资源分量 → 不共享（b 保留自己的声明值）
        expect(b.spec.resources.wallTimeMs).not.toBe(a.spec.resources.wallTimeMs)
        expect(cache.size).toBe(2)
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("B1: cwd escape is rejected even on cache hit (no validation bypass)", () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-ws-"))
    try {
      const cache = new PlanCache()
      const first = compileCapabilityRequestCached(request(), wsAuthority(ws, "r1"), cache, ws)
      expect(first.ok).toBe(true)
      // 命中路径：恶意 relativeCwd（越界）必须被拒绝 —— 不能放行旧模板
      const escaped = compileCapabilityRequestCached(
        request({ command: { executable: "/bin/true", args: [], relativeCwd: "../etc", stdin: "closed" } }),
        wsAuthority(ws, "r2"), cache, ws,
      )
      expect(escaped.ok).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("broker compileRequest honors the plan cache", () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-ws-"))
    try {
      const cache = new PlanCache()
      const broker = createLinuxBroker({ mode: "enabled", planCache: cache })
      const spec1 = broker.compileRequest(request(), wsAuthority(ws, "r1"))
      const spec2 = broker.compileRequest(request(), wsAuthority(ws, "r2"))
      expect(spec2.policyDigest).toBe(spec1.policyDigest)
      expect(spec2.identity.cellId).not.toBe(spec1.identity.cellId)
      // 与全编译等价（无缓存时编译结果策略一致）
      const full = compileCapabilityRequest(request(), wsAuthority(ws, "r3"))
      if (full.ok) {
        expect(full.spec.policyDigest).toBe(spec1.policyDigest)
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
