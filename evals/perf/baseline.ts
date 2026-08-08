#!/usr/bin/env bun
/** LR2-2（P2-E）：性能基线 —— 冷启动 / 热启动（Plan Cache 命中）/
 *  CAS 写读 / Overlay 创建。
 *
 *  先基线后阈值（计划要求：不得在没有基线的情况下随意规定性能数字）。
 *  运行：bun run evals/perf/baseline.ts
 *  输出：JSON 基线（硬件/内核/后端版本 + 各指标 p50/p95）。
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { PlanCache } from "../../src/runtime/linux/cache/plan-cache"
import { ContentAddressedStore } from "../../src/runtime/linux/cache/cas"
import { compileCapabilityRequestCached } from "../../src/runtime/linux/policy-compiler"
import { GitWorktreeOverlay, detectOverlayBackend } from "../../src/runtime/linux/workspace/overlay"
import type { TrustedExecutionAuthority } from "../../src/runtime/linux/contracts"

const N = 50 // 采样次数

function measure(fn: () => void, samples = N): { p50: number; p95: number; avg: number } {
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(samples * 0.5)]!
  const p95 = times[Math.floor(samples * 0.95)]!
  const avg = times.reduce((a, b) => a + b, 0) / samples
  return { p50, p95, avg }
}

function authority(hostRoot: string): TrustedExecutionAuthority {
  return {
    identity: { runId: "perf-run", nodeRunId: "perf-run:n1", attempt: 1 },
    workspace: {
      workspaceId: "perf-ws", projectId: "perf", hostRoot, kind: "main",
      access: "readwrite", physicalWorkspaceKey: "wp_perf", ownerFiles: [],
    },
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "perf-"))
  const ws = join(dir, "ws")
  const repo = join(dir, "repo")
  const workRoot = join(dir, "work")
  const { mkdirSync, writeFileSync } = await import("node:fs")
  mkdirSync(ws)
  mkdirSync(repo)
  mkdirSync(workRoot)

  // 小 git 仓库（Overlay 基线用）
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "perf@orcana.local"], { cwd: repo, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "perf"], { cwd: repo, stdio: "ignore" })
  for (let i = 0; i < 20; i++) writeFileSync(join(repo, `f${i}.txt`), `content ${i}\n`)
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" })
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo, stdio: "ignore" })

  try {
    const request = { command: { executable: "/bin/true", args: ["--flag"], relativeCwd: ".", stdin: "closed" as const }, profile: "build" as const }

    // 1. 冷启动：无缓存全编译（每次新 PlanCache）
    const cold = measure(() => {
      const cache = new PlanCache()
      compileCapabilityRequestCached(request, authority(ws), cache, ws)
    })

    // 2. 热启动：同缓存命中（仅注入身份）
    const warmCache = new PlanCache()
    compileCapabilityRequestCached(request, authority(ws), warmCache, ws) // 预热
    const warm = measure(() => {
      compileCapabilityRequestCached(request, authority(ws), warmCache, ws)
    })

    // 3. CAS 写入 + 读取
    const cas = new ContentAddressedStore({ root: join(dir, "cas") })
    const payload = Buffer.from("x".repeat(64 * 1024))
    const casWrite = measure(() => { cas.put(payload, { ok: true, runId: "perf" }) }, 20)
    cas.put(payload, { ok: true, runId: "perf" })
    const casRead = measure(() => { cas.read(cas.record(cas.list()[0]!.digest)!.digest) }, 20)

    // 4. Overlay（git-worktree）创建
    const overlay = new GitWorktreeOverlay()
    let overlayInst: ReturnType<GitWorktreeOverlay["create"]> | undefined
    const overlayCreate = measure(() => {
      overlayInst?.discard()
      overlayInst = overlay.create(repo, "HEAD", workRoot, `perf-${Math.random().toString(36).slice(2, 6)}`)
    }, 10)
    overlayInst?.discard()

    const baseline = {
      recordedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
      bun: process.versions.bun ?? "unknown",
      overlayBackend: detectOverlayBackend(),
      metrics: {
        planCompileColdMs: cold,
        planCompileWarmMs: warm,
        planSpeedup: (cold.p50 / warm.p50).toFixed(1),
        casWriteMs: casWrite,
        casReadMs: casRead,
        overlayCreateMs: overlayCreate,
      },
    }
    console.log(JSON.stringify(baseline, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
