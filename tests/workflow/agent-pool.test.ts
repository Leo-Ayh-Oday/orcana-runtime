/** G7 acceptance: Agent Pool — ownership, budget, cancellation (PR-G7). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { AgentPool } from "../../src/workflow/agents/agent-pool"
import { createWorktree } from "../../src/workflow/agents/worktree"

const PROJECT = resolve("tmp-g7-pool")

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(join(PROJECT, "a.ts"), "export const a = 1\n")
  writeFileSync(join(PROJECT, "b.ts"), "export const b = 1\n")
})

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true })
})

describe("G7 agent pool", () => {
  test("registers agents with disjoint ownership", () => {
    const pool = new AgentPool()
    const a = pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a" })
    expect(a.ok).toBe(true)
    const b = pool.register({ id: "a2", ownerFiles: ["b.ts"], worktree: "/tmp/wt-b" })
    expect(b.ok).toBe(true)
    expect(pool.size()).toBe(2)
    expect(pool.ownerOf("a.ts")).toBe("a1")
    expect(pool.canWrite("a1", "a.ts")).toBe(true)
    expect(pool.canWrite("a2", "a.ts")).toBe(false)
  })

  test("overlapping ownership is rejected with violations", () => {
    const pool = new AgentPool()
    expect(pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a" }).ok).toBe(true)
    const clash = pool.register({ id: "a2", ownerFiles: ["a.ts"], worktree: "/tmp/wt-b" })
    expect(clash.ok).toBe(false)
    expect(clash.violations![0]!.file).toBe("a.ts")
    expect(clash.violations![0]!.alreadyOwnedBy).toBe("a1")
    expect(pool.size()).toBe(1)
  })

  test("cancellation fails pending agents fast", () => {
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a" })
    expect(pool.isCancelled("a1")).toBe(false)
    expect(pool.cancel("a1")).toBe(true)
    expect(pool.isCancelled("a1")).toBe(true)
    expect(pool.cancel("nope")).toBe(false)
  })

  test("worktree creation isolates writes (snapshot mode)", () => {
    const wt = createWorktree(PROJECT, "agent-x", ["a.ts"])
    expect(wt.mode).toBe("snapshot")
    expect(existsSync(join(wt.root, "a.ts"))).toBe(true)
    // Writes land in the worktree, not the project.
    writeFileSync(join(wt.root, "a.ts"), "export const a = 999\n")
    const projectContent = require("node:fs").readFileSync(join(PROJECT, "a.ts"), "utf-8")
    expect(projectContent).toContain("a = 1")
    expect(require("node:fs").readFileSync(join(wt.root, "a.ts"), "utf-8")).toContain("a = 999")
    wt.dispose()
    expect(existsSync(wt.root)).toBe(false)
  })

  test("per-agent budget caps writes and nodes independently", () => {
    const pool = new AgentPool()
    const { agent } = pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a", budget: { maxWrites: 2, maxNodes: 3 } })
    expect(agent!.budget.chargeNode()).toBe("ok")
    expect(agent!.budget.chargeNode()).toBe("ok")
    expect(agent!.budget.chargeNode()).toBe("ok")
    expect(agent!.budget.chargeNode()).toBe("nodes_exhausted")
    expect(agent!.budget.chargeWrite()).toBe("ok")
    expect(agent!.budget.chargeWrite()).toBe("ok")
    expect(agent!.budget.chargeWrite()).toBe("writes_exhausted")
    expect(agent!.budget.exhausted()).toBe(true)
  })
})
