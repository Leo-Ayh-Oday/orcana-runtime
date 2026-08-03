import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import { getActiveMode, setActiveMode, type ModeName } from "../src/agent/mode-contract"
import {
  clearActivePatchContext,
  getActivePatchContext,
  setActivePatchContext,
} from "../src/agent/patch-transaction"
import {
  createRuntimeExecutionContext,
  getRuntimeContextBudgetMode,
  runWithRuntimeExecutionContext,
  setRuntimeContextBudgetMode,
} from "../src/agent/runtime-context"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { SandboxManager } from "../src/sandbox/sandbox"
import { HookEvent, HookSystem } from "../src/hooks"
import {
  adaptiveCheckpointThreshold,
  resetCheckpointScheduler,
} from "../src/session/checkpoint"
import { buildTools, Result } from "../src/tools/registry"
import { getShellSandbox, setShellSandbox } from "../src/tools/shell"

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

class ModeProbeProvider implements LLMProvider {
  rounds = 0
  observedMode = ""

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe", name: "mcp__mode_probe", input: {} } }
      return
    }
    this.observedMode = getActiveMode().mode
    yield { type: "text", data: "done" }
  }
}

class TextProvider implements LLMProvider {
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield { type: "text", data: "done" }
  }
}

class AbortAwareProvider implements LLMProvider {
  aborted = false

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    options.abortSignal?.addEventListener("abort", () => { this.aborted = true }, { once: true })
    yield { type: "status", data: "provider-ready" }
    await new Promise<void>(() => {})
  }
}

class ExternallyAbortableProvider implements LLMProvider {
  aborted = false

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const aborted = new Promise<void>(resolve => {
      options.abortSignal?.addEventListener("abort", () => {
        this.aborted = true
        resolve()
      }, { once: true })
    })
    yield { type: "status", data: "provider-ready" }
    await aborted
  }
}

class CountingProvider implements LLMProvider {
  calls = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    yield { type: "text", data: "should not run" }
  }
}

class BlockingToolProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "blocking", name: "mcp__blocking_probe", input: {} } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

describe("agent runtime context", () => {
  test("checkpoint scheduling is independent for each runtime context", () => {
    resetCheckpointScheduler()
    const first = createRuntimeExecutionContext()
    const second = createRuntimeExecutionContext()
    const metrics = { filesPerRound: 0, errorRate: 0, round: 4 }

    const firstDecision = runWithRuntimeExecutionContext(
      first,
      () => adaptiveCheckpointThreshold(50, metrics),
    )
    const secondDecision = runWithRuntimeExecutionContext(
      second,
      () => adaptiveCheckpointThreshold(50, metrics),
    )

    expect(firstDecision).toMatchObject({ label: "full" })
    expect(secondDecision).toMatchObject({ label: "full" })
  })

  test("runtime values remain local across overlapping async contexts", async () => {
    setRuntimeContextBudgetMode("normal")
    setShellSandbox(null)
    clearActivePatchContext()
    const first = createRuntimeExecutionContext()
    const second = createRuntimeExecutionContext()
    const firstSandbox = {} as SandboxManager
    const secondSandbox = {} as SandboxManager
    let releaseFirst!: () => void
    let markFirstReady!: () => void
    const firstReady = new Promise<void>(resolve => { markFirstReady = resolve })
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve })

    await Promise.all([
      runWithRuntimeExecutionContext(first, async () => {
        setRuntimeContextBudgetMode("degraded")
        setShellSandbox(firstSandbox)
        setActivePatchContext({ scope: ["first.ts"], verification: ["test"], nodeId: "first" })
        markFirstReady()
        await firstMayFinish
        expect(getRuntimeContextBudgetMode()).toBe("degraded")
        expect(getShellSandbox()).toBe(firstSandbox)
        expect(getActivePatchContext()?.nodeId).toBe("first")
      }),
      (async () => {
        await firstReady
        await runWithRuntimeExecutionContext(second, async () => {
          setRuntimeContextBudgetMode("block")
          setShellSandbox(secondSandbox)
          setActivePatchContext({ scope: ["second.ts"], verification: ["build"], nodeId: "second" })
          releaseFirst()
          await Promise.resolve()
          expect(getRuntimeContextBudgetMode()).toBe("block")
          expect(getShellSandbox()).toBe(secondSandbox)
          expect(getActivePatchContext()?.nodeId).toBe("second")
        })
      })(),
    ])

    expect(getRuntimeContextBudgetMode()).toBe("normal")
    expect(getShellSandbox()).toBeNull()
    expect(getActivePatchContext()).toBeNull()
  })

  test("concurrent agent loops keep independent active modes", async () => {
    setActiveMode("coder")
    let releaseFirst!: () => void
    let markFirstReady!: () => void
    const firstReady = new Promise<void>(resolve => { markFirstReady = resolve })
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstProvider = new ModeProbeProvider()
    const secondProvider = new ModeProbeProvider()

    const consume = async (
      provider: ModeProbeProvider,
      activeMode: ModeName,
      execute: () => Promise<void>,
    ) => {
      const tools = buildTools({
        name: "mcp__mode_probe",
        description: "Observe the active run mode",
        isReadonly: true,
        isConcurrencySafe: true,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          await execute()
          return Result.ok("observed")
        },
      })
      for await (const _event of agentLoop("run the mode probe", {
        provider,
        model: "test",
        tools,
        activeMode,
        maxRounds: 2,
      })) {
        // Consume both rounds so the provider observes the mode after overlap.
      }
    }

    await Promise.all([
      consume(firstProvider, "planner", async () => {
        markFirstReady()
        await firstMayFinish
      }),
      consume(secondProvider, "report", async () => {
        await firstReady
        releaseFirst()
      }),
    ])

    expect(firstProvider.observedMode).toBe("planner")
    expect(secondProvider.observedMode).toBe("report")
    expect(getActiveMode().mode).toBe("coder")
  })

  test("closing an agent loop early disposes its sandbox", async () => {
    const dispose = spyOn(SandboxManager.prototype, "dispose")
    try {
      const iterator = agentLoop("inspect the project", {
        provider: new TextProvider(),
        model: "test",
        tools: [],
        maxRounds: 1,
      })

      await iterator.next()
      await iterator.return(undefined as never)

      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      dispose.mockRestore()
    }
  })

  test("closing an agent loop early aborts the active provider stream", async () => {
    const provider = new AbortAwareProvider()
    const iterator = agentLoop("inspect the project", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 1,
    })

    while (true) {
      const event = await iterator.next()
      if (event.done || (event.value.type === "status" && event.value.data === "provider-ready")) break
    }
    await iterator.return(undefined as never)

    expect(provider.aborted).toBe(true)
  })

  test("closing an agent loop early dispatches one aborted Stop hook", async () => {
    const provider = new AbortAwareProvider()
    const hooks = new HookSystem()
    const stopReasons: string[] = []
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const iterator = agentLoop("inspect the project", {
      provider,
      model: "test",
      tools: [],
      hooks,
      maxRounds: 1,
    })

    while (true) {
      const event = await iterator.next()
      if (event.done || (event.value.type === "status" && event.value.data === "provider-ready")) break
    }
    await iterator.return(undefined as never)

    expect(stopReasons).toEqual(["aborted"])
  })

  test("an external run abort reaches the active provider stream", async () => {
    const provider = new ExternallyAbortableProvider()
    const controller = new AbortController()
    const iterator = agentLoop("inspect the project", {
      provider,
      model: "test",
      tools: [],
      abortSignal: controller.signal,
      maxRounds: 1,
    })

    while (true) {
      const event = await iterator.next()
      if (event.done || (event.value.type === "status" && event.value.data === "provider-ready")) break
    }
    controller.abort("user cancelled")
    await Promise.race([
      new Promise<void>(resolve => {
        const poll = () => provider.aborted ? resolve() : setTimeout(poll, 1)
        poll()
      }),
      new Promise<void>(resolve => setTimeout(resolve, 25)),
    ])

    expect(provider.aborted).toBe(true)
    await iterator.return(undefined as never)
  })

  test("a pre-aborted run never calls the provider", async () => {
    const provider = new CountingProvider()
    const controller = new AbortController()
    controller.abort("cancelled before start")

    for await (const _event of agentLoop("inspect the project", {
      provider,
      model: "test",
      tools: [],
      abortSignal: controller.signal,
      maxRounds: 1,
    })) {
      // A pre-aborted run exits without producing provider events.
    }

    expect(provider.calls).toBe(0)
  })

  test("an external run abort stops waiting for a legacy blocking tool", async () => {
    const controller = new AbortController()
    let markStarted!: () => void
    let releaseTool!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const blocked = new Promise<ReturnType<typeof Result.ok>>(resolve => {
      releaseTool = () => resolve(Result.ok("released"))
    })
    const tools = buildTools({
      name: "mcp__blocking_probe",
      description: "Legacy tool that does not observe cancellation",
      isReadonly: true,
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      execute() {
        markStarted()
        return blocked
      },
    })
    const run = (async () => {
      for await (const _event of agentLoop("run the blocking probe", {
        provider: new BlockingToolProvider(),
        model: "test",
        tools,
        abortSignal: controller.signal,
        maxRounds: 2,
      })) {
        // Consume until cancellation closes the run.
      }
    })()

    await started
    controller.abort("cancel blocking tool")
    const completedPromptly = await Promise.race([
      run.then(() => true),
      // Keep the bound generous enough for a loaded Windows CI worker while
      // still proving that cancellation does not wait for the legacy tool's
      // 60-second timeout or eventual completion.
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ])

    // Always release the legacy promise so a failed assertion cannot leave
    // background work retained by the test process.
    releaseTool()
    await run
    expect(completedPromptly).toBe(true)
  })

  test("an external run abort stops waiting for a legacy blocking streaming tool", async () => {
    const controller = new AbortController()
    let markStarted!: () => void
    let releaseTool!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const blocked = new Promise<void>(resolve => { releaseTool = resolve })
    const tools = buildTools({
      name: "mcp__blocking_probe",
      description: "Legacy streaming tool that ignores cancellation",
      isReadonly: true,
      inputSchema: { type: "object", properties: {} },
      execute() {
        return Result.ok("unused")
      },
      async *executeStream() {
        markStarted()
        yield { type: "progress" as const, data: "started" }
        await blocked
        yield { type: "done" as const, data: Result.ok("released") }
      },
    })
    const run = (async () => {
      for await (const _event of agentLoop("run the blocking probe", {
        provider: new BlockingToolProvider(),
        model: "test",
        tools,
        abortSignal: controller.signal,
        maxRounds: 2,
      })) {}
    })()

    await started
    controller.abort("cancel blocking stream")
    const completedPromptly = await Promise.race([
      run.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ])

    releaseTool()
    await run
    expect(completedPromptly).toBe(true)
  })
})
