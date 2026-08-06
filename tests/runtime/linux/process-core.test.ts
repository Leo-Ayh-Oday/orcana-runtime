/** LNXF LF-2 acceptance: 统一进程核心.
 *
 *  Gates: DIRECT_LINUX_PROCESS_BYPASS / HOST_ENV_SECRET_LEAK /
 *  ORPHAN_PROCESS_AFTER_CANCEL / OUTPUT_LIMIT_BYPASS.
 */

import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { platform } from "node:os"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runSupervised, streamSupervised } from "../../../src/runtime/linux/process/supervisor"
import { countProcessGroup, terminateTree } from "../../../src/runtime/linux/process/termination"
import { createOutputLimiter, finalizeOutput, TRUNCATION_MARKER } from "../../../src/runtime/linux/process/output-limiter"
import { buildExplicitEnvironment, hostKeyDenied, environmentLeaksHostSecrets } from "../../../src/runtime/linux/environment"
import { bindSecrets, newSecretBinding } from "../../../src/runtime/linux/secrets"
import { createHostAuditBackend } from "../../../src/runtime/linux/backends/host-audit"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { LinuxExecutionError } from "../../../src/runtime/linux/errors"
import type { ExecutionCellSpec } from "../../../src/runtime/linux/contracts"

const linuxOnly = platform() === "linux" ? test : test.skip
const LINUX_RUNTIME_DIRS = ["src/runtime/linux/backends/", "src/runtime/linux/process/"]

function baseSpec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1 },
    command: { executable: "/bin/true", args: [], cwd: "/tmp", stdin: "closed" },
    profile: "inspect",
    isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: true },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true },
    network: { mode: "none" },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024, pidsMax: 32, wallTimeMs: 10_000, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 64 * 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

describe("LF-2: explicit environment", () => {
  test("child env never inherits host secrets", () => {
    const built = buildExplicitEnvironment({
      policy: { baseProfile: "minimal", allowedHostKeys: [], fixedValues: {}, requestedValues: {}, deniedKeys: [] },
      runId: "r1",
      nodeRunId: "r1:n1",
    })
    expect(built.ok).toBe(true)
    expect(built.env.HOME).toBe("/home/orcana")
    expect(built.env.ORCANA_SANDBOX).toBe("1")
    expect(built.env.ORCANA_RUN_ID).toBe("r1")
    // 宿主密钥永不进入子进程环境
    expect(environmentLeaksHostSecrets(built.env)).toEqual([])
    const leaked = environmentLeaksHostSecrets(built.env, [])
    expect(leaked).toEqual([])
  })

  test("host key allowlist copies explicitly allowed keys only", () => {
    process.env.ORCANA_LNXF_ALLOWED_PROBE = "visible"
    const built = buildExplicitEnvironment({
      policy: { baseProfile: "minimal", allowedHostKeys: ["ORCANA_LNXF_ALLOWED_PROBE"], fixedValues: {}, requestedValues: {}, deniedKeys: [] },
      runId: "r1",
      nodeRunId: "r1:n1",
    })
    expect(built.env.ORCANA_LNXF_ALLOWED_PROBE).toBe("visible")
    delete process.env.ORCANA_LNXF_ALLOWED_PROBE
  })

  test("denied patterns are rejected even when requested", () => {
    const built = buildExplicitEnvironment({
      policy: {
        baseProfile: "minimal",
        allowedHostKeys: [],
        fixedValues: {},
        requestedValues: { GITHUB_TOKEN: "should-not-leak", MY_TOKEN: "no", SAFE_KEY: "ok" },
        deniedKeys: ["SAFE_KEY"],
      },
      runId: "r1",
      nodeRunId: "r1:n1",
    })
    expect(built.env.GITHUB_TOKEN).toBeUndefined()
    expect(built.env.MY_TOKEN).toBeUndefined()
    expect(built.env.SAFE_KEY).toBeUndefined()
    expect(built.rejectedHostKeys).toContain("GITHUB_TOKEN")
    expect(built.rejectedHostKeys).toContain("MY_TOKEN")
    expect(built.rejectedHostKeys).toContain("SAFE_KEY")
  })

  test("hostKeyDenied matches wildcard patterns", () => {
    expect(hostKeyDenied("OPENAI_API_KEY")).toBe(true)
    expect(hostKeyDenied("AWS_ACCESS_KEY_ID")).toBe(true)
    expect(hostKeyDenied("DATABASE_URL")).toBe(true)
    expect(hostKeyDenied("PATH")).toBe(false)
    expect(hostKeyDenied("HOME")).toBe(false)
  })
})

describe("LF-2: output limiter", () => {
  test("caps stdout and marks truncation", () => {
    const limiter = createOutputLimiter({ stdoutMaxBytes: 10, stderrMaxBytes: 10 })
    const chunk = Buffer.from("0123456789ABCDEF")
    const kept = limiter.absorb("stdout", chunk)
    expect(kept.toString()).toBe("0123456789")
    expect(limiter.state.stdoutTruncated).toBe(true)
    expect(limiter.exceeded()).toBe(true)
    // 再吸收全部丢弃
    expect(limiter.absorb("stdout", chunk).length).toBe(0)
  })

  test("truncation marker appended on finalize", () => {
    const limiter = createOutputLimiter({ stdoutMaxBytes: 4, stderrMaxBytes: 4 })
    limiter.absorb("stdout", Buffer.from("abcdef"))
    expect(TRUNCATION_MARKER.length).toBeGreaterThan(0)
    expect(finalizeOutput(limiter.state, "stdout")).toBe(TRUNCATION_MARKER)
    expect(finalizeOutput(limiter.state, "stderr")).toBe("")
  })
})

describe("LF-2: process supervision (linux)", () => {
  linuxOnly("exits with code and captures output", async () => {
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "echo out; echo err >&2; exit 3"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 10_000,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stdout.trim()).toBe("out")
    expect(result.stderr.trim()).toBe("err")
    expect(result.timedOut).toBe(false)
    expect(result.orphanProcesses).toBe(0)
  })

  linuxOnly("timeout terminates the process group", async () => {
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 500,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(null)
  })

  linuxOnly("abort signal cancels and tree-kills", async () => {
    const controller = new AbortController()
    const promise = runSupervised({
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 30_000,
      abortSignal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const result = await promise
    expect(result.cancelled).toBe(true)
  })

  linuxOnly("output limit is hit on large output", async () => {
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "yes x | head -c 100000"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 10_000,
    })
    expect(result.outputLimitHit).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + TRUNCATION_MARKER.length)
  })

  linuxOnly("double-fork daemon is detected as orphan", async () => {
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "setsid sh -c 'sleep 0.4' & exit 0"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 10_000,
      detectDaemon: true,
    })
    expect(result.exitCode).toBe(0)
  })

  linuxOnly("terminateTree kills the whole group", async () => {
    const { spawn } = await import("node:child_process")
    const proc = spawn("/bin/sh", ["-c", "sleep 10 & sleep 10 & wait"], { detached: true, stdio: "ignore" })
    await new Promise(r => setTimeout(r, 300))
    expect(countProcessGroup(proc.pid ?? 0)).toBeGreaterThanOrEqual(1)
    const report = terminateTree(proc.pid ?? 0, { graceMs: 200, attempts: 2 })
    await new Promise(r => setTimeout(r, 200))
    expect(countProcessGroup(proc.pid ?? 0)).toBe(0)
    expect(report.processesRemaining).toBe(0)
  })
})

describe("LF-2: host audit backend", () => {
  linuxOnly("executes and produces a receipt", async () => {
    const backend = createHostAuditBackend()
    const spec = baseSpec({ command: { executable: "/bin/true", args: [], cwd: "/tmp", stdin: "closed" } })
    expect(backend.validateSpec(spec)).toEqual([])
    const events: string[] = []
    const { probeLinuxCapabilities } = await import("../../../src/runtime/linux/capability-probe")
    const caps = probeLinuxCapabilities()
    for await (const event of backend.run(spec, { capabilities: caps })) {
      events.push(event.type)
    }
    expect(events).toContain("cell.status")
    expect(events).toContain("cell.exit")
    expect(events).toContain("cell.receipt")
    const receiptEvent = events.indexOf("cell.receipt")
    expect(receiptEvent).toBeGreaterThan(-1)
  })

  linuxOnly("rejects minimum=namespace spec", () => {
    const backend = createHostAuditBackend()
    const spec = baseSpec({ isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: false } })
    expect(backend.validateSpec(spec).length).toBeGreaterThan(0)
  })
})

describe("LF-2: broker execution", () => {
  linuxOnly("enabled mode executes via host-audit", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const spec = baseSpec()
    const receipts: unknown[] = []
    for await (const event of broker.execute(spec)) {
      if (event.type === "cell.receipt") receipts.push(event.receipt)
    }
    expect(receipts).toHaveLength(1)
  })

  linuxOnly("shadow mode does not execute", async () => {
    const broker = createLinuxBroker({ mode: "shadow" })
    const spec = baseSpec()
    const events: string[] = []
    for await (const event of broker.execute(spec)) {
      events.push(event.type)
    }
    expect(events).toEqual([])
  })

  linuxOnly("strict spec without backend availability fails closed", () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const spec = baseSpec({ profile: "untrusted", isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: false } })
    // 编译（结构校验）通过；后端选择（执行路径）fail-closed 拒绝
    expect(broker.compileSpec(spec).policyDigest.length).toBe(16)
    expect(() => broker.selectBackendFor(spec)).toThrow(LinuxExecutionError)
  })
})

describe("LF-2: secrets", () => {
  test("sealed-file delivery writes 0600 and cleans up", () => {
    const binding = newSecretBinding({ purpose: "registry", delivery: "sealed-file", target: "/run/secrets/reg", expiresAt: Date.now() + 60_000 })
    const result = bindSecrets({ bindings: [binding], values: { [binding.id]: "s3cr3t" }, secretsRoot: join("/tmp", `lnxf-secrets-test-${process.pid}`) })
    expect(result.ok).toBe(true)
    expect(result.bound[0]?.deliveryTarget).toBeTruthy()
    expect(result.envInjections).toEqual({})
    result.cleanup()
  })

  test("environment delivery injects into env", () => {
    const binding = newSecretBinding({ purpose: "auth", delivery: "environment", target: "ORCANA_AUTH_SECRET", expiresAt: Date.now() + 60_000 })
    const result = bindSecrets({ bindings: [binding], values: { [binding.id]: "x" } })
    expect(result.envInjections.ORCANA_AUTH_SECRET).toBe("x")
    result.cleanup()
  })

  test("expired binding is rejected", () => {
    const binding = newSecretBinding({ purpose: "auth", delivery: "sealed-file", expiresAt: Date.now() - 1000 })
    const result = bindSecrets({ bindings: [binding], values: { [binding.id]: "x" } })
    expect(result.ok).toBe(false)
  })
})

describe("LF-2: static gate — DIRECT_LINUX_PROCESS_BYPASS (AST)", () => {
  // R1: 旁路必须为 0 —— 允许列表只含统一入口与监督器：
  //  - src/runtime/linux/**     Linux Process Supervisor（唯一真实后端）
  //  - process-executor.ts      跨平台统一执行入口（Windows legacy）
  //  - legacy-process.ts        R1.2 暂存区（sync/长期进程，待迁移，显式标注）
  //  - tools/process.ts         terminateTree 的 Windows taskkill 辅助
  const ALLOWLIST = [
    "src/runtime/linux",
    "src/runtime/process-executor.ts",
    "src/runtime/legacy-process.ts",
    "src/tools/process.ts",
  ]
  const PROCESS_NAMES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])

  interface SpawnSite { file: string; line: number; kind: string }

  function scanDirectProcessCalls(): SpawnSite[] {
    const sites: SpawnSite[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const rel = full.slice(process.cwd().length + 1).split("\\").join("/")
          const source = readFileSync(full, "utf8")
          const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
          const importedNames = new Set<string>()
          let childProcessNamespace: string | undefined
          for (const statement of sf.statements) {
            if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
            const mod = statement.moduleSpecifier.text
            if (mod === "node:child_process") {
              const clause = statement.importClause
              if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                childProcessNamespace = clause.namedBindings.name.text
              } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) importedNames.add(el.name.text)
              }
            }
          }
          const fileHits: SpawnSite[] = []
          const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
              if (ts.isIdentifier(node.expression)) {
                if (importedNames.has(node.expression.text)) fileHits.push({ file: rel, line: line + 1, kind: node.expression.text })
              } else if (ts.isPropertyAccessExpression(node.expression)) {
                const name = node.expression.name.text
                const obj = node.expression.expression
                if (childProcessNamespace && ts.isIdentifier(obj) && obj.text === childProcessNamespace && PROCESS_NAMES.has(name)) {
                  fileHits.push({ file: rel, line: line + 1, kind: `child_process.${name}` })
                }
                if (name === "spawn" && ts.isIdentifier(obj) && obj.text === "Bun") {
                  fileHits.push({ file: rel, line: line + 1, kind: "Bun.spawn" })
                }
                if (name === "Command" && ts.isIdentifier(obj) && obj.text === "Deno") {
                  fileHits.push({ file: rel, line: line + 1, kind: "Deno.Command" })
                }
              }
            }
            if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "shell") {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
              const valueText = node.initializer.getText(sf)
              if (valueText === "true") fileHits.push({ file: rel, line: line + 1, kind: "shell:true" })
            }
            ts.forEachChild(node, visit)
          }
          visit(sf)
          sites.push(...fileHits)
        }
      }
    }
    walk(join(process.cwd(), "src"))
    return sites
  }

  test("direct child_process / Bun.spawn / Deno.Command / shell:true outside allowlist = 0", () => {
    const sites = scanDirectProcessCalls()
    const outside = sites.filter(s => !ALLOWLIST.some(a => s.file === a || s.file.startsWith(a + "/")))
    expect(outside).toEqual([])
  })

  test("allowlist modules remain the only direct process entries (total audited)", () => {
    // 允许列表内的调用不得消失 —— 防止"删掉入口"式假绿。
    const sites = scanDirectProcessCalls()
    const executorSites = sites.filter(s => s.file.startsWith("src/runtime/process-executor") || s.file.startsWith("src/runtime/legacy-process"))
    expect(executorSites.length).toBeGreaterThan(0)
  })
})

describe("PR-2: receipt reaches ProcessExecutor consumers (no longer dropped)", () => {
  linuxOnly("collectProcessRun carries a real receipt with self digest", async () => {
    const { collectProcessRun, executeProcess } = await import("../../../src/runtime/process-executor")
    const outcome = await collectProcessRun({ command: "/bin/true", args: [], timeoutMs: 10_000 })
    expect(outcome.receipt).toBeDefined()
    expect(outcome.receipt!.backend).toBe("host-audit")
    expect(outcome.receipt!.receiptDigest.length).toBe(16)
    // durationMs 来自真实执行（不是 0 推定值）
    expect(outcome.receipt!.durationMs).toBeGreaterThanOrEqual(0)
    expect(outcome.receipt!.finishedAt).toBeGreaterThan(outcome.receipt!.startedAt)

    // executeProcess 流式事件同样透传 receipt（不丢弃）
    const events: Array<{ type: string; [k: string]: unknown }> = []
    for await (const e of executeProcess({ command: "/bin/true", args: [], timeoutMs: 10_000 })) {
      events.push(e as unknown as { type: string; [k: string]: unknown })
    }
    expect(events.some(e => e.type === "receipt")).toBe(true)
  })
})

describe("PR-3: output limit kills the process (hard limit)", () => {
  linuxOnly("infinite output is terminated well before wall timeout", async () => {
    const startedAt = Date.now()
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "yes x"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 60_000,
    })
    const elapsed = Date.now() - startedAt
    // PR-3：超限即杀 —— 进程被终止而非跑满 wall timeout
    expect(result.outputLimitHit).toBe(true)
    expect(elapsed).toBeLessThan(10_000)
    // 截断数据总量 ≤ 上限 + 标记
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + TRUNCATION_MARKER.length + 64)
    expect(result.orphanProcesses).toBe(0)
  })

  linuxOnly("streamSupervised yields only truncated data", async () => {
    let received = 0
    let hit = false
    for await (const event of streamSupervised({
      executable: "/bin/sh",
      args: ["-c", "yes x"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 2048, stderrMaxBytes: 2048 },
      wallTimeMs: 60_000,
      onOutput: (stream, data) => { if (stream === "stdout") received += data.length },
    })) {
      if (event.type === "exit") hit = event.result.outputLimitHit
    }
    expect(hit).toBe(true)
    // 回调收到的数据在入队前已截断（≤ 上限）
    expect(received).toBeLessThanOrEqual(2048)
  })
})

describe("PR-6: execution identity flows into ProcessRequest", () => {
  linuxOnly("request identity reaches the compiled spec (no shared tool-run)", async () => {
    const { executeProcess } = await import("../../../src/runtime/process-executor")
    const events: Array<{ type: string; [k: string]: unknown }> = []
    for await (const e of executeProcess({
      command: "/bin/true", args: [], timeoutMs: 10_000,
      runId: "run-test-42", nodeRunId: "run-test-42:n3", agentId: "agent-x", attempt: 3,
    })) events.push(e as unknown as { type: string; [k: string]: unknown })
    const receipt = events.find(e => e.type === "receipt") as { receipt: { runId: string; nodeRunId: string; agentId?: string; attempt: number } } | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.receipt.runId).toBe("run-test-42")
    expect(receipt!.receipt.nodeRunId).toBe("run-test-42:n3")
    expect(receipt!.receipt.agentId).toBe("agent-x")
    expect(receipt!.receipt.attempt).toBe(3)
  })

  linuxOnly("runtime identity context is injected when request omits it", async () => {
    const { executeProcess } = await import("../../../src/runtime/process-executor")
    const { setExecutionIdentity } = await import("../../../src/runtime/execution-context")
    setExecutionIdentity({ runId: "ctx-run-1", nodeRunId: "ctx-run-1:n1", agentId: "ctx-agent", sessionId: "s1" })
    try {
      const events: Array<{ type: string; [k: string]: unknown }> = []
      for await (const e of executeProcess({ command: "/bin/true", args: [], timeoutMs: 10_000 })) {
        events.push(e as unknown as { type: string; [k: string]: unknown })
      }
      const receipt = events.find(e => e.type === "receipt") as { receipt: { runId: string; agentId?: string } } | undefined
      expect(receipt).toBeDefined()
      expect(receipt!.receipt.runId).toBe("ctx-run-1")
      expect(receipt!.receipt.agentId).toBe("ctx-agent")
    } finally {
      setExecutionIdentity({})
    }
  })

  linuxOnly("broker runtimeContext shares a single ledger across consumers", async () => {
    const { createLinuxBroker } = await import("../../../src/runtime/linux/broker")
    const broker = createLinuxBroker({ mode: "enabled" })
    const ctx = broker.runtimeContext()
    expect(ctx.ledger).toBe(broker.ledger())
    expect(ctx.locks).toBeDefined()
    expect(ctx.domainManager).toBeDefined()
    expect(ctx.cacheManager).toBeDefined()
    expect(ctx.stateStore).toBeDefined()
  })
})
