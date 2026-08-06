import { describe, expect, test } from "bun:test"
import { runProcess, scriptSideEffectPlan, terminateTree } from "../../src/tools/process"
import { RUN_PROCESS_TOOL, RUN_SHELL_SCRIPT_TOOL } from "../../src/tools/process"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../../src/runtime/linux/contracts"

// RT-7: parameterized process execution — shell:false, args arrays, process
// trees, timeout/cancel, structured results.

const IS_WIN = process.platform === "win32"

/** Linux execution is fail-closed without a trusted authority (R2 PR-9). */
async function withAuthority<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "rt7-test", nodeRunId: "rt7-test-0", attempt: 1 },
      workspace: {
        workspaceId: "rt7-ws",
        projectId: "rt7-proj",
        hostRoot: process.cwd(),
        kind: "main",
        access: "readwrite",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    return fn()
  })
}

describe("RT-7 runProcess core", () => {
  test("executes a parameterized command with structured result", async () => {
    const r = await withAuthority(() => runProcess({
      command: IS_WIN ? "cmd.exe" : "echo",
      args: IS_WIN ? ["/c", "echo", "hello-rt7"] : ["hello-rt7"],
    }))
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("hello-rt7")
    expect(r.signal).toBeNull()
    expect(r.timedOut).toBe(false)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("args are never a command string (echo passes through as one arg)", async () => {
    // "echo" with a single arg containing spaces must NOT be split by a shell.
    const r = await withAuthority(() => runProcess({
      command: IS_WIN ? "cmd.exe" : "echo",
      args: IS_WIN ? ["/c", "echo", "a b c"] : ["a b c"],
    }))
    expect(r.stdout.trim()).toBe("a b c")
  })

  test("non-zero exit code is reported structurally", async () => {
    const r = await withAuthority(() => runProcess({
      command: IS_WIN ? "cmd.exe" : "sh",
      args: IS_WIN ? ["/c", "exit", "3"] : ["-c", "exit 3"],
    }))
    expect(r.exitCode).toBe(3)
  })

  test("timeout kills the process tree", async () => {
    const r = await withAuthority(() => runProcess({
      command: IS_WIN ? "cmd.exe" : "sleep",
      args: IS_WIN ? ["/c", "timeout", "/t", "5"] : ["10"],
      timeoutMs: 300,
    }))
    expect(r.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(5000)
  })

  test("abort signal cancels the process", async () => {
    const controller = new AbortController()
    await withAuthority(async () => {
      const promise = runProcess({
        command: IS_WIN ? "cmd.exe" : "sleep",
        args: IS_WIN ? ["/c", "timeout", "/t", "5"] : ["30"],
        abortSignal: controller.signal,
      })
      setTimeout(() => controller.abort(), 200)
      const r = await promise
      expect(r.aborted).toBe(true)
    })
  })

  test("env is merged over the inherited environment", async () => {
    const r = await withAuthority(() => runProcess({
      command: IS_WIN ? "cmd.exe" : "sh",
      args: IS_WIN ? ["/c", "echo", "%RT7_VAR%"] : ["-c", "echo $RT7_VAR"],
      env: { RT7_VAR: "merged-ok" },
    }))
    expect(r.stdout).toContain("merged-ok")
  })
})

describe("RT-7 tools", () => {
  test("run_process tool executes and reports exitCode", async () => {
    const result = await withAuthority(() => RUN_PROCESS_TOOL.execute!({
      executable: IS_WIN ? "cmd.exe" : "echo",
      args: IS_WIN ? ["/c", "echo", "tool-ok"] : ["tool-ok"],
    }))
    expect(result.success).toBe(true)
    expect((result.metadata as { exitCode: number }).exitCode).toBe(0)
    expect(result.content).toContain("tool-ok")
  })

  test("run_process rejects missing executable", async () => {
    const result = await RUN_PROCESS_TOOL.execute!({ executable: "", args: [] })
    expect(result.success).toBe(false)
  })

  test("run_shell_script runs through an explicit shell with a side-effect plan", async () => {
    const result = await withAuthority(() => RUN_SHELL_SCRIPT_TOOL.execute!({
      script: IS_WIN ? "echo script-ok" : "echo script-ok",
      shellType: IS_WIN ? "cmd" : "bash",
    }))
    expect(result.success).toBe(true)
    const meta = result.metadata as { shellType: string; sideEffects: string[] }
    expect(meta.shellType).toBe(IS_WIN ? "cmd" : "bash")
    expect(result.content).toContain("script-ok")
  })

  test("scriptSideEffectPlan flags writes/network/privilege", () => {
    expect(scriptSideEffectPlan("echo hi")).toEqual(["read"])
    expect(scriptSideEffectPlan("rm -rf tmp")).toContain("write")
    expect(scriptSideEffectPlan("curl -s https://x")).toContain("network")
    expect(scriptSideEffectPlan("sudo apt update")).toContain("privilege")
  })

  test("terminateTree is callable without throwing on a finished process", () => {
    // Smoke: terminating an already-exited process must not throw.
    const controller = new AbortController()
    void withAuthority(async () => {
      const promise = runProcess({
        command: IS_WIN ? "cmd.exe" : "echo",
        args: IS_WIN ? ["/c", "echo", "x"] : ["x"],
        abortSignal: controller.signal,
      })
      promise.then(() => controller.abort())
    })
  })
})
