/** MACP-M4 acceptance: 持久化中断、人工等待与恢复.
 *
 *  Gates: PERSISTENT_INTERRUPT / DOUBLE_RESUME / STALE_RESUME_ACCEPTED /
 *  PROCESS_BOUND_WAITING.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec, WorkflowNodeSpec } from "../../src/workflow/types"
import type { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { HandlerRegistry as RegistryImpl } from "../../src/workflow/execution/handler-registry"
import type { WorkflowHarnessEnvironment } from "../../src/workflow/harness/environment"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { InterruptStore } from "../../src/workflow/interrupts/interrupt-store"
import { ResumeController, computeSpecDigest } from "../../src/workflow/interrupts/resume-controller"

interface Bundle {
  env: WorkflowHarnessEnvironment
  projectRoot: string
  store: InterruptStore
  controller: ResumeController
  specDigest: string
  executed: string[]
}

function buildBundle(): Bundle {
  const projectRoot = mkdtempSync(join(tmpdir(), "m4-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "m4-run", sessionId: "m4", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
  }
  const store = new InterruptStore(join(projectRoot, ".orcana", "workflow", "interrupts"))
  return {
    env,
    projectRoot,
    store,
    controller: new ResumeController(store, projectRoot),
    specDigest: "m4-spec",
    executed: [],
  }
}

function reg(bundle: Bundle): HandlerRegistry {
  const registry = new RegistryImpl()
  registry.register("test.work", "work", async () => {
    bundle.executed.push("work")
    return { content: "done" }
  })
  return registry
}

function spec(nodes: WorkflowNodeSpec[]): WorkflowSpec {
  return { schemaVersion: "0.2", specId: "m4-spec", nodes }
}

function humanNode(id: string, prompt: string): WorkflowNodeSpec {
  return {
    id,
    handler: "test.work",
    input: { kind: "plan_approval" },
    dependsOn: [],
    execution: { kind: "human", prompt, responseSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] } },
  }
}

const resultOf = (run: Awaited<ReturnType<typeof runScheduler>>, id: string) =>
  run.results.find(r => r.nodeId === id)!

describe("M4: pause", () => {
  test("human node pauses the run with a persisted record + resume token", async () => {
    const bundle = buildBundle()
    try {
      const waiting: { record: unknown; token: string } = { record: null, token: "" }
      const run = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: {
          controller: bundle.controller,
          specDigest: bundle.specDigest,
          onWaiting: (record, token) => { waiting.record = record; waiting.token = token },
        },
      })
      expect(run.status).toBe("waiting_interrupt")
      expect(run.interrupt?.nodeId).toBe("h:1")
      expect(run.interrupt?.kind).toBe("approval")
      expect(run.interrupt?.prompt).toBe("approve?")
      expect(run.interrupt?.resumeToken).toBeTruthy()
      expect(waiting.token).toBe(run.interrupt!.resumeToken)
      // 记录已持久化到磁盘（进程退出后仍存在）
      expect(bundle.store.get(run.interrupt!.interruptId)?.status).toBe("waiting")
      expect(existsSync(join(bundle.projectRoot, ".orcana", "workflow", "interrupts", `${run.interrupt!.interruptId}.json`))).toBe(true)
      // 中断节点没有结果（没有失败，没有完成）
      expect(run.results.find(r => r.nodeId === "h:1")).toBeUndefined()
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("waiting records are readable after restart (fresh store instance)", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      const interruptId = first.interrupt!.interruptId
      // “进程退出”：新 store 实例重新读取
      const freshStore = new InterruptStore(join(bundle.projectRoot, ".orcana", "workflow", "interrupts"))
      expect(freshStore.get(interruptId)?.status).toBe("waiting")
      expect(freshStore.list("waiting").map(r => r.interruptId)).toContain(interruptId)
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("downstream nodes do not run while waiting (subgraph stops)", async () => {
    const bundle = buildBundle()
    try {
      const run = await runScheduler(
        spec([
          humanNode("h:1", "approve?"),
          { id: "after:1", handler: "test.work", input: {}, dependsOn: ["h:1"] },
        ]),
        reg(bundle),
        {
          harness: bundle.env,
          interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
        },
      )
      expect(run.status).toBe("waiting_interrupt")
      expect(bundle.executed).toEqual([])
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M4: resume", () => {
  function pauseAndResumeAnswer(bundle: Bundle, answer: unknown) {
    const first = runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
      harness: bundle.env,
      interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
    })
    return first
  }

  test("valid answer resumes and completes downstream work", async () => {
    const bundle = buildBundle()
    try {
      const first = await pauseAndResumeAnswer(bundle, undefined as never)
      const token = first.interrupt!.resumeToken
      const attempt = bundle.controller.resume(token, bundle.specDigest, { accepted: true })
      expect(attempt.ok).toBe(true)
      const second = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: {
          controller: bundle.controller,
          specDigest: bundle.specDigest,
          resumeAnswer: { nodeId: "h:1", answer: attempt.answer, interruptId: attempt.record!.interruptId },
          onResolved: id => bundle.controller.resolve(id),
        },
      })
      expect(second.status).toBe("done")
      expect(resultOf(second, "h:1").status).toBe("done")
      expect(resultOf(second, "h:1").output).toEqual({ accepted: true })
      // 记录标记为 resolved
      expect(bundle.store.get(attempt.record!.interruptId)?.status).toBe("resolved")
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("wrong schema answer rejected", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      const attempt = bundle.controller.resume(first.interrupt!.resumeToken, bundle.specDigest, { nope: 1 })
      expect(attempt.ok).toBe(false)
      expect(attempt.reason).toContain("schema rejected")
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("expired token rejected", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      // 手工构造过期 token（expiresAt 在过去）
      const { createResumeToken } = await import("../../src/workflow/interrupts/resume-token")
      const stale = createResumeToken({ specDigest: bundle.specDigest, expiresAt: Date.now() - 1000, interruptId: first.interrupt!.interruptId })
      const attempt = bundle.controller.resume(stale, bundle.specDigest, { accepted: true })
      expect(attempt.ok).toBe(false)
      expect(attempt.reason).toContain("expired")
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("graph version change rejects stale token", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      // 图版本变化（specDigest 不同）
      const attempt = bundle.controller.resume(first.interrupt!.resumeToken, "changed-spec-digest", { accepted: true })
      expect(attempt.ok).toBe(false)
      expect(attempt.reason).toContain("graph version changed")
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("token cannot be reused (DOUBLE_RESUME: 0)", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      const token = first.interrupt!.resumeToken
      const attempt = bundle.controller.resume(token, bundle.specDigest, { accepted: true })
      expect(attempt.ok).toBe(true)
      // 记录被 resolve 后，同一 token 再也不能恢复
      bundle.controller.resolve(attempt.record!.interruptId)
      const again = bundle.controller.resume(token, bundle.specDigest, { accepted: true })
      expect(again.ok).toBe(false)
      expect(again.reason).toContain("already resolved")
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("resume consumes the token atomically — second resume fails (M10)", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      const token = first.interrupt!.resumeToken
      const attempt = bundle.controller.resume(token, bundle.specDigest, { accepted: true })
      expect(attempt.ok).toBe(true)
      // 消费是原子的：waiting → resuming 立即持久化，第二个并发 resume 失败
      const record = bundle.store.get(attempt.record!.interruptId)
      expect(record?.status).toBe("resuming")
      const again = bundle.controller.resume(token, bundle.specDigest, { accepted: true })
      expect(again.ok).toBe(false)
      expect(again.reason).toContain("already resuming")
      // 崩溃后状态明确：resuming 是可恢复/可审计的中间态
      expect(bundle.store.list("resuming")).toHaveLength(1)
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("rejected resume does not consume the token (M10)", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      const token = first.interrupt!.resumeToken
      // 先触发一次校验失败（schema 拒绝）—— 不得消费
      const bad = bundle.controller.resume(token, bundle.specDigest, { accepted: "nope" })
      expect(bad.ok).toBe(false)
      expect(bundle.store.get(bad.record?.interruptId ?? "")).toBeUndefined()
      expect(bundle.store.list("waiting")).toHaveLength(1)
      // 合法 resume 仍成功（未被污染）
      const good = bundle.controller.resume(token, bundle.specDigest, { accepted: true })
      expect(good.ok).toBe(true)
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("workspace changed since interrupt → resume rejected (re-verify)", async () => {
    const bundle = buildBundle()
    try {
      const first = await runScheduler(spec([humanNode("h:1", "approve?")]), reg(bundle), {
        harness: bundle.env,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      // 工作区变化
      writeFileSync(join(bundle.projectRoot, "new-file.txt"), "changed")
      const attempt = bundle.controller.resume(first.interrupt!.resumeToken, bundle.specDigest, { accepted: true })
      expect(attempt.ok).toBe(false)
      expect(attempt.reason).toContain("workspace changed")
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
    }
  })

  test("resume does not re-execute completed nodes (checkpoint restore)", async () => {
    const bundle = buildBundle()
    const checkpointDir = join(tmpdir(), `m4-ckpt-${Date.now()}`)
    mkdirSync(checkpointDir, { recursive: true })
    try {
      const specDef = spec([
        { id: "work:1", handler: "test.work", input: {}, dependsOn: [] },
        { id: "h:1", handler: "test.work", input: { kind: "plan_approval" }, dependsOn: ["work:1"], execution: { kind: "human", prompt: "approve?", responseSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] } } },
        { id: "after:1", handler: "test.work", input: {}, dependsOn: ["h:1"] },
      ])
      const first = await runScheduler(specDef, reg(bundle), {
        harness: bundle.env,
        checkpointDir,
        interrupts: { controller: bundle.controller, specDigest: bundle.specDigest },
      })
      expect(first.status).toBe("waiting_interrupt")
      expect(bundle.executed).toEqual(["work"]) // 前置节点执行了一次
      // 恢复：前置节点不得重跑
      const attempt = bundle.controller.resume(first.interrupt!.resumeToken, bundle.specDigest, { accepted: true })
      expect(attempt.ok).toBe(true)
      const second = await runScheduler(specDef, reg(bundle), {
        harness: bundle.env,
        checkpointDir,
        interrupts: {
          controller: bundle.controller,
          specDigest: bundle.specDigest,
          resumeAnswer: { nodeId: "h:1", answer: attempt.answer, interruptId: attempt.record!.interruptId },
        },
      })
      expect(second.status).toBe("done")
      // work:1 不重跑（checkpoint restore）；after:1 新执行一次
      expect(bundle.executed).toEqual(["work", "work"])
    } finally {
      rmSync(bundle.projectRoot, { recursive: true, force: true })
      rmSync(checkpointDir, { recursive: true, force: true })
    }
  })

  test("spec digest changes when the graph changes", () => {
    const a = spec([humanNode("h:1", "x"), { id: "n:1", handler: "test.work", input: {}, dependsOn: [] }])
    const b = spec([{ id: "n:1", handler: "test.work", input: {}, dependsOn: [] }, humanNode("h:1", "x")])
    const c = spec([humanNode("h:1", "y"), { id: "n:1", handler: "test.work", input: {}, dependsOn: [] }])
    expect(computeSpecDigest(a)).toBe(computeSpecDigest(b))
    expect(computeSpecDigest(a)).not.toBe(computeSpecDigest(c))
  })
})
