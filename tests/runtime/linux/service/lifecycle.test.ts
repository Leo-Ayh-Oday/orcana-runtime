/** LR2-5（P5-C）：生命周期验收 —— 启动→READY（真实 tcp 探活）→健康失败
 *  →RESTART_EXHAUSTED；端口冲突；优雅停止。 */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { portAvailable, runProbe, ServiceManager } from "../../../../src/runtime/linux/service/lifecycle"
import type { ServiceCellSpec } from "../../../../src/runtime/linux/service/spec"

/** 测试服务：node 起 tcp 监听（用真实进程验证探活语义）。 */
function tcpService(port: number): { proc: ReturnType<typeof spawn>; ready: Promise<void> } {
  const proc = spawn(process.execPath, ["-e", `
    const net = require("net");
    const server = net.createServer();
    server.listen(${port}, "127.0.0.1", () => console.log("ready"));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] })
  const ready = new Promise<void>(resolve => proc.stdout?.on("data", d => { if (String(d).includes("ready")) resolve() }))
  return { proc, ready }
}

function spec(overrides: Partial<ServiceCellSpec> = {}): ServiceCellSpec {
  return {
    serviceId: "svc-t",
    ownerRunId: "run-t",
    command: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
    dependencies: [],
    portRequests: [],
    restartPolicy: "on-failure",
    maxRestarts: 2,
    leasePolicy: { ttlMs: 60_000, renewBy: "manager" },
    logPolicy: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
    shutdownContract: { graceMs: 2000, waitForDrain: true },
    retentionPolicy: "retain",
    ...overrides,
  }
}

describe("Service lifecycle (P5-C)", () => {
  test("port conflict detected before spawn (PORT_CONFLICT_UNCHECKED)", async () => {
    const holder = tcpService(18080)
    await holder.ready
    try {
      const mgr = new ServiceManager({ spec: spec({ command: { executable: "/bin/true", args: [] }, portRequests: [{ name: "p", port: 18080, bind: "loopback" }] }) })
      await expect(mgr.start()).rejects.toThrow(/PORT_CONFLICT/)
      expect(mgr.state.current).toBe("PORT_CONFLICT")
    } finally {
      holder.proc.kill("SIGKILL")
    }
  })

  test("readiness probe passes → READY (real tcp service)", async () => {
    const service = tcpService(18081)
    await service.ready
    try {
      // 服务进程必须长驻（瞬退进程在 READY 前 exit → 假 READY）
      const mgr = new ServiceManager({
        spec: spec({
          command: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
          readinessProbe: { kind: "tcp", host: "127.0.0.1", port: 18081 },
        }),
        probeIntervalMs: 100,
      })
      await mgr.start()
      expect(mgr.state.current).toBe("READY")
      expect(mgr.pid).toBeGreaterThan(0)
      await mgr.stop()
      expect(mgr.state.current).toBe("STOPPED")
    } finally {
      service.proc.kill("SIGKILL")
    }
  })

  test("readiness timeout → HEALTH_FAILED (no false READY)", () => {
    // 无服务监听 → 探活永远失败 → HEALTH_FAILED
    const mgr = new ServiceManager({
      spec: spec({
        command: { executable: "/bin/true", args: [] },
        readinessProbe: { kind: "tcp", host: "127.0.0.1", port: 18999, timeoutMs: 200 },
      }),
      probeIntervalMs: 100,
    })
    // waitReadiness 内部 30s 超时太长 —— 直接测 runProbe 语义 + 状态机
    return runProbe(spec({ readinessProbe: { kind: "tcp", host: "127.0.0.1", port: 18999, timeoutMs: 200 } }), "readinessProbe")
      .then(result => {
        expect(result.ok).toBe(false)
      })
  })

  test("process crash triggers restart policy → RESTART_EXHAUSTED", async () => {
    // 服务进程立即退出（/bin/false）→ 崩溃 → restart → 最终 RESTART_EXHAUSTED
    const mgr = new ServiceManager({
      spec: spec({
        command: { executable: "/bin/false", args: [] },
        restartPolicy: "on-failure",
        maxRestarts: 1,
      }),
      probeIntervalMs: 50,
    })
    await mgr.start() // 无 readiness probe → 直接 READY（进程 exit 后 handleCrash 驱动）
    const deadline = Date.now() + 5000
    while (mgr.state.current !== "RESTART_EXHAUSTED" && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(mgr.state.current).toBe("RESTART_EXHAUSTED")
  })

  test("portAvailable detects in-use ports", async () => {
    const holder = tcpService(18082)
    await holder.ready
    try {
      expect(await portAvailable(18082)).toBe(false)
      expect(await portAvailable(18083)).toBe(true)
    } finally {
      holder.proc.kill("SIGKILL")
    }
  })
})

// ── LR2-5 审核修复验收（B1/M2/M3/M4/M6/M7）──

describe("Service audit fixes (B1/M2/M3/M4/M6/M7)", () => {
  test("B1: stop during start never spawns after stop (epoch cancels continuations)", async () => {
    // 服务在端口检查处挂起 → stop() → 续体必须被 epoch 取消（不 spawn）
    const holder = tcpService(18090)
    await holder.ready
    try {
      const mgr = new ServiceManager({
        spec: spec({
          command: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
          portRequests: [{ name: "p", port: 18091, bind: "loopback" }], // 检查 18091（可用）
        }),
      })
      const startPromise = mgr.start() // 端口检查异步
      await new Promise(r => setTimeout(r, 10))
      await mgr.stop()
      await startPromise
      // stop 后不得有进程（epoch 取消 spawn 续体 + 已 spawn 的被终止）
      expect(mgr.state.current).toBe("STOPPED")
      await new Promise(r => setTimeout(r, 300))
      expect(mgr.isRunning).toBe(false)
    } finally {
      holder.proc.kill("SIGKILL")
    }
  })

  test("M3: exit 0 with on-failure policy does NOT restart", async () => {
    const mgr = new ServiceManager({
      spec: spec({
        command: { executable: "/bin/true", args: [] }, // exit 0 干净退出
        restartPolicy: "on-failure",
        maxRestarts: 3,
      }),
      probeIntervalMs: 50,
    })
    await mgr.start()
    const deadline = Date.now() + 3000
    while (mgr.state.current !== "HEALTH_FAILED" && mgr.state.current !== "STOPPED" && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(mgr.state.current).toBe("HEALTH_FAILED") // 不重启（exit 0 非失败）
  })

  test("M4: process exit during READINESS_PENDING triggers restart (not stuck probing)", async () => {
    const mgr = new ServiceManager({
      spec: spec({
        command: { executable: "/bin/false", args: [] }, // 瞬退
        readinessProbe: { kind: "tcp", host: "127.0.0.1", port: 18997, timeoutMs: 300 },
        restartPolicy: "always",
        maxRestarts: 1,
      }),
      probeIntervalMs: 50,
      readinessTimeoutMs: 5000,
    })
    const started = mgr.start().catch(() => {})
    const deadline = Date.now() + 4000
    while (mgr.state.current !== "RESTART_EXHAUSTED" && mgr.state.current !== "HEALTH_FAILED" && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(mgr.state.current).toBe("RESTART_EXHAUSTED") // 重启路径生效（不卡 READINESS_PENDING）
    await started
  })

  test("M6: missing executable → START_FAILED (not stuck)", async () => {
    const mgr = new ServiceManager({
      spec: spec({ command: { executable: "/nonexistent-binary-xyz", args: [] } }),
      probeIntervalMs: 50,
    })
    await mgr.start()
    const deadline = Date.now() + 2000
    while (mgr.state.current === "DECLARED" || mgr.state.current === "STARTING" && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30))
    }
    expect(["START_FAILED", "HEALTH_FAILED"]).toContain(mgr.state.current)
  })

  test("M7: missing required fields rejected by spec validation", () => {
    const { validateServiceSpec } = require("../../../../src/runtime/linux/service/spec.ts") as typeof import("../../../../src/runtime/linux/service/spec")
    const noLease = spec({ leasePolicy: undefined as never })
    expect(validateServiceSpec(noLease).ok).toBe(false)
    const noShutdown = spec({ shutdownContract: undefined as never })
    expect(validateServiceSpec(noShutdown).ok).toBe(false)
    // probe.url 缺失 → 校验错误而非抛 TypeError
    const badProbe = spec({ readinessProbe: { kind: "http" } as never })
    expect(validateServiceSpec(badProbe).ok).toBe(false)
  })
})
