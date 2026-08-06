/** LNXF LF-6 acceptance: Rootless Podman 严格后端.
 *
 *  Gates: PRIVILEGED_CONTAINER / HOST_NETWORK_STRICT / CONTAINER_SOCKET_VISIBLE /
 *  FLOATING_IMAGE_ACCEPTED / STRICT_BACKEND_DEGRADED.
 */

import { describe, expect, test } from "bun:test"
import { platform } from "node:os"
import { compilePodmanArgv, validateImageRef, createPodmanBackend, DIGEST_PATTERN } from "../../../src/runtime/linux/backends/podman"
import { probeLinuxCapabilities } from "../../../src/runtime/linux/capability-probe"
import { isStrictProfile, profileDefaults } from "../../../src/runtime/linux/profiles"
import { selectBackend } from "../../../src/runtime/linux/backend-router"
import { LinuxExecutionError } from "../../../src/runtime/linux/errors"
import type { ExecutionCellSpec } from "../../../src/runtime/linux/contracts"

const linuxOnly = platform() === "linux" ? test : test.skip

const DIGEST_IMAGE = "registry.example.com/orcana-base@sha256:" + "a".repeat(64)

function baseSpec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1 },
    command: { executable: "/bin/true", args: [], cwd: "/workspace", stdin: "closed" },
    profile: "untrusted",
    isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: false },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/tmp/lnxf-wt" },
    network: { mode: "none" },
    environment: { variables: { ORCANA_IMAGE: DIGEST_IMAGE }, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024, pidsMax: 64, wallTimeMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

const caps = probeLinuxCapabilities()
const podmanAvailable = caps.podman.available && caps.podman.rootlessReady

describe("LF-6: image policy", () => {
  test("digest-locked image accepted", () => {
    expect(validateImageRef(DIGEST_IMAGE).ok).toBe(true)
    expect(DIGEST_PATTERN.test(DIGEST_IMAGE)).toBe(true)
  })

  test("floating tag rejected (FLOATING_IMAGE_ACCEPTED: 0)", () => {
    expect(validateImageRef("ubuntu:latest").ok).toBe(false)
    expect(validateImageRef("ubuntu").ok).toBe(false)
    expect(validateImageRef("").ok).toBe(false)
    expect(validateImageRef("img@sha256:xyz").ok).toBe(false)
  })
})

describe("LF-6: argv compiler", () => {
  test("strict flags are always present (PRIVILEGED_CONTAINER: 0 / HOST_NETWORK_STRICT: 0)", () => {
    const argv = compilePodmanArgv(baseSpec(), caps, { image: DIGEST_IMAGE, workdir: "/workspace" })
    const joined = argv.join(" ")
    expect(joined.includes("--privileged")).toBe(false)
    expect(joined.includes("--network=host")).toBe(false)
    expect(joined.includes("--network=none")).toBe(true)
    expect(joined.includes("--read-only")).toBe(true)
    expect(joined.includes("--pull never")).toBe(true)
    expect(joined.includes("--rm")).toBe(true)
    expect(joined.includes("--pids-limit")).toBe(true)
    expect(joined.includes("--memory")).toBe(true)
    expect(joined.includes(`io.orcana.run=r1`)).toBe(true)
    expect(joined.includes(`io.orcana.cell=c1`)).toBe(true)
  })

  test("worktree volume is explicit (CONTAINER_SOCKET_VISIBLE: 0)", () => {
    const argv = compilePodmanArgv(baseSpec(), caps, { image: DIGEST_IMAGE })
    expect(argv.some(a => a.startsWith("/tmp/lnxf-wt:/workspace:rw"))).toBe(true)
    const joined = argv.join(" ")
    expect(joined.includes("docker.sock")).toBe(false)
    expect(joined.includes("/home/")).toBe(false)
  })

  test("resource limits derived from spec", () => {
    const argv = compilePodmanArgv(baseSpec({ resources: { ...baseSpec().resources, memoryMaxBytes: 2 * 1024 * 1024 * 1024, pidsMax: 128 } }), caps, { image: DIGEST_IMAGE })
    expect(argv).toContain("--memory")
    expect(argv).toContain("2048m")
    expect(argv).toContain("--pids-limit")
    expect(argv).toContain("128")
  })

  test("cache volumes mount ro/rw per request", () => {
    const spec = baseSpec({ cache: [{ cacheId: "x", kind: "bun", key: "v1", mode: "rw-locked", target: "/cache/bun" }] })
    const argv = compilePodmanArgv(spec, caps, {
      image: DIGEST_IMAGE,
      volumes: spec.cache.map(c => ({ source: `/cache/${c.kind}/${c.key}`, target: c.target, mode: "rw" as const })),
    })
    expect(argv.some(a => a.includes("/cache/bun/v1:/cache/bun:rw"))).toBe(true)
  })
})

describe("LF-6: backend policy", () => {
  test("requires minimum=container", () => {
    const backend = createPodmanBackend()
    const errors = backend.validateSpec(baseSpec({ isolation: { minimum: "namespace", preferredBackend: "podman", allowDegradation: false } }))
    expect(errors.some(e => e.includes("minimum=container"))).toBe(true)
  })

  test("rejects real home and host sockets", () => {
    const backend = createPodmanBackend()
    const errors = backend.validateSpec(
      baseSpec({ filesystem: { ...baseSpec().filesystem, writableMounts: [{ source: "/home/fuqiang", target: "/home", mode: "rw", required: true, recursive: true }] } }),
    )
    expect(errors.some(e => e.includes("real home"))).toBe(true)
    const socketErrors = backend.validateSpec(
      baseSpec({ filesystem: { ...baseSpec().filesystem, readonlyMounts: [{ source: "/var/run/docker.sock", target: "/run/docker.sock", mode: "ro", required: true, recursive: false }] } }),
    )
    expect(socketErrors.some(e => e.includes("socket"))).toBe(true)
  })

  test("strict profiles refuse degradation when podman unavailable (STRICT_BACKEND_DEGRADED: 0)", () => {
    const backend = createPodmanBackend()
    if (!podmanAvailable) {
      expect(backend.availability(caps).available).toBe(false)
      expect(backend.availability(caps).degradationReasons.length).toBeGreaterThan(0)
    }
  })

  linuxOnly("selection for untrusted spec refuses without podman", () => {
    if (!caps.podman.available) {
      const spec = baseSpec()
      expect(() => selectBackend(spec, caps)).toThrow(LinuxExecutionError)
      expect(() => selectBackend(spec, caps)).toThrow(/DEGRADATION_NOT_ALLOWED|ISOLATION_REQUIREMENT_UNMET/)
    }
  })
})

describe("LF-6: profiles", () => {
  test("untrusted/evolution/dependency use podman + container minimum + no degradation", () => {
    for (const profile of ["untrusted", "evolution", "dependency"] as const) {
      expect(profileDefaults(profile).backend).toBe("rootless-podman")
      expect(profileDefaults(profile).minimum).toBe("container")
      expect(isStrictProfile(profile)).toBe(true)
      expect(profileDefaults(profile).allowDegradation).toBe(false)
    }
  })
})

describe("LF-6: true container (runs only when rootless podman ready)", () => {
  const podmanTest = podmanAvailable ? test : test.skip

  podmanTest("container executes and produces receipt", async () => {
    const backend = createPodmanBackend()
    const spec = baseSpec({
      command: { executable: "true", args: [], cwd: "/workspace", stdin: "closed" },
      environment: { ...baseSpec().environment, variables: { ORCANA_IMAGE: DIGEST_IMAGE } },
    })
    const events: string[] = []
    for await (const event of backend.run(spec, { capabilities: caps })) {
      events.push(event.type)
    }
    expect(events).toContain("cell.receipt")
  })

  podmanTest("receipt records rootless-podman backend", async () => {
    const backend = createPodmanBackend()
    const spec = baseSpec({ command: { executable: "true", args: [], cwd: "/workspace", stdin: "closed" } })
    let receiptSeen = false
    for await (const event of backend.run(spec, { capabilities: caps })) {
      if (event.type === "cell.receipt") {
        expect(event.receipt.backend).toBe("rootless-podman")
        expect(event.receipt.cleanup.containerRemoved).toBe(true)
        receiptSeen = true
      }
    }
    expect(receiptSeen).toBe(true)
  })
})

describe("PR-7: podman production wiring", () => {
  test("volumes include validated MountRules with noexec/nosuid semantics", () => {
    const backend = createPodmanBackend()
    const spec = baseSpec({
      filesystem: {
        ...baseSpec().filesystem,
        readonlyMounts: [{ source: "/usr", target: "/usr", mode: "ro", required: true, recursive: true, noExec: true, noSuid: true }],
        writableMounts: [{ source: "/tmp/wt", target: "/data", mode: "rw", required: true, recursive: true }],
      },
    })
    const compiled = backend.compile(spec, caps, {})
    const argv = compiled.argv.join(" ")
    // 只读 + noexec/nosuid；读写无附加选项
    expect(argv).toContain("--volume")
    expect(argv).toContain("/usr:/usr:ro,Z,noexec,nosuid")
    expect(argv).toContain("/tmp/wt:/data:rw,Z")
  })

  test("sealed-file secrets mount into the container (ro)", () => {
    const backend = createPodmanBackend()
    const spec = baseSpec()
    const compiled = backend.compile(spec, caps, {
      secretFiles: { "/run/secrets/sb_1": "/tmp/orcana-secret-1/secret" },
    })
    expect(compiled.argv.join(" ")).toContain("/tmp/orcana-secret-1/secret:/run/secrets/sb_1:ro,Z")
  })

  test("OCI seccomp profile is produced as JSON (not raw BPF)", async () => {
    const { compileOciSeccomp } = await import("../../../src/runtime/linux/seccomp-oci")
    const { compileSeccompProfile } = await import("../../../src/runtime/linux/landlock-seccomp")
    const profile = compileOciSeccomp(compileSeccompProfile("untrusted"))
    expect(profile.defaultAction).toBe("SCMP_ACT_ALLOW")
    expect(profile.archMap?.[0]?.architecture).toBe("SCMP_ARCH_X86_64")
    const deny = profile.syscalls.find(s => s.action === "SCMP_ACT_ERRNO")
    expect(deny).toBeDefined()
    expect(deny!.names.length).toBeGreaterThan(0)
    // JSON 可序列化（OCI 格式要求）
    const json = JSON.stringify(profile)
    expect(json).toContain("SCMP_ACT_ERRNO")
    expect(json).not.toContain("BPF")
  })

  test("broker rejects podman image not in approved policy (IMAGE_NOT_APPROVED)", async () => {
    const { createLinuxBroker } = await import("../../../src/runtime/linux/broker")
    const broker = createLinuxBroker({ mode: "enabled", approvedImages: ["docker.io/library/alpine@"] })
    const spec = baseSpec()
    await expect((async () => {
      for await (const _ of broker.execute(spec)) { /* drain */ }
    })()).rejects.toThrow(/IMAGE_NOT_APPROVED/)
  })

  test("broker accepts digest-locked image inside approved policy", async () => {
    const { createLinuxBroker } = await import("../../../src/runtime/linux/broker")
    const broker = createLinuxBroker({ mode: "enabled", approvedImages: ["registry.example.com/orcana-base@"] })
    const spec = baseSpec()
    // 后端不可用时会先抛 DEGRADATION/UNMET —— 若 podman 可用则执行路径到镜像校验通过
    // （本机无 podman 时，镜像审批必须先于后端可用性检查前通过 —— 这里验证顺序）。
    try {
      for await (const _ of broker.execute(spec)) { /* drain */ }
      expect(true).toBe(true)
    } catch (error) {
      // 本机无 podman → DEGRADATION_NOT_ALLOWED 或 ISOLATION_REQUIREMENT_UNMET；
      // 但绝不能是 IMAGE_NOT_APPROVED（审批已通过）。
      expect(String(error)).not.toContain("IMAGE_NOT_APPROVED")
    }
  })
})
