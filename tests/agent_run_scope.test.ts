import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentLoop } from "../src/agent/loop"
import { createMasterPlan, planRef } from "../src/agent/master-plan"
import { getActiveMode, setActiveMode } from "../src/agent/mode-contract"
import {
  clearTransactionRegistry,
  getActivePatchContext,
  getAllManagedTransactions,
  initManagedTransaction,
  rollbackManagedTransaction,
  setActivePatchContext,
} from "../src/agent/patch-transaction"
import { getRuntimeContextBudgetMode, setRuntimeContextBudgetMode } from "../src/agent/runtime-context"
import { createAgentRunScope, runWithAgentRunScope } from "../src/agent/run/scope"
import { createPlanStore } from "../src/agent/run/plan-store"
import { getAstGrepProvider } from "../src/ripple/astgrep-provider"
import { getCascadeFilesSnapshot, getRippleProgram, setCascadeFiles } from "../src/ripple/engine"
import { getSemanticReferenceProvider } from "../src/ripple/semantic-reference-provider"
import {
  getWriteGeneration,
  hasActiveRuntimeFileStateContext,
  recordRuntimeFileWrite,
} from "../src/file-state"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { requireRuntimeExecutionContext } from "../src/runtime/execution-context"
import type { SandboxManager } from "../src/sandbox/sandbox"
import { META_BUILTIN_TOOL_DEFS } from "../src/tools/meta"
import { buildTools, Result } from "../src/tools/registry"
import { getShellSandbox, setShellSandbox } from "../src/tools/shell"
import { TODO_WRITE_TOOL } from "../src/tools/todo"

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

function plan(goal: string, node: string) {
  return createMasterPlan(goal, "long_task", [node])
}

describe("AgentRunScope L2", () => {
  test("binds stateful tools to one Run while retaining stateless descriptor identity", async () => {
    planRef.current = null
    const detachedTodoResult = await TODO_WRITE_TOOL.execute({
      operation: "add",
      content: "must not enter catalog state",
    })
    expect(detachedTodoResult.success).toBe(false)
    expect(detachedTodoResult.content).toContain("active AgentRunScope")

    const taskDef = META_BUILTIN_TOOL_DEFS.find(defn => defn.name === "task")!
    const probeDef = {
      name: "scope_probe",
      description: "stateless probe",
      isReadonly: true,
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => Result.ok("probe"),
    }
    const catalogTools = buildTools(taskDef, TODO_WRITE_TOOL, probeDef)
    const firstPlan = plan("first goal", "first-only node")
    const secondPlan = plan("second goal", "second-only node")
    const first = createAgentRunScope({
      tools: catalogTools,
      planStore: createPlanStore(firstPlan),
      id: "first-scope",
    })
    const second = createAgentRunScope({
      tools: catalogTools,
      planStore: createPlanStore(secondPlan),
      id: "second-scope",
    })

    expect(first.toolRegistry.get("task")).not.toBe(second.toolRegistry.get("task"))
    expect(first.toolRegistry.get("todo_write")).not.toBe(second.toolRegistry.get("todo_write"))
    expect(first.toolRegistry.get("scope_probe")).toBe(second.toolRegistry.get("scope_probe"))

    const [firstResult, secondResult] = await Promise.all([
      runWithAgentRunScope(first, () => first.toolRegistry.get("task")!.execute({ operation: "list" })),
      runWithAgentRunScope(second, () => second.toolRegistry.get("task")!.execute({ operation: "list" })),
    ])

    expect(firstResult.content).toContain("first-only node")
    expect(firstResult.content).not.toContain("second-only node")
    expect(secondResult.content).toContain("second-only node")
    expect(secondResult.content).not.toContain("first-only node")

    await runWithAgentRunScope(first, () => first.toolRegistry.get("task")!.execute({
      operation: "add",
      title: "first-added node",
    }))
    expect(firstPlan.nodes.some(node => node.title === "first-added node")).toBe(true)
    expect(secondPlan.nodes.some(node => node.title === "first-added node")).toBe(false)

    await Promise.all([
      runWithAgentRunScope(first, () => first.toolRegistry.get("todo_write")!.execute({
        operation: "add",
        content: "first todo",
      })),
      runWithAgentRunScope(second, () => second.toolRegistry.get("todo_write")!.execute({
        operation: "add",
        content: "second todo",
      })),
    ])
    const [firstTodos, secondTodos] = await Promise.all([
      runWithAgentRunScope(first, () => first.toolRegistry.get("todo_write")!.execute({ operation: "list" })),
      runWithAgentRunScope(second, () => second.toolRegistry.get("todo_write")!.execute({ operation: "list" })),
    ])

    expect(firstTodos.content).toContain("#1: first todo")
    expect(firstTodos.content).not.toContain("second todo")
    expect(secondTodos.content).toContain("#1: second todo")
    expect(secondTodos.content).not.toContain("first todo")
    expect(first.todoStore.todos).toHaveLength(1)
    expect(second.todoStore.todos).toHaveLength(1)
  })

  test("keeps Plan, Mode, Sandbox, Patch, Ripple, Budget, WriteGeneration, and transactions isolated", async () => {
    const catalogTools = buildTools(...META_BUILTIN_TOOL_DEFS)
    const firstPlan = plan("first goal", "first node")
    const secondPlan = plan("second goal", "second node")
    const first = createAgentRunScope({ tools: catalogTools, planStore: createPlanStore(firstPlan), id: "run-a" })
    const second = createAgentRunScope({ tools: catalogTools, planStore: createPlanStore(secondPlan), id: "run-b" })
    const firstSandbox = { name: "first" } as unknown as SandboxManager
    const secondSandbox = { name: "second" } as unknown as SandboxManager
    const firstRoot = mkdtempSync(join(tmpdir(), "orcana-l2-first-"))
    const secondRoot = mkdtempSync(join(tmpdir(), "orcana-l2-second-"))
    let releaseFirst!: () => void
    let firstReady!: () => void
    const waitForFirst = new Promise<void>(resolve => { firstReady = resolve })
    const allowFirstToFinish = new Promise<void>(resolve => { releaseFirst = resolve })

    try {
      await Promise.all([
        runWithAgentRunScope(first, async () => {
          clearTransactionRegistry()
          setActiveMode("planner")
          setShellSandbox(firstSandbox)
          setActivePatchContext({ scope: ["first.ts"], verification: ["test"], nodeId: "first" })
          setCascadeFiles(new Set(["first.ts"]))
          setRuntimeContextBudgetMode("degraded")
          recordRuntimeFileWrite({ path: join(firstRoot, "first.ts"), content: "first" })
          const tx = initManagedTransaction({
            tool: "write_file",
            cwd: firstRoot,
            files: [{ relativePath: "first.ts", oldContent: null, newContent: "first" }],
          })
          firstReady()
          await allowFirstToFinish

          expect(requireRuntimeExecutionContext()).toBe(first.runtimeContext)
          expect(hasActiveRuntimeFileStateContext()).toBe(true)
          expect(planRef.current).toBe(firstPlan)
          expect(getActiveMode().mode).toBe("planner")
          expect(getShellSandbox()).toBe(firstSandbox)
          expect(getActivePatchContext()?.nodeId).toBe("first")
          expect([...getCascadeFilesSnapshot()]).toEqual(["first.ts"])
          expect(getRuntimeContextBudgetMode()).toBe("degraded")
          expect(getWriteGeneration()).toBe(1)
          expect(getAllManagedTransactions().map(item => item.txId)).toEqual([tx.txId])
          rollbackManagedTransaction(tx)
        }),
        (async () => {
          await waitForFirst
          await runWithAgentRunScope(second, async () => {
            clearTransactionRegistry()
            setActiveMode("repair")
            setShellSandbox(secondSandbox)
            setActivePatchContext({ scope: ["second.ts"], verification: ["build"], nodeId: "second" })
            setCascadeFiles(new Set(["second.ts"]))
            setRuntimeContextBudgetMode("block")
            recordRuntimeFileWrite({ path: join(secondRoot, "second.ts"), content: "second-a" })
            recordRuntimeFileWrite({ path: join(secondRoot, "second.ts"), content: "second-b" })
            const tx = initManagedTransaction({
              tool: "write_file",
              cwd: secondRoot,
              files: [{ relativePath: "second.ts", oldContent: null, newContent: "second" }],
            })
            releaseFirst()
            await Promise.resolve()

            expect(requireRuntimeExecutionContext()).toBe(second.runtimeContext)
            expect(planRef.current).toBe(secondPlan)
            expect(getActiveMode().mode).toBe("repair")
            expect(getShellSandbox()).toBe(secondSandbox)
            expect(getActivePatchContext()?.nodeId).toBe("second")
            expect([...getCascadeFilesSnapshot()]).toEqual(["second.ts"])
            expect(getRuntimeContextBudgetMode()).toBe("block")
            expect(getWriteGeneration()).toBe(2)
            expect(getAllManagedTransactions().map(item => item.txId)).toEqual([tx.txId])
            rollbackManagedTransaction(tx)
          })
        })(),
      ])
    } finally {
      rmSync(firstRoot, { recursive: true, force: true })
      rmSync(secondRoot, { recursive: true, force: true })
    }

    expect(() => requireRuntimeExecutionContext()).toThrow("No active AgentRunScope")
    expect(hasActiveRuntimeFileStateContext()).toBe(false)
  })

  test("keeps Ripple program and provider caches local to each Run", async () => {
    const tools = buildTools(...META_BUILTIN_TOOL_DEFS)
    const first = createAgentRunScope({ tools, id: "ripple-cache-a" })
    const second = createAgentRunScope({ tools, id: "ripple-cache-b" })
    let firstProgram: ReturnType<typeof getRippleProgram> | undefined
    let secondProgram: ReturnType<typeof getRippleProgram> | undefined
    let firstSemantic: ReturnType<typeof getSemanticReferenceProvider> | undefined
    let secondSemantic: ReturnType<typeof getSemanticReferenceProvider> | undefined
    let firstAstGrep: ReturnType<typeof getAstGrepProvider> | undefined
    let secondAstGrep: ReturnType<typeof getAstGrepProvider> | undefined

    await Promise.all([
      runWithAgentRunScope(first, () => {
        firstProgram = getRippleProgram()
        firstSemantic = getSemanticReferenceProvider(process.cwd())
        firstAstGrep = getAstGrepProvider(process.cwd())

        expect(getRippleProgram()).toBe(firstProgram)
        expect(getSemanticReferenceProvider(process.cwd())).toBe(firstSemantic)
        expect(getAstGrepProvider(process.cwd())).toBe(firstAstGrep)
      }),
      runWithAgentRunScope(second, () => {
        secondProgram = getRippleProgram()
        secondSemantic = getSemanticReferenceProvider(process.cwd())
        secondAstGrep = getAstGrepProvider(process.cwd())

        expect(getRippleProgram()).toBe(secondProgram)
        expect(getSemanticReferenceProvider(process.cwd())).toBe(secondSemantic)
        expect(getAstGrepProvider(process.cwd())).toBe(secondAstGrep)
      }),
    ])

    expect(firstProgram).not.toBe(secondProgram)
    expect(firstSemantic).not.toBe(secondSemantic)
    expect(firstAstGrep).not.toBe(secondAstGrep)
  })
})

class TaskProbeProvider implements LLMProvider {
  private round = 0
  transcript = ""

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.round++ === 0) {
      yield { type: "tool_call", data: { id: "task-list", name: "task", input: { operation: "list" } } }
      return
    }
    this.transcript = JSON.stringify(options.messages)
    yield { type: "text", data: "scope probe complete" }
  }
}

describe("overlapping agent loops", () => {
  test("rebind a shared task catalog to independent per-run PlanStores", async () => {
    const tools = buildTools(...META_BUILTIN_TOOL_DEFS)
    const firstProvider = new TaskProbeProvider()
    const secondProvider = new TaskProbeProvider()

    await Promise.all([
      (async () => {
        for await (const _event of agentLoop("execute first scope plan check", {
          provider: firstProvider,
          model: "test",
          tools,
          planStore: createPlanStore(plan("first loop", "first-loop-only")),
          maxRounds: 2,
          contextMapPolicy: "off",
        })) {
          // consume
        }
      })(),
      (async () => {
        for await (const _event of agentLoop("execute second scope plan check", {
          provider: secondProvider,
          model: "test",
          tools,
          planStore: createPlanStore(plan("second loop", "second-loop-only")),
          maxRounds: 2,
          contextMapPolicy: "off",
        })) {
          // consume
        }
      })(),
    ])

    expect(firstProvider.transcript).toContain("first-loop-only")
    expect(firstProvider.transcript).not.toContain("second-loop-only")
    expect(secondProvider.transcript).toContain("second-loop-only")
    expect(secondProvider.transcript).not.toContain("first-loop-only")
  })
})
