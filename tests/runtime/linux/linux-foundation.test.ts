/** LNXF LF-1 acceptance: 契约、能力探测与 shadow 模式.
 *
 *  Gates: LINUX_CAPABILITY_PROBE / CELL_SPEC_SCHEMA / RECEIPT_SCHEMA /
 *  BEHAVIOR_CHANGE.
 */

import { describe, expect, test } from "bun:test"
import { platform } from "node:os"
import { probeLinuxCapabilities, capabilitiesDigest } from "../../../src/runtime/linux/capability-probe"
import { validateCellSpec, compileCellSpec, compileCapabilityRequest, validateMountSet, validateMountRule, deepFreeze } from "../../../src/runtime/linux/policy-compiler"
import { buildReceipt, cellSpecDigest, computePolicyDigest, canonicalJson, receiptComplete } from "../../../src/runtime/linux/receipt"
import { applyProfileDefaults, profileDefaults, isStrictProfile } from "../../../src/runtime/linux/profiles"
import { selectBackend, backendAvailability } from "../../../src/runtime/linux/backend-router"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { LinuxExecutionError } from "../../../src/runtime/linux/errors"
import type { ExecutionCellSpec } from "../../../src/runtime/linux/contracts"

const linuxOnly = platform() === "linux" ? test : test.skip

function baseSpec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1, agentId: "a1" },
    command: { executable: "/bin/true", args: [], cwd: "/workspace", stdin: "closed" },
    profile: "build",
    isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: true },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/workspace" },
    network: { mode: "none" },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024 * 1024 * 1024, pidsMax: 128, wallTimeMs: 60_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

describe("LF-1: capability probe", () => {
  linuxOnly("cgroup v2 detected with explicit controllers and reasons", () => {
    const caps = probeLinuxCapabilities({ refresh: true })
    expect(caps.schemaVersion).toBe("1.0")
    expect(caps.platform).toBe("linux")
    expect(caps.bootId.length).toBeGreaterThan(0)
    expect([0, 1, 2]).toContain(caps.cgroup.version)
    if (caps.cgroup.version === 2) {
      expect(caps.cgroup.supportsKill).toBe(true)
      expect(caps.cgroup.mountPath).toBe("/sys/fs/cgroup")
      expect(Array.isArray(caps.cgroup.controllers)).toBe(true)
    }
    // 降级原因永远明确（不允许评分掩盖）
    expect(Array.isArray(caps.degradationReasons)).toBe(true)
  })

  linuxOnly("capability digest is stable across probes (bootId excluded)", () => {
    const a = capabilitiesDigest(probeLinuxCapabilities({ refresh: true }))
    const b = capabilitiesDigest(probeLinuxCapabilities({ refresh: true }))
    expect(a).toBe(b)
    expect(a.length).toBe(16)
  })

  linuxOnly("bubblewrap/podman availability is explicit", () => {
    const caps = probeLinuxCapabilities({ refresh: true })
    expect(typeof caps.bubblewrap.available).toBe("boolean")
    expect(typeof caps.podman.available).toBe("boolean")
    expect(typeof caps.seccomp.available).toBe("boolean")
  })
})

describe("LF-1: cell spec schema", () => {
  test("valid spec compiles with policyDigest", () => {
    const result = compileCellSpec(baseSpec())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.policyDigest.length).toBe(16)
      expect(result.spec.policyDigest).toBe(computePolicyDigest(result.spec))
    }
  })

  test("inheritHost must be false", () => {
    const bad = baseSpec()
    const env = { ...bad.environment }
    const result = validateCellSpec({ ...bad, environment: { ...env, inheritHost: true } as unknown as ExecutionCellSpec["environment"] })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("inheritHost"))).toBe(true)
  })

  test("missing identity is rejected", () => {
    const bad = baseSpec({ identity: { ...baseSpec().identity, cellId: "" } })
    expect(validateCellSpec(bad).ok).toBe(false)
  })

  test("proxy-allowlist requires allowedHosts", () => {
    const bad = baseSpec({ network: { mode: "proxy-allowlist" } })
    expect(validateCellSpec(bad).ok).toBe(false)
  })

  test("spec is serializable and hashable (replayable)", () => {
    const spec = baseSpec()
    const roundTrip = JSON.parse(JSON.stringify(spec)) as ExecutionCellSpec
    expect(cellSpecDigest(roundTrip)).toBe(cellSpecDigest(spec))
  })

  test("tampered policyDigest is rejected", () => {
    const bad = baseSpec({ policyDigest: "deadbeefdeadbeef" })
    expect(validateCellSpec(bad).ok).toBe(false)
  })
})

describe("LF-1: mount policy", () => {
  test("credential paths are forbidden", () => {
    const result = validateMountRule({ source: "/home/user/.ssh", target: "/home/orcana/.ssh", mode: "ro", required: true, recursive: false })
    expect(result.ok).toBe(false)
  })

  test("docker socket is forbidden", () => {
    const result = validateMountRule({ source: "/run/docker.sock", target: "/run/docker.sock", mode: "ro", required: true, recursive: false })
    expect(result.ok).toBe(false)
  })

  test("missing required source is rejected", () => {
    const result = validateMountRule({ source: "/nonexistent-xyz", target: "/x", mode: "ro", required: true, recursive: false })
    expect(result.ok).toBe(false)
  })

  test("duplicate targets and parent/child conflicts are rejected", () => {
    const set = validateMountSet([
      { source: "/usr", target: "/usr", mode: "ro", required: true, recursive: true },
      { source: "/bin", target: "/usr", mode: "ro", required: true, recursive: false }, // duplicate target
      { source: "/etc", target: "/usr/bin", mode: "ro", required: true, recursive: false }, // child of /usr
    ])
    expect(set.ok).toBe(false)
    expect(set.errors.some(e => e.includes("duplicate"))).toBe(true)
    expect(set.errors.some(e => e.includes("parent/child"))).toBe(true)
  })

  test("relative source is rejected", () => {
    const result = validateMountRule({ source: "relative/path", target: "/x", mode: "ro", required: true, recursive: false })
    expect(result.ok).toBe(false)
  })
})

describe("LF-1: profiles", () => {
  test("seven profiles exist with correct strictness", () => {
    expect(Object.keys(profileDefaults("inspect"))).toBeDefined()
    expect(isStrictProfile("untrusted")).toBe(true)
    expect(isStrictProfile("evolution")).toBe(true)
    expect(isStrictProfile("test")).toBe(true)
    expect(isStrictProfile("dependency")).toBe(true)
    expect(isStrictProfile("service")).toBe(true)
    expect(isStrictProfile("inspect")).toBe(false)
    expect(isStrictProfile("build")).toBe(false)
  })

  test("profile defaults applied to a spec", () => {
    const spec = applyProfileDefaults(
      { cellId: "c", runId: "r", nodeRunId: "r:n", attempt: 1 },
      { executable: "/bin/ls", args: [], cwd: "/workspace", stdin: "closed" },
      "untrusted",
    )
    expect(spec.isolation.minimum).toBe("container")
    expect(spec.isolation.allowDegradation).toBe(false)
    expect(spec.network.mode).toBe("none")
    expect(spec.resources.pidsMax).toBe(64)
    expect(spec.filesystem.emptyHome).toBe(true)
    expect(spec.lifecycle.serviceMode).toBe(false)
  })
})

describe("LF-1: backend router", () => {
  test("strict profile refuses degradation when backend unavailable", () => {
    const caps = probeLinuxCapabilities({ refresh: true })
    if (platform() !== "linux") return
    const spec = baseSpec({ profile: "untrusted", isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: false } })
    if (!caps.podman.available) {
      expect(() => selectBackend(spec, caps)).toThrow(LinuxExecutionError)
      expect(() => selectBackend(spec, caps)).toThrow(/DEGRADATION_NOT_ALLOWED|ISOLATION_REQUIREMENT_UNMET/)
    }
  })

  test("host audit never selected for minimum=namespace (fail-closed)", () => {
    const caps = probeLinuxCapabilities({ refresh: true })
    if (platform() !== "linux") return
    const spec = baseSpec({ isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: true } })
    // host-audit 仅在 minimum=audit 时可选；本机无 bwrap/podman →
    // 必须拒绝（ISOLATION_REQUIREMENT_UNMET），永不静默选 host-audit。
    if (!caps.bubblewrap.available && !caps.podman.available) {
      expect(() => selectBackend(spec, caps)).toThrow(/ISOLATION_REQUIREMENT_UNMET|DEGRADATION_NOT_ALLOWED/)
      return
    }
    const selection = selectBackend(spec, caps)
    expect(selection.backend === "host-audit").toBe(false)
  })

  test("backend availability list always includes all three", () => {
    const caps = probeLinuxCapabilities({ refresh: true })
    const list = backendAvailability(caps)
    expect(list.map(a => a.id)).toEqual(["host-audit", "bubblewrap", "rootless-podman"])
    expect(list[0]!.available).toBe(true)
  })
})

describe("LF-1: receipt schema", () => {
  test("receipt binds all digests and identity", () => {
    const spec = baseSpec()
    const caps = probeLinuxCapabilities({ refresh: true })
    const receipt = buildReceipt({
      spec,
      capabilities: caps,
      backend: "bubblewrap",
      backendVersion: "0.11",
      startedAt: 1000,
      finishedAt: 1500,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomKilled: false,
      pidLimitHit: false,
      outputLimitHit: false,
      tempLimitHit: false,
      observedWrites: ["/workspace/a.ts"],
      unexpectedWrites: [],
      violations: [],
      degradationReasons: [],
    })
    expect(receipt.schemaVersion).toBe("1.0")
    expect(receipt.cellId).toBe("c1")
    expect(receipt.runId).toBe("r1")
    expect(receipt.nodeRunId).toBe("r1:n1")
    expect(receipt.backend).toBe("bubblewrap")
    expect(receipt.cellSpecDigest).toBe(cellSpecDigest(spec))
    expect(receipt.durationMs).toBe(500)
    expect(receipt.observedWrites).toContain("/workspace/a.ts")
    expect(receipt.cleanup.processesRemaining).toBe(0)
    expect(receiptComplete(receipt)).toBe(true)
  })

  test("incomplete receipt fails the completeness gate", () => {
    const spec = baseSpec()
    const caps = probeLinuxCapabilities({ refresh: true })
    const receipt = buildReceipt({
      spec, capabilities: caps, backend: "host-audit",
      startedAt: 0, finishedAt: 0, exitCode: null, signal: null,
      timedOut: false, cancelled: false, oomKilled: false, pidLimitHit: false,
      outputLimitHit: false, tempLimitHit: false,
      cleanup: { processesRemaining: 2 },
    })
    expect(receiptComplete(receipt)).toBe(false)
  })
})

describe("LF-1: shadow mode", () => {
  linuxOnly("shadow records spec + backend without executing", () => {
    const records: unknown[] = []
    const broker = createLinuxBroker({ mode: "shadow", onShadow: r => records.push(r) })
    const spec = broker.compileSpec(baseSpec())
    const record = broker.shadow(spec)
    expect(record.compiled).toBe(true)
    expect(record.executed).toBe("legacy")
    // 本机无隔离后端时也如实记录（不崩）；有后端时记录真实选择
    if (record.backend === "host-audit") {
      expect(record.degradationReasons.length).toBeGreaterThan(0)
    } else {
      expect(["bubblewrap", "rootless-podman"]).toContain(record.backend)
    }
    expect(records).toHaveLength(1)
  })

  linuxOnly("broker rejects invalid specs at compile time", () => {
    const broker = createLinuxBroker({ mode: "shadow" })
    const env = { ...baseSpec().environment }
    const bad = baseSpec({ environment: { ...env, inheritHost: true } as unknown as ExecutionCellSpec["environment"] })
    expect(() => broker.compileSpec(bad)).toThrow(LinuxExecutionError)
    expect(() => broker.compileSpec(bad)).toThrow(/EXECUTION_SPEC_INVALID/)
  })

  linuxOnly("createAgentDomain returns a bound domain", () => {
    const broker = createLinuxBroker({ mode: "shadow" })
    const domain = broker.createAgentDomain({
      runId: "r1",
      agentId: "a1",
      worktreeRoot: "/workspace/a1",
      ownerFiles: ["src/a.ts"],
      resourceBudget: { maxConcurrentCells: 2, cpuQuotaTotal: 100000, memoryMaxBytes: 1024, pidsMax: 64, maxWallTimeMs: 60000, maxOutputBytes: 1024, maxTempBytes: 1024 },
    })
    expect(domain.domainId).toBeTruthy()
    expect(domain.runId).toBe("r1")
    expect(domain.agentId).toBe("a1")
    expect(domain.status).toBe("active")
    expect(domain.cacheNamespace).toContain("agent-a1")
  })
})

// ── PR-1 (0.8.15.1)：canonical JSON / 权威 Policy Compiler ──

describe("PR-1: canonical JSON digests distinguish nested policies (P0-1)", () => {
  test("different nested network modes produce different canonical JSON", () => {
    const a = { network: { mode: "none" } }
    const b = { network: { mode: "full-approved" } }
    expect(canonicalJson(a)).not.toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"network":{"mode":"none"}}')
  })

  test("nested isolation levels are not collapsed", () => {
    const c = { isolation: { minimum: "container" }, filesystem: { emptyHome: true } }
    const d = { isolation: { minimum: "audit" }, filesystem: { emptyHome: true } }
    expect(canonicalJson(c)).not.toBe(canonicalJson(d))
  })

  test("arrays and nested objects hash deterministically (replayable)", () => {
    const spec = baseSpec()
    const roundTrip = JSON.parse(JSON.stringify(spec)) as ExecutionCellSpec
    expect(cellSpecDigest(roundTrip)).toBe(cellSpecDigest(spec))
    // 键序无关：打乱键序的对象 digest 相同。
    const shuffled = JSON.parse(canonicalJson(spec)) as ExecutionCellSpec
    expect(cellSpecDigest(shuffled)).toBe(cellSpecDigest(spec))
  })
})

describe("PR-1: CapabilityRequest compilation (P0-1/P0-2)", () => {
  test("runtime generates unique identity per request (no shared tool-run)", () => {
    const a = compileCapabilityRequest({ command: { executable: "/bin/true", args: [] }, profile: "build" })
    const b = compileCapabilityRequest({ command: { executable: "/bin/true", args: [] }, profile: "build" })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.spec.identity.runId).not.toBe("tool-run")
      expect(a.spec.identity.nodeRunId).not.toBe("tool:n")
      expect(a.spec.identity.cellId).not.toBe(b.spec.identity.cellId)
      expect(a.spec.identity.runId).not.toBe(b.spec.identity.runId)
      expect(a.spec.identity.cellId.startsWith("cell-")).toBe(true)
    }
  })

  test("compiled spec is deeply frozen (immutable after compile)", () => {
    const result = compileCapabilityRequest({ command: { executable: "/bin/true", args: [] }, profile: "build" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.isFrozen(result.spec)).toBe(true)
      expect(Object.isFrozen(result.spec.isolation)).toBe(true)
      expect(Object.isFrozen(result.spec.environment.variables)).toBe(true)
      // 修改冻结对象在严格模式下抛 TypeError
      expect(() => {
        "use strict"
        ;(result.spec.environment.variables as Record<string, string>)["ORCANA_X"] = "1"
      }).toThrow()
    }
  })

  test("profile minimum isolation is enforced: untrusted cannot request audit", () => {
    const weak = baseSpec({ profile: "untrusted", isolation: { minimum: "audit", preferredBackend: "podman", allowDegradation: false } })
    const result = validateCellSpec(weak)
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("ISOLATION_AUDIT_NOT_ALLOWED_BY_PROFILE") || e.includes("ISOLATION_MINIMUM_BELOW_PROFILE"))).toBe(true)
  })

  test("strict profile cannot be degraded (DEGRADATION_NOT_ALLOWED_BY_PROFILE)", () => {
    const strict = baseSpec({ profile: "evolution", isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: true } })
    const result = validateCellSpec(strict)
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("DEGRADATION_NOT_ALLOWED_BY_PROFILE"))).toBe(true)
  })

  test("network cannot be broader than profile default", () => {
    const broad = baseSpec({ network: { mode: "full-approved" } })
    const result = validateCellSpec(broad)
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("NETWORK_BROADER_THAN_PROFILE"))).toBe(true)
  })

  test("resources are clamped to profile ceiling (tighten-only)", () => {
    const result = compileCapabilityRequest({
      command: { executable: "/bin/true", args: [] },
      profile: "untrusted",
      memoryMaxBytes: 8 * 1024 * 1024 * 1024, // 8GB > untrusted ceiling 1GB
      pidsMax: 4096,                          // > untrusted ceiling 64
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.resources.memoryMaxBytes).toBe(1024 * 1024 * 1024)
      expect(result.spec.resources.pidsMax).toBe(64)
      expect(result.spec.policyDigest).toBe(computePolicyDigest(result.spec))
    }
  })

  test("audit minimum allowed only for non-strict profile with explicit degradation", () => {
    const ok = baseSpec({ profile: "build", isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: true } })
    expect(validateCellSpec(ok).ok).toBe(true)
    const noFlag = baseSpec({ profile: "build", isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: false } })
    const r2 = validateCellSpec(noFlag)
    expect(r2.ok).toBe(false)
    expect(r2.errors.some(e => e.includes("ISOLATION_AUDIT_REQUIRES_DEGRADATION"))).toBe(true)
  })

  test("deepFreeze utility freezes nested structures", () => {
    const obj = deepFreeze({ a: { b: [1, 2] }, c: "x" })
    expect(Object.isFrozen(obj)).toBe(true)
    expect(Object.isFrozen(obj.a)).toBe(true)
    expect(Object.isFrozen(obj.a.b)).toBe(true)
  })
})
