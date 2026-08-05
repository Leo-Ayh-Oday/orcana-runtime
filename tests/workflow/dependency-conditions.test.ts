/** MACP-M1 acceptance: conditional dependencies & result propagation.
 *
 *  Gates: DEPENDENCY_SEMANTICS / LEGACY_SPEC_COMPATIBILITY /
 *  FAILED_UPSTREAM_LEAK=0.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { normalizeDependencies, dependencySatisfied, evaluateReadiness } from "../../src/workflow/scheduler/dependency-policy"
import type { WorkflowSpec, WorkflowNodeResult } from "../../src/workflow/types"

function registry(): HandlerRegistry {
  const reg = new HandlerRegistry()
  reg.register("test.node", "test node", async (input: Record<string, unknown>) => {
    if (input.fail === true) throw new Error("intentional failure")
    const output: Record<string, unknown> = { content: input.value ?? "ok" }
    if (typeof input.acceptance === "string") {
      output["metadata"] = { acceptance: input.acceptance }
    }
    return output
  })
  reg.register("test.planner", "planner stub", async (input: Record<string, unknown>) => {
    if (input.fail === true) throw new Error("planner failed")
    return { content: "plan", metadata: { acceptance: input.acceptance ?? "not_required" } }
  })
  return reg
}

function node(id: string, handler: string, input: Record<string, unknown>, dependsOn: WorkflowSpec["nodes"][number]["dependsOn"] = []): WorkflowSpec["nodes"][number] {
  return { id, handler, input, dependsOn }
}

function spec(schemaVersion: "0.1" | "0.2", nodes: WorkflowSpec["nodes"]): WorkflowSpec {
  return { schemaVersion, specId: `m1-${Math.random().toString(16).slice(2, 8)}`, nodes }
}

const resultOf = (run: { results: WorkflowNodeResult[] }, id: string): WorkflowNodeResult =>
  run.results.find(r => r.nodeId === id)!

describe("dependency policy (unit)", () => {
  test("legacy schema normalizes every dependency to terminal", () => {
    const deps = normalizeDependencies(["a", { nodeId: "b", when: "accepted" }], "0.1")
    expect(deps).toEqual([{ nodeId: "a", when: "terminal" }, { nodeId: "b", when: "terminal" }])
  })

  test("0.2 keeps conditional whens and string defaults to terminal", () => {
    const deps = normalizeDependencies(["a", { nodeId: "b", when: "accepted" }], "0.2")
    expect(deps).toEqual([{ nodeId: "a", when: "terminal" }, { nodeId: "b", when: "accepted" }])
  })

  test("duplicate dependencies collapse", () => {
    expect(normalizeDependencies(["a", "a", { nodeId: "a", when: "succeeded" }], "0.2")).toHaveLength(1)
  })

  test("when conditions evaluate against results", () => {
    const done: WorkflowNodeResult = { nodeId: "p", status: "done", output: { content: "x" }, startedAt: 0, finishedAt: 1, durationMs: 1 }
    const failed: WorkflowNodeResult = { ...done, status: "failed", output: null, error: "e" }
    const accepted: WorkflowNodeResult = { ...done, output: { content: "x", metadata: { acceptance: "accepted" } } }
    const rejected: WorkflowNodeResult = { ...done, output: { content: "x", metadata: { acceptance: "rejected" } } }
    const blocked: WorkflowNodeResult = { ...done, status: "blocked", output: null, error: "b" }

    expect(dependencySatisfied({ nodeId: "p", when: "terminal" }, done)).toBe("satisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "succeeded" }, done)).toBe("satisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "succeeded" }, failed)).toBe("unsatisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "failed" }, failed)).toBe("satisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "failed" }, done)).toBe("unsatisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "accepted" }, accepted)).toBe("satisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "accepted" }, done)).toBe("unsatisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "accepted" }, rejected)).toBe("unsatisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "rejected" }, rejected)).toBe("satisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "blocked" }, blocked)).toBe("satisfied")
    expect(dependencySatisfied({ nodeId: "p", when: "succeeded" }, undefined)).toBe("pending")
  })

  test("evaluateReadiness: pending / executable / blocked", () => {
    const plan = node("planner", "test.planner", {})
    const results = new Map<string, WorkflowNodeResult>()
    expect(evaluateReadiness(plan, [{ nodeId: "x", when: "succeeded" }], results).verdict).toBe("pending")
    results.set("x", { nodeId: "x", status: "done", output: null, startedAt: 0, finishedAt: 1, durationMs: 1 })
    expect(evaluateReadiness(plan, [{ nodeId: "x", when: "succeeded" }], results).verdict).toBe("executable")
    expect(evaluateReadiness(plan, [{ nodeId: "x", when: "accepted" }], results).verdict).toBe("blocked")
  })
})

describe("scheduler conditional dependencies (0.2)", () => {
  test("planner failed → coder does not run (succeeded condition)", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("planner", "test.planner", { fail: true }),
      node("coder", "test.node", { value: "code" }, [{ nodeId: "planner", when: "succeeded" }]),
    ]), reg)
    expect(resultOf(run, "planner").status).toBe("failed")
    expect(resultOf(run, "coder").status).toBe("blocked")
    expect(resultOf(run, "coder").error).toContain("planner:succeeded")
  })

  test("planner succeeded but not accepted → coder does not run (accepted condition)", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("planner", "test.planner", { acceptance: "not_required" }),
      node("coder", "test.node", { value: "code" }, [{ nodeId: "planner", when: "accepted" }]),
    ]), reg)
    expect(resultOf(run, "planner").status).toBe("done")
    expect(resultOf(run, "coder").status).toBe("blocked")
  })

  test("planner accepted → coder executes", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("planner", "test.planner", { acceptance: "accepted" }),
      node("coder", "test.node", { value: "code" }, [{ nodeId: "planner", when: "accepted" }]),
    ]), reg)
    expect(resultOf(run, "planner").status).toBe("done")
    expect(resultOf(run, "coder").status).toBe("done")
  })

  test("coder failed → repair node runs (failed condition)", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("coder", "test.node", { fail: true }),
      node("repair", "test.node", { value: "fixed" }, [{ nodeId: "coder", when: "failed" }]),
    ]), reg)
    expect(resultOf(run, "coder").status).toBe("failed")
    expect(resultOf(run, "repair").status).toBe("done")
  })

  test("coder succeeded → failure-handler does not run", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("coder", "test.node", { value: "ok" }),
      node("failure-handler", "test.node", { value: "h" }, [{ nodeId: "coder", when: "failed" }]),
    ]), reg)
    expect(resultOf(run, "coder").status).toBe("done")
    expect(resultOf(run, "failure-handler").status).toBe("blocked")
  })

  test("rejected upstream blocks downstream (rejected condition)", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("planner", "test.planner", { acceptance: "rejected" }),
      node("coder", "test.node", { value: "code" }, [{ nodeId: "planner", when: "accepted" }]),
    ]), reg)
    expect(resultOf(run, "coder").status).toBe("blocked")
  })

  test("blocked upstream satisfies a blocked condition", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("planner", "test.planner", { fail: true }),
      node("coder", "test.node", { value: "c" }, [{ nodeId: "planner", when: "succeeded" }]),
      node("escalate", "test.node", { value: "human" }, [{ nodeId: "coder", when: "blocked" }]),
    ]), reg)
    expect(resultOf(run, "coder").status).toBe("blocked")
    expect(resultOf(run, "escalate").status).toBe("done")
  })

  test("no deadlock when everything is blocked", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.2", [
      node("planner", "test.planner", { fail: true }),
      node("coder", "test.node", { value: "c" }, [{ nodeId: "planner", when: "accepted" }]),
      node("verify", "test.node", { value: "v" }, [{ nodeId: "coder", when: "accepted" }]),
    ]), reg)
    expect(run.results.every(r => r.status === "failed" || r.status === "blocked")).toBe(true)
  })
})

describe("legacy 0.1 compatibility", () => {
  test("terminal semantics: failed upstream still lets downstream run", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.1", [
      node("planner", "test.planner", { fail: true }),
      node("coder", "test.node", { value: "code" }, ["planner"]),
    ]), reg)
    expect(resultOf(run, "planner").status).toBe("failed")
    expect(resultOf(run, "coder").status).toBe("done")
  })

  test("legacy specs with no deps behave identically", async () => {
    const reg = registry()
    const run = await runScheduler(spec("0.1", [
      node("a", "test.node", { value: "1" }),
      node("b", "test.node", { value: "2" }, ["a"]),
    ]), reg)
    expect(run.results.every(r => r.status === "done")).toBe(true)
  })

  test("checkpoint restore recomputes dependency conditions consistently", async () => {
    const reg = registry()
    const checkpointDir = resolve("tmp-m1-ckpt")
    rmSync(checkpointDir, { recursive: true, force: true })
    mkdirSync(checkpointDir, { recursive: true })
    try {
      // First run writes a checkpoint including the failed planner.
      const first = await runScheduler(spec("0.2", [
        node("planner", "test.planner", { fail: true }),
        node("coder", "test.node", { value: "c" }, [{ nodeId: "planner", when: "succeeded" }]),
      ]), reg, { checkpointDir })
      expect(resultOf(first, "coder").status).toBe("blocked")

      // Second run with a fresh store restores the planner failure and must
      // reach the same verdict without re-executing.
      const second = await runScheduler(spec("0.2", [
        node("planner", "test.planner", { fail: true }),
        node("coder", "test.node", { value: "c" }, [{ nodeId: "planner", when: "succeeded" }]),
      ]), reg, { checkpointDir })
      expect(resultOf(second, "planner").status).toBe("failed")
      expect(resultOf(second, "coder").status).toBe("blocked")
      expect(resultOf(second, "coder").error).toContain("planner:succeeded")
    } finally {
      rmSync(checkpointDir, { recursive: true, force: true })
    }
  })
})
