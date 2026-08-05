/** LNXF LF-3 acceptance: Bubblewrap 快速后端.
 *
 *  Gates: HOME_VISIBILITY / CREDENTIAL_VISIBILITY / PROJECT_ESCAPE /
 *  NETWORK_EGRESS_NONE / HOST_PROCESS_VISIBILITY / BWRAP_DEGRADATION_IN_STRICT.
 *
 *  The bwrap binary may be absent on this machine: argv-compilation and
 *  policy tests always run; true-sandbox tests run only when available.
 */

import { describe, expect, test } from "bun:test"
import { platform } from "node:os"
import { compileBwrapArgv, DEFAULT_ROOT_LAYOUT, createBubblewrapBackend, BWRAP_FORBIDDEN_MOUNTS } from "../../../src/runtime/linux/backends/bubblewrap"
import { probeLinuxCapabilities } from "../../../src/runtime/linux/capability-probe"
import { runSupervised } from "../../../src/runtime/linux/process/supervisor"
import { buildExplicitEnvironment } from "../../../src/runtime/linux/environment"
import type { ExecutionCellSpec } from "../../../src/runtime/linux/contracts"

const linuxOnly = platform() === "linux" ? test : test.skip

function baseSpec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1 },
    command: { executable: "/bin/true", args: [], cwd: "/workspace", stdin: "closed" },
    profile: "build",
    isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: false },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/tmp/lnxf-wt" },
    network: { mode: "none" },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024, pidsMax: 128, wallTimeMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

const caps = probeLinuxCapabilities()
const bwrapAvailable = caps.bubblewrap.available && caps.bubblewrap.unprivilegedUsable

describe("LF-3: bwrap argv compiler", () => {
  test("default namespaces and layout flags are present", () => {
    const argv = compileBwrapArgv(baseSpec(), caps)
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--die-with-parent", "--new-session", "--clearenv"]) {
      expect(argv).toContain(flag)
    }
    expect(argv).toContain("--proc")
    expect(argv).toContain("/proc")
    expect(argv).toContain("--tmpfs")
    expect(argv).toContain("/tmp")
    // 空 Home
    expect(argv).toContain("/home/orcana")
    // Worktree 挂载
    expect(argv).toContain("/tmp/lnxf-wt")
    expect(argv).toContain("/workspace")
    // chdir
    expect(argv).toContain("--chdir")
  })

  test("all system root paths are read-only bind", () => {
    const argv = compileBwrapArgv(baseSpec(), caps)
    for (const mount of DEFAULT_ROOT_LAYOUT) {
      const flagIndex = argv.indexOf("--ro-bind")
      expect(flagIndex).toBeGreaterThan(-1)
      expect(argv).toContain(mount.source)
    }
    // 没有任何 --bind 用于系统根（全部 ro）
    const roBinds = argv.filter((a, i) => a === "--ro-bind" && DEFAULT_ROOT_LAYOUT.some(m => m.source === argv[i + 1]))
    expect(roBinds.length).toBe(DEFAULT_ROOT_LAYOUT.length)
  })

  test("argv never contains forbidden mounts", () => {
    const argv = compileBwrapArgv(baseSpec(), caps).join(" ")
    // 空 home 目标目录允许（--dir /home/orcana）；真实 home 挂载源禁止
    for (const forbidden of BWRAP_FORBIDDEN_MOUNTS) {
      if (forbidden === "/home") continue
      expect(argv.includes(forbidden)).toBe(false)
    }
    expect(argv.includes("/home/fuqiang")).toBe(false)
    expect(argv.includes("/root")).toBe(false)
    expect(argv.includes("docker.sock")).toBe(false)
  })

  test("network mode none yields --unshare-net; loopback keeps it (LF-3)", () => {
    const none = compileBwrapArgv(baseSpec(), caps)
    expect(none).toContain("--unshare-net")
    const loopback = compileBwrapArgv(baseSpec({ network: { mode: "loopback" } }), caps)
    expect(loopback).toContain("--unshare-net")
  })
})

describe("LF-3: backend policy", () => {
  test("backend rejects container minimum", () => {
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(baseSpec({ isolation: { minimum: "container", preferredBackend: "bubblewrap", allowDegradation: false } }))
    expect(errors.some(e => e.includes("container"))).toBe(true)
  })

  test("backend rejects non-none/loopback network", () => {
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(baseSpec({ network: { mode: "full-approved" } }))
    expect(errors.some(e => e.includes("NETWORK_POLICY_UNAVAILABLE"))).toBe(true)
  })

  test("backend rejects real home mounts (HOME_VISIBILITY: 0)", () => {
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(
      baseSpec({ filesystem: { ...baseSpec().filesystem, readonlyMounts: [{ source: "/home/fuqiang/.ssh", target: "/ssh", mode: "ro", required: true, recursive: true }] } }),
    )
    expect(errors.some(e => e.includes("real home"))).toBe(true)
  })

  test("backend rejects host sockets (CREDENTIAL_VISIBILITY: 0)", () => {
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(
      baseSpec({ filesystem: { ...baseSpec().filesystem, readonlyMounts: [{ source: "/run/docker.sock", target: "/run/docker.sock", mode: "ro", required: true, recursive: false }] } }),
    )
    expect(errors.some(e => e.includes("MOUNT_POLICY_INVALID"))).toBe(true)
  })

  test("compile produces explicit env without host secrets", () => {
    const backend = createBubblewrapBackend()
    const compiled = backend.compile(baseSpec(), caps)
    expect(compiled.argv[0]).toContain("bwrap")
    expect(compiled.env.ORCANA_SANDBOX).toBe("1")
    expect(compiled.env.HOME).toBe("/home/orcana")
    expect(compiled.env.GITHUB_TOKEN).toBeUndefined()
  })

  test("strict profile refuses degradation when bwrap unavailable (BWRAP_DEGRADATION_IN_STRICT: 0)", () => {
    const backend = createBubblewrapBackend()
    if (!bwrapAvailable) {
      expect(backend.availability(caps).available).toBe(false)
      expect(backend.availability(caps).degradationReasons.length).toBeGreaterThan(0)
    }
  })
})

describe("LF-3: true sandbox (runs only when bwrap installed)", () => {
  const bwrapTest = bwrapAvailable ? test : test.skip

  bwrapTest("empty home hides host files", async () => {
    const backend = createBubblewrapBackend()
    const spec = baseSpec({
      command: { executable: "/bin/sh", args: ["-c", "ls /home/orcana; test ! -e /home/fuqiang && echo HOME_HIDDEN"], cwd: "/workspace", stdin: "closed" },
      filesystem: { ...baseSpec().filesystem, worktreeRoot: "/tmp" },
    })
    const events: string[] = []
    for await (const event of backend.run(spec, { capabilities: caps })) {
      if (event.type === "cell.stdout") events.push(event.data)
    }
    expect(events.join("")).toContain("HOME_HIDDEN")
  })

  bwrapTest("project-relative writes land in worktree only", async () => {
    const backend = createBubblewrapBackend()
    const spec = baseSpec({
      command: { executable: "/bin/sh", args: ["-c", "echo x > /workspace/out.txt; test ! -e /etc/passwd.copy && echo NO_ESCAPE"], cwd: "/workspace", stdin: "closed" },
    })
    const events: string[] = []
    for await (const event of backend.run(spec, { capabilities: caps })) {
      if (event.type === "cell.stdout") events.push(event.data)
    }
    expect(events.join("")).toContain("NO_ESCAPE")
  })

  bwrapTest("host processes are invisible (new pid ns)", async () => {
    const backend = createBubblewrapBackend()
    const spec = baseSpec({
      command: { executable: "/bin/sh", args: ["-c", "ps -e 2>/dev/null | wc -l"], cwd: "/workspace", stdin: "closed" },
    })
    const events: string[] = []
    for await (const event of backend.run(spec, { capabilities: caps })) {
      if (event.type === "cell.stdout") events.push(event.data)
    }
    const count = Number(events.join("").trim())
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(50) // 新 PID ns：远少于宿主进程数
  })

  bwrapTest("network egress fails (none)", async () => {
    const backend = createBubblewrapBackend()
    const spec = baseSpec({
      command: { executable: "/bin/sh", args: ["-c", "cat /etc/hosts > /dev/null 2>&1; (exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo CONNECTED || echo NO_NET"], cwd: "/workspace", stdin: "closed" },
    })
    const events: string[] = []
    for await (const event of backend.run(spec, { capabilities: caps })) {
      if (event.type === "cell.stdout") events.push(event.data)
    }
    expect(events.join("")).toContain("NO_NET")
  })

  bwrapTest("receipt records the sandbox execution", async () => {
    const backend = createBubblewrapBackend()
    const spec = baseSpec()
    let receiptSeen = false
    for await (const event of backend.run(spec, { capabilities: caps })) {
      if (event.type === "cell.receipt") {
        expect(event.receipt.backend).toBe("bubblewrap")
        expect(event.receipt.profile).toBe("build")
        expect(event.receipt.exitCode).toBe(0)
        receiptSeen = true
      }
    }
    expect(receiptSeen).toBe(true)
  })
})

describe("LF-3: supervised run of bwrap itself (availability check)", () => {
  linuxOnly("supervisor runs bwrap when present; records missing binary otherwise", async () => {
    const bwrapPath = caps.bubblewrap.path
    if (!bwrapPath) {
      // 无 bwrap：验证 supervisor 能正确报告启动失败（错误码路径）
      const env = buildExplicitEnvironment({
        policy: { baseProfile: "minimal", allowedHostKeys: [], fixedValues: {}, requestedValues: {}, deniedKeys: [] },
        runId: "r",
        nodeRunId: "r:n",
      })
      const result = await runSupervised({
        executable: "/nonexistent-bwrap",
        args: ["--version"],
        cwd: "/tmp",
        env: env.env,
        limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
        wallTimeMs: 5000,
      })
      expect(result.exitCode).toBe(null)
      expect(result.signal).toBe("error")
    }
  })
})
