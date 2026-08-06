/** Tests for revisePlan — stuck detection that pushes agent back to planning. */
import { describe, expect, test } from "bun:test"
import { revisePlan, createTaskTracker, markPlanAccepted } from "../src/agent/task-tracker"
import type { TaskTracker } from "../src/agent/task-tracker"

function trackerInBuilding(): TaskTracker {
  const t = createTaskTracker("build a full-stack app with tests", "long_task")!
  // Mark plan accepted → plan step done, first non-plan step running, phase → building
  markPlanAccepted(t)
  return t
}

describe("revisePlan", () => {
  test("marks running step as failed with reason evidence", () => {
    const t = trackerInBuilding()
    const running = t.steps.find(s => s.status === "running")!
    expect(running).toBeDefined()

    revisePlan(t, "连续 3 次工具错误")

    expect(running.status).toBe("failed")
    expect(running.evidence).toContain("3 次")
  })

  test("marks running step failed and pending steps cancelled", () => {
    const t = trackerInBuilding()
    // Ensure we have at least 2 pending steps after the running one
    const remaining = t.steps.filter(s => s.status === "pending")
    if (remaining.length < 2) {
      t.steps.push({ id: "extra1", title: "测试", status: "pending" })
      t.steps.push({ id: "extra2", title: "构建", status: "pending" })
    }
    const runningId = t.steps.find(s => s.status === "running")!.id
    const pendingIds = t.steps.filter(s => s.status === "pending").map(s => s.id)

    revisePlan(t, "stuck")

    expect(t.steps.find(s => s.id === runningId)!.status).toBe("failed")
    for (const pid of pendingIds) {
      expect(t.steps.find(s => s.id === pid)!.status).toBe("cancelled")
    }
  })

  test("resets phase to planning", () => {
    const t = trackerInBuilding()
    expect(t.phase).toBe("building")

    revisePlan(t, "步骤未推进")

    expect(t.phase).toBe("planning")
  })

  test("adds a 'revise' step at the front of steps array", () => {
    const t = trackerInBuilding()
    const before = t.steps.length

    revisePlan(t, "stuck")

    expect(t.steps[0]!.id).toBe("revise")
    expect(t.steps[0]!.status).toBe("running")
    expect(t.steps.length).toBe(before + 1)
  })

  test("reuses existing 'revise' step instead of adding duplicate", () => {
    const t = trackerInBuilding()
    revisePlan(t, "stuck first time")
    const afterFirst = t.steps.length

    // Reset phase so it can be re-triggered
    t.phase = "building"
    t.steps[1]!.status = "running"

    revisePlan(t, "stuck second time")

    expect(t.steps.length).toBe(afterFirst) // no new step
    expect(t.steps[0]!.id).toBe("revise")
    expect(t.steps[0]!.status).toBe("running")
  })

  test("returns a system-reminder guidance message", () => {
    const t = trackerInBuilding()

    const msg = revisePlan(t, "连续 4 次工具错误")

    expect(msg).toContain("<system-reminder>")
    expect(msg).toContain("方案修正")
    expect(msg).toContain("4 次")
    expect(msg).toContain("重新规划")
    expect(msg).toContain("最小可交付单元")
    expect(msg).toContain("</system-reminder>")
  })

  test("includes failed step title in guidance", () => {
    const t = trackerInBuilding()
    const running = t.steps.find(s => s.status === "running")!

    const msg = revisePlan(t, "stuck")

    expect(msg).toContain(running.title)
  })

  test("evidences cuts reason at 120 characters", () => {
    const t = trackerInBuilding()
    const longReason = "x".repeat(200)

    revisePlan(t, longReason)

    const running = t.steps.find(s => s.status === "failed")!
    expect(running.evidence?.length).toBeLessThanOrEqual(120)
  })

  test("handles tracker with no running step gracefully", () => {
    const t = createTaskTracker("analyze the codebase", "long_task")!
    // Mark all steps as done (simulate that all completed but something went wrong)
    for (const s of t.steps) s.status = "done"
    t.phase = "building"
    // No step is running

    const msg = revisePlan(t, "nothing is running")

    expect(msg).toContain("方案修正")
    expect(msg).toContain("未知") // fallback step name
    expect(t.phase as string).toBe("planning")
  })

  test("does not touch done steps beyond marking pending as cancelled", () => {
    const t = trackerInBuilding()
    t.steps[0]!.status = "done"  // step 0 is done, not running
    // Ensure there are pending steps
    t.steps.push({ id: "pend1", title: "pending step", status: "pending" })
    t.steps.push({ id: "pend2", title: "another pending", status: "pending" })

    revisePlan(t, "stuck")

    expect(t.steps.find(s => s.id === "plan")!.status).toBe("done")  // done stays done
    expect(t.steps.find(s => s.id === "pend1")!.status).toBe("cancelled")
    expect(t.steps.find(s => s.id === "pend2")!.status).toBe("cancelled")
  })

  test("integration: full revise-plan cycle", () => {
    // 1. Create tracker in planning
    const t = createTaskTracker("build a blog with React + Vite", "long_task")!
    expect(t.phase).toBe("planning")

    // 2. Accept plan → transitions to building, marks plan done, first pending running
    markPlanAccepted(t)
    expect(t.phase).toBe("building")

    // 3. Stuck — revise
    const msg1 = revisePlan(t, "consecutive errors limit reached")
    expect(t.phase).toBe("planning")
    expect(msg1).toContain("方案修正")
    expect(t.steps[0]!.id).toBe("revise")

    // 4. Re-plan done, mark accepted, move back to building
    markPlanAccepted(t)
    expect(t.phase).toBe("building")

    // 5. Stuck again — revise again
    const msg2 = revisePlan(t, "still stuck after re-plan")
    expect(t.phase).toBe("planning")
    expect(t.steps.filter(s => s.id === "revise").length).toBe(1) // no duplicate
    expect(msg2).toContain("方案修正")
  })
})

describe("createTaskTracker", () => {
  test("creates tracker with planning phase and default steps", () => {
    const t = createTaskTracker("build a blog", "long_task")!
    expect(t).not.toBeNull()
    expect(t.goal).toContain("build a blog")
    expect(t.intent).toBe("long_task")
    expect(t.phase).toBe("planning")
    expect(t.steps.length).toBeGreaterThanOrEqual(2)
  })

  test("narrow_edit returns null — no tracker needed for simple edits", () => {
    const t = createTaskTracker("fix the login bug", "narrow_edit")
    expect(t).toBeNull()
  })

  test("readonly returns null — no tracker needed for discussion", () => {
    const t = createTaskTracker("explain the architecture", "readonly")
    expect(t).toBeNull()
  })
})

describe("markPlanAccepted", () => {
  test("marks plan step as done, first pending as running, transitions to building", () => {
    const t = createTaskTracker("build a full-stack blog with tests", "long_task")!
    markPlanAccepted(t)
    expect(t.phase).toBe("building")
    expect(t.steps.find(s => s.id === "plan")!.status).toBe("done")
    // First non-plan step should be running
    const running = t.steps.find(s => s.status === "running" && s.id !== "plan")
    expect(running).toBeDefined()
  })
})
