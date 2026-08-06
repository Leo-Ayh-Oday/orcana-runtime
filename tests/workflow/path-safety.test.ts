/** Batch 2 acceptance: path safety.
 *
 *  M1  — an EXPLICIT assignment naming an unregistered agent fails closed
 *        (ownership_denied), never degrading to shared-workspace execution;
 *  M2  — agent ids are identifiers, never paths (registration and worktree
 *        creation reject path-like ids before any deletion);
 *  M3  — owner files must stay inside both project (source) and worktree
 *        (target) — `../secret.txt` is rejected before any access;
 *  M8  — duplicate node ids fail validation (and scheduler entry) before
 *        any node executes;
 *  M12 — spec ids are identifiers, never paths (checkpoint file names join
 *        them directly; path-escape ids are rejected at construction).
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import type { ToolExecutionContext } from "../../src/harness/capabilities/execution-context"
import { AgentPool } from "../../src/workflow/agents/agent-pool"
import { createWorktree } from "../../src/workflow/agents/worktree"
import { ResultStore } from "../../src/workflow/results/result-store"
import { validateSpec } from "../../src/workflow/validation"

/** 写类 mock capability：相对路径解析到 runContext.projectRoot（worktree
 *  根或共享根），输出携带实际写入路径 metadata.paths。 */
function registerWriteCap(env: WorkflowHarnessEnvironment): void {
  env.capabilities.register(
    createCapabilityDescriptor({
      id: "mock_write",
      kind: "tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "write",
    }),
    {
      async execute(input: unknown, meta: unknown) {
        const params = input as { path?: string; content?: string }
        const runContext = (meta as { metadata?: { runContext?: ToolExecutionContext } })?.metadata?.runContext
        const root = runContext?.projectRoot!
        writeFileSync(join(root, params.path!), params.content ?? "new")
        return {
          ok: true,
          output: { success: true, content: "written", metadata: { paths: [join(root, params.path!)] } },
        }
      },
    },
  )
}

function buildEnv(): { env: WorkflowHarnessEnvironment; projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "mw-safety-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "mw-safety", sessionId: "mw-safety", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
    policy: { allowCapabilities: ["mock_write"] },
  }
  registerWriteCap(env)
  return { env, projectRoot }
}

function registry(): HandlerRegistry {
  const reg = new RegistryImpl()
  reg.register("test.noop", "noop", async () => ({ content: "noop" }))
  return reg
}

function spec(nodes: WorkflowNodeSpec[]): WorkflowSpec {
  return { schemaVersion: "0.2", specId: "mw-safety-spec", mode: "read-write", nodes }
}

function writeNode(id: string, path: string, assignment?: string): WorkflowNodeSpec {
  return {
    id,
    handler: "test.noop",
    input: { path },
    dependsOn: [],
    assignment,
    execution: { kind: "tool", capabilityId: "mock_write", params: { path } },
  }
}

describe("M1: explicit assignment to an unregistered agent fails closed", () => {
  test("write node naming an unregistered agent ⇒ ownership_denied, no shared-workspace write", async () => {
    const { env, projectRoot } = buildEnv()
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const run = await runScheduler(
        spec([writeNode("a1:w:1", "a.ts", "ghost")]),
        registry(),
        { harness: env, pool },
      )
      const result = run.results.find(r => r.nodeId === "a1:w:1")!
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("ownership_denied")
      expect(result.error).toContain("ghost")
      expect(result.error).toContain("not registered")
      // 共享工作区没有任何写入（deny 发生在任何执行之前）
      expect(readdirSync(projectRoot).filter(e => e !== ".orcana")).toEqual([])
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("implicit id-prefix miss keeps legacy behavior (no over-tightening)", async () => {
    const { env, projectRoot } = buildEnv()
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      // 无显式 assignment；id 前缀 "x" 不是 agent 声明 → G7 legacy：共享工作区执行
      const run = await runScheduler(
        spec([writeNode("x:1", "shared.txt")]),
        registry(),
        { harness: env, pool },
      )
      expect(run.results.find(r => r.nodeId === "x:1")!.status).toBe("done")
      expect(existsSync(join(projectRoot, "shared.txt"))).toBe(true)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M2: agent ids are identifiers, never paths", () => {
  test("registration rejects path-like agent ids", () => {
    const pool = new AgentPool()
    const evil = pool.register({ id: "../../victim", ownerFiles: [], worktree: "/tmp/x" })
    expect(evil.ok).toBe(false)
    expect(evil.error).toContain("../../victim")
    expect(pool.size()).toBe(0)
  })

  test("createWorktree rejects path-like agent ids BEFORE any deletion", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mw-m2-"))
    // 哨兵目录：若 rmSync 先于校验执行，它会被删掉
    const sentinel = join(projectRoot, ".orcana", "worktrees", "victim")
    mkdirSync(sentinel, { recursive: true })
    writeFileSync(join(sentinel, "keep.txt"), "keep")
    try {
      expect(() => createWorktree(projectRoot, "victim/../../victim")).toThrow(/invalid agent id/)
      expect(existsSync(join(sentinel, "keep.txt"))).toBe(true) // 未被删除
      expect(createWorktree(projectRoot, "ok-agent-1").mode).toBe("snapshot")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M3: owner files are contained (source + target)", () => {
  test("ownerFile escaping the project is rejected before any access", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mw-m3-"))
    // 项目外哨兵文件：不得被读取/拷贝/修改
    const outside = join(projectRoot, "..", "mw-m3-secret.txt")
    writeFileSync(outside, "secret")
    try {
      expect(() => createWorktree(projectRoot, "a1", ["../secret.txt"])).toThrow(/escapes project root/)
      expect(readFileSync(outside, "utf8")).toBe("secret") // 未被动过
      expect(existsSync(join(projectRoot, ".orcana", "worktrees", "a1"))).toBe(false) // 未创建
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("legal owner files snapshot into the worktree unchanged", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mw-m3-"))
    writeFileSync(join(projectRoot, "a.ts"), "export const a = 1\n")
    try {
      const handle = createWorktree(projectRoot, "a1", ["a.ts", "missing.ts"])
      expect(handle.mode).toBe("snapshot")
      expect(readFileSync(join(handle.root, "a.ts"), "utf8")).toBe("export const a = 1\n")
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M8: duplicate node ids fail before execution", () => {
  test("validateSpec reports duplicate_node_id", () => {
    const dup: WorkflowSpec = {
      schemaVersion: "0.2",
      specId: "mw-m8",
      nodes: [
        { id: "n:1", handler: "test.noop", input: {}, dependsOn: [] },
        { id: "n:1", handler: "test.noop", input: {}, dependsOn: [] },
      ],
    }
    const report = validateSpec(dup, {
      knownHandlers: new Set(["test.noop"]),
      readonlyHandlers: new Set(["test.noop"]),
    })
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.code === "duplicate_node_id" && i.message.includes("n:1"))).toBe(true)
  })

  test("runScheduler rejects duplicate ids before any node executes", async () => {
    const dup: WorkflowSpec = {
      schemaVersion: "0.2",
      specId: "mw-m8-run",
      nodes: [
        { id: "n:1", handler: "test.noop", input: {}, dependsOn: [] },
        { id: "n:1", handler: "test.noop", input: {}, dependsOn: [] },
      ],
    }
    await expect(runScheduler(dup, registry())).rejects.toThrow(/duplicate node id "n:1"/)
  })
})

describe("M12: spec ids are identifiers, never paths", () => {
  test("path-escape spec ids are rejected at construction", () => {
    expect(() => new ResultStore("../escape")).toThrow(/not a valid checkpoint identifier/)
    expect(() => new ResultStore("a/b")).toThrow(/not a valid checkpoint identifier/)
    expect(() => new ResultStore("a\\b")).toThrow(/not a valid checkpoint identifier/)
    expect(() => new ResultStore("/abs/path")).toThrow(/not a valid checkpoint identifier/)
    expect(() => new ResultStore("..")).toThrow(/not a valid checkpoint identifier/)
  })

  test("identifier-like spec ids are accepted", () => {
    expect(new ResultStore("g5-replay-spec")).toBeInstanceOf(ResultStore)
    expect(new ResultStore("plan:abc123")).toBeInstanceOf(ResultStore)
  })
})
