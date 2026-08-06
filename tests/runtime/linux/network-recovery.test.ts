/** LNXF LF-7 acceptance: 网络代理、Landlock、seccomp 与恢复.
 *
 *  Gates: NETWORK_ALLOWLIST_BYPASS / REDIRECT_POLICY_BYPASS /
 *  RECOVERY_WRONG_PROCESS_KILL / SECRET_SURVIVES_RECOVERY / JANITOR_RESOURCE_LEAK.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEgressPolicy, checkEgressHop, checkEgressRedirect, dnsRebindingGuard, validateNetworkMode } from "../../../src/runtime/linux/network-policy"
import { compileLandlockRuleset, landlockUsable, compileSeccompProfile, seccompBackwardCompatible } from "../../../src/runtime/linux/landlock-seccomp"
import { RuntimeStateStore, BootIdentityStore, startupJanitor, readBootId, procStartTicksOf } from "../../../src/runtime/linux/recovery/state-store"
import { probeLinuxCapabilities } from "../../../src/runtime/linux/capability-probe"

describe("LF-7: egress policy", () => {
  test("allowlisted host+port passes; others rejected (NETWORK_ALLOWLIST_BYPASS: 0)", () => {
    const policy = buildEgressPolicy(["registry.npmjs.org", "*.example.com"], [80, 443])
    expect(checkEgressHop(policy, { host: "registry.npmjs.org", port: 443 }).allowed).toBe(true)
    expect(checkEgressHop(policy, { host: "registry.example.com", port: 443 }).allowed).toBe(true)
    expect(checkEgressHop(policy, { host: "evil.example.net", port: 443 }).allowed).toBe(false)
    expect(checkEgressHop(policy, { host: "registry.npmjs.org", port: 22 }).allowed).toBe(false)
  })

  test("redirects re-checked hop-by-hop (REDIRECT_POLICY_BYPASS: 0)", () => {
    const policy = buildEgressPolicy(["trusted.dev"], [443])
    const redirected = checkEgressRedirect(policy, { host: "trusted.dev", port: 443 }, { host: "evil.net", port: 443 })
    expect(redirected.allowed).toBe(false)
    expect(redirected.reason).toContain("redirect target rejected")
    const ok = checkEgressRedirect(policy, { host: "trusted.dev", port: 443 }, { host: "trusted.dev", port: 80 })
    expect(ok.allowed).toBe(false) // 80 不在 allowlist
  })

  test("dns rebinding guard rejects private IPs (DNS Rebinding)", () => {
    const policy = buildEgressPolicy(["api.trusted.com"], [443])
    expect(dnsRebindingGuard(policy, "api.trusted.com", "93.184.216.34").allowed).toBe(true)
    expect(dnsRebindingGuard(policy, "api.trusted.com", "127.0.0.1").allowed).toBe(false)
    expect(dnsRebindingGuard(policy, "api.trusted.com", "10.0.0.5").allowed).toBe(false)
    expect(dnsRebindingGuard(policy, "api.trusted.com", "192.168.1.1").allowed).toBe(false)
    expect(dnsRebindingGuard(policy, "evil.com", "93.184.216.34").allowed).toBe(false)
  })

  test("network modes validated", () => {
    expect(validateNetworkMode("none").ok).toBe(true)
    expect(validateNetworkMode("loopback").ok).toBe(true)
    expect(validateNetworkMode("full-approved").ok).toBe(true)
  })
})

describe("LF-7: landlock", () => {
  test("ruleset compiled per profile and ABI", () => {
    const caps = probeLinuxCapabilities()
    const inspect = compileLandlockRuleset(caps, "inspect")
    expect(inspect.abi).toBe(caps.landlock.abi ?? 0)
    if (inspect.abi >= 1) {
      expect(inspect.filesystem?.readable).toContain("/workspace")
      expect(inspect.filesystem?.writable).toEqual([]) // inspect 只读
    }
    const build = compileLandlockRuleset(caps, "build", "/wt")
    if (build.abi >= 1) {
      expect(build.filesystem?.writable).toContain("/workspace")
    }
  })

  test("unusable landlock reports reason (graceful degradation)", () => {
    const caps = probeLinuxCapabilities()
    const result = landlockUsable(caps)
    expect(typeof result.ok).toBe("boolean")
    if (!result.ok) expect(result.reason).toBeTruthy()
  })
})

describe("LF-7: seccomp", () => {
  test("conservative profiles block dangerous syscalls", () => {
    const untrusted = compileSeccompProfile("untrusted")
    expect(untrusted.defaultAction).toBe("SCMP_ACT_ERRNO")
    expect(untrusted.allowSyscalls).toContain("read")
    for (const denied of ["ptrace", "mount", "kexec_load", "bpf"]) {
      expect(untrusted.allowSyscalls.includes(denied)).toBe(false)
    }
    expect(untrusted.denySyscalls).toContain("ptrace")
  })

  test("node/bun runtimes get socket/epoll surfaces", () => {
    const node = compileSeccompProfile("node")
    expect(node.allowSyscalls).toContain("socket")
    expect(node.allowSyscalls).toContain("epoll_wait")
    const bun = compileSeccompProfile("bun")
    expect(bun.allowSyscalls).toContain("socket")
  })

  test("ruleset changes stay backward compatible", () => {
    const oldProfile = compileSeccompProfile("untrusted")
    const newProfile = compileSeccompProfile("inspect")
    expect(seccompBackwardCompatible(oldProfile, newProfile)).toBe(true)
    // 移除未声明拒绝的调用 → 不兼容
    const broken = { ...newProfile, allowSyscalls: newProfile.allowSyscalls.filter(s => s !== "read") }
    expect(seccompBackwardCompatible(oldProfile, broken)).toBe(false)
  })
})

describe("LF-7: recovery", () => {
  test("state store persists runs and receipts", () => {
    const root = mkdtempSync(join(tmpdir(), "lnxf-state-"))
    try {
      const store = new RuntimeStateStore({ root })
      store.writeRun("r1", { status: "running" })
      store.appendReceipt("r1", { cellId: "c1", backend: "bubblewrap" })
      expect(store.readRun("r1")?.status).toBe("running")
      expect(store.listRuns()).toEqual(["r1"])
      store.removeRun("r1")
      expect(store.listRuns()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("janitor cleans only stale-boot runs (RECOVERY_WRONG_PROCESS_KILL: 0)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lnxf-janitor-"))
    try {
      const store = new RuntimeStateStore({ root })
      const boot = new BootIdentityStore(store)
      boot.recordBoot("boot-A")
      store.writeRun("fresh", { status: "running" })
      // 新 boot：janitor 只清旧 boot 的 run
      const current = "boot-B"
      const receipts = await startupJanitor({
        store,
        currentBootId: current,
        cleanupRun: async runId => ({ cgroups: [runId], worktrees: [], ports: 0, containers: [], stateRemoved: true }),
      })
      // fresh 是 boot-A 记录的（当前 boot-B）→ 应被清理
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.runId).toBe("fresh")
      expect(receipts[0]!.cleaned.cgroups).toEqual(["fresh"])
      expect(boot.lastBoot()).toBe("boot-B")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("same-boot restart cleans only runs whose owner process is dead (PR-7)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lnxf-janitor2-"))
    try {
      const store = new RuntimeStateStore({ root })
      const boot = new BootIdentityStore(store)
      boot.recordBoot("boot-X")
      // live：owner 是本进程（存活）→ 同 boot 保留
      store.writeRun("live", { status: "running", ownerPid: process.pid, ownerProcStartTicks: procStartTicksOf(process.pid) })
      // dead-owner：owner 进程不存在 → 同 boot 清理（崩溃恢复）
      store.writeRun("crashed", { status: "running", ownerPid: 999999, ownerProcStartTicks: 1 })
      // no-owner：无 token（旧格式/无法判定）→ 保守清理
      store.writeRun("unknown", { status: "running" })
      const receipts = await startupJanitor({ store, currentBootId: "boot-X" })
      const cleaned = receipts.map(r => r.runId).sort()
      expect(cleaned).toEqual(["crashed", "unknown"])
      expect(store.readRun("live")).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("boot id is readable on linux", () => {
    expect(readBootId().length).toBeGreaterThan(0)
  })
})
