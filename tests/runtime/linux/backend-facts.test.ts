/** LNXF R3: 后端真实性修复（seccomp-BPF / PathGuard / env 注入）。 */

import { describe, expect, test } from "bun:test"
import { arch } from "node:os"
import { compileSeccompBpf } from "../../../src/runtime/linux/seccomp-bpf"
import { compileSeccompProfile } from "../../../src/runtime/linux/landlock-seccomp"
import { snapshotWorkspace, pathGuardDiff } from "../../../src/runtime/linux/backends/host-audit"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compileBwrapArgv, loopbackWrapper } from "../../../src/runtime/linux/backends/bubblewrap"
import { compilePodmanArgv } from "../../../src/runtime/linux/backends/podman"
import { probeLinuxCapabilities } from "../../../src/runtime/linux/capability-probe"
import type { ExecutionCellSpec } from "../../../src/runtime/linux/contracts"

function spec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: "r3", runId: "r3", nodeRunId: "r3:n", attempt: 1 },
    command: { executable: "/bin/true", args: [], cwd: "/tmp", stdin: "closed" },
    profile: "inspect",
    isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: true },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/wt" },
    network: { mode: "none" },
    environment: { variables: { FOO: "bar" }, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024, pidsMax: 16, wallTimeMs: 10000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
    cache: [{ cacheId: "n1", kind: "npm", key: "v1", mode: "rw-locked", target: "/cache/npm" }],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

describe("R3 seccomp-BPF", () => {
  test("deny syscalls are encoded as ERRNO, default ALLOW (x86_64)", () => {
    if (arch() !== "x64") return
    const bpf = compileSeccompBpf(compileSeccompProfile("inspect"))
    // 头部: arch load + jeq + kill + 每个 deny 的 (load/jeq/ret) + 尾部 allow ret。
    const denyCount = compileSeccompProfile("inspect").denySyscalls.length
    const expectedInsns = 3 + denyCount * 3 + 1
    expect(bpf.length).toBe(expectedInsns * 8)
    const view = new DataView(bpf.buffer)
    // 尾部指令 = RET ALLOW
    const last = (expectedInsns - 1) * 8
    expect(view.getUint16(last, true) & 0x07).toBe(0x06) // BPF_RET
    expect(view.getUint32(last + 4, true)).toBe(0x7fff0000)
  })

  test("deny list contains ptrace/mount/bpf (conservative)", () => {
    const profile = compileSeccompProfile("untrusted")
    expect(profile.denySyscalls).toContain("ptrace")
    expect(profile.denySyscalls).toContain("mount")
    expect(profile.denySyscalls).toContain("bpf")
  })
})

describe("R3 PathGuard", () => {
  test("snapshot + diff detects created/changed/deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "pg-"))
    try {
      writeFileSync(join(root, "a.txt"), "one")
      mkdirSync(join(root, "sub"))
      writeFileSync(join(root, "sub", "b.txt"), "b")
      const before = snapshotWorkspace(root)
      writeFileSync(join(root, "a.txt"), "two")
      writeFileSync(join(root, "new.txt"), "n")
      rmSync(join(root, "sub", "b.txt"))
      const after = snapshotWorkspace(root)
      const diff = pathGuardDiff(before, after)
      expect(diff.changed).toContain("a.txt")
      expect(diff.created).toContain("new.txt")
      expect(diff.deleted).toContain("sub/b.txt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("R3 bubblewrap env/loopback", () => {
  test("compiled env is injected via --setenv (P1-1)", () => {
    const caps = probeLinuxCapabilities()
    const compiled = compileBwrapArgv(spec(), caps, { setenv: { FOO: "bar", PATH: "/usr/bin" }, loopbackOnly: false })
    const joined = compiled.join(" ")
    expect(joined).toContain("--setenv")
    expect(joined).toContain("FOO bar")
    expect(joined).toContain("PATH /usr/bin")
  })

  test("loopback mode wraps entry with lo-up wrapper (P1-2)", () => {
    const caps = probeLinuxCapabilities()
    const wrapper = loopbackWrapper(caps, "/bin/node", ["-e", "x"])
    expect(wrapper.executable).toBe("/bin/sh")
    expect(wrapper.args.join(" ")).toContain("ip link set lo up")
  })

  test("rw-locked cache mounts as --bind (P1-3)", () => {
    const caps = probeLinuxCapabilities()
    const argv = compileBwrapArgv(spec(), caps, {
      cacheMounts: [],
      cacheMountsRw: [{ target: "/cache/npm", source: "/cache/npm/v1" }],
    })
    const joined = argv.join(" ")
    expect(joined).toContain("--bind /cache/npm/v1 /cache/npm")
  })
})

describe("R3 podman hardening", () => {
  test("cap-drop / no-new-privileges / tmpfs / env / cidfile present (P1-5/P1-6)", () => {
    const caps = probeLinuxCapabilities()
    const argv = compilePodmanArgv(spec(), caps, {
      image: "img@sha256:" + "a".repeat(64),
      env: { FOO: "bar" },
      cidfile: "/tmp/x.cid",
    })
    const joined = argv.join(" ")
    expect(joined).toContain("--cap-drop=ALL")
    expect(joined).toContain("no-new-privileges")
    expect(joined).toContain("--tmpfs /tmp")
    expect(joined).toContain("--env FOO=bar")
    expect(joined).toContain("--cidfile /tmp/x.cid")
  })
})
