import { describe, expect, test } from "bun:test"
import { HookEvent, HookSystem } from "../src/hooks"
import { runToolAfterHook } from "../src/agent/round/pre-loop"

describe("HookSystem output semantics", () => {
  test("chains PreToolUse parameter replacements through later hooks", async () => {
    const hooks = new HookSystem()
    const seen: unknown[] = []

    hooks.on(HookEvent.PreToolUse, (input) => {
      seen.push(input.params.path)
      return { replace: { ...input.params, path: "src/rewritten.ts" }, source: "hooks:first" }
    })
    hooks.on(HookEvent.PreToolUse, (input) => {
      seen.push(input.params.path)
      return { replace: { ...input.params, confirm: true }, source: "hooks:second" }
    })

    const result = await hooks.runBefore("edit_file", { path: "src/original.ts" })

    expect(result.blocked).toBe(false)
    expect(result.replaceParams).toEqual({ path: "src/rewritten.ts", confirm: true })
    expect(seen).toEqual(["src/original.ts", "src/rewritten.ts"])
    expect(result.trace).toEqual(["replace by hooks:first", "replace by hooks:second"])
  })

  test("chains PostToolUse result replacements through later hooks", async () => {
    const hooks = new HookSystem()
    const seen: string[] = []

    hooks.on(HookEvent.PostToolUse, (input) => {
      seen.push(input.result.content)
      return { result: { success: true, content: "sanitized" }, source: "hooks:sanitize" }
    })
    hooks.on(HookEvent.PostToolUse, (input) => {
      seen.push(input.result.content)
      return { result: { success: true, content: `${input.result.content} + audited` }, source: "hooks:audit" }
    })

    const result = await hooks.runAfter("read_file", {}, { success: true, content: "raw secret" })

    expect(result.blocked).toBe(false)
    expect(result.replaceResult).toEqual({ success: true, content: "sanitized + audited" })
    expect(seen).toEqual(["raw secret", "sanitized"])
    expect(result.trace).toEqual(["replace_result by hooks:sanitize", "replace_result by hooks:audit"])
  })

  test("PreToolUse handler exceptions fail closed and preserve earlier warnings", async () => {
    const hooks = new HookSystem()
    hooks.on(HookEvent.PreToolUse, () => ({ warn: "first warning", source: "hooks:first" }))
    hooks.on(HookEvent.PreToolUse, () => {
      throw new Error("policy unavailable")
    })
    hooks.on(HookEvent.PreToolUse, () => ({ replace: { path: "should-not-run.ts" }, source: "hooks:late" }))

    const result = await hooks.runBefore("edit_file", { path: "src/a.ts" })

    expect(result.blocked).toBe(true)
    expect(result.replaceParams).toBeUndefined()
    expect(result.warnings).toEqual(["first warning", "Hook anonymous failed: policy unavailable"])
    expect(result.trace).toEqual(["warn by hooks:first", "error by anonymous"])
  })

  test("PostToolUse handler exceptions fail closed with latest replacement context", async () => {
    const hooks = new HookSystem()
    hooks.on(HookEvent.PostToolUse, () => ({
      result: { success: true, content: "sanitized" },
      source: "hooks:sanitize",
    }))
    hooks.on(HookEvent.PostToolUse, (input) => {
      expect(input.result.content).toBe("sanitized")
      throw new Error("audit failed")
    })

    const result = await hooks.runAfter("read_file", {}, { success: true, content: "raw" })

    expect(result.blocked).toBe(true)
    expect(result.replaceResult).toEqual({ success: true, content: "sanitized" })
    expect(result.warnings).toEqual(["Hook anonymous failed: audit failed"])
    expect(result.trace).toEqual(["replace_result by hooks:sanitize", "error by anonymous"])
  })

  test("SessionStart and UserPromptSubmit exceptions fail closed", async () => {
    const hooks = new HookSystem()
    hooks.on(HookEvent.SessionStart, () => {
      throw new Error("session policy failed")
    })
    hooks.on(HookEvent.UserPromptSubmit, () => {
      throw new Error("prompt policy failed")
    })

    const session = await hooks.dispatchSessionStart({
      projectRoot: process.cwd(),
      mode: "coder",
      toolNames: [],
    })
    const prompt = await hooks.dispatchPromptSubmit({ prompt: "do work", round: 1 })

    expect(session.blocked).toBe(true)
    expect(session.blockReason).toContain("session policy failed")
    expect(session.trace).toEqual(["error by anonymous"])
    expect(prompt.blocked).toBe(true)
    expect(prompt.blockReason).toContain("prompt policy failed")
    expect(prompt.trace).toEqual(["error by anonymous"])
  })

  test("Stop handler exceptions are still swallowed", async () => {
    const hooks = new HookSystem()
    let lateRan = false
    hooks.on(HookEvent.Stop, () => {
      throw new Error("cleanup failed")
    })
    hooks.on(HookEvent.Stop, () => {
      lateRan = true
      return {}
    })

    await hooks.dispatchStop({ reason: "completed", totalRounds: 1, sessionDurationMs: 10 })

    expect(lateRan).toBe(true)
  })

  test("execution helper turns PostToolUse blocks into failed tool results", async () => {
    const hooks = new HookSystem()
    hooks.on(HookEvent.PostToolUse, () => ({
      blocked: true,
      warn: "journal veto",
      source: "hooks:journal",
    }))

    const result = await runToolAfterHook(
      hooks,
      "edit_file",
      { path: "src/a.ts" },
      { success: true, content: "edited" },
    )

    expect(result.result.success).toBe(false)
    expect(result.result.content).toContain("journal veto")
    expect(result.result.metadata).toMatchObject({ blocked: true, hookBlocked: true })
    expect(result.warnings).toEqual(["journal veto"])
  })
})
