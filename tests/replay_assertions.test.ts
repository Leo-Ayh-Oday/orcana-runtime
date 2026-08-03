import { describe, expect, test } from "bun:test"
import { checkAssertions, resolvePath } from "../src/agent/replay-harness"

// H12 Tier 1 extension (§18.1): nested paths, regex, array length,
// not-exists, and set containment in the replay assertion language.

const CONTEXT = {
  plan: { nodes: [{ id: "n1", status: "done" }, { id: "n2", status: "active" }], total: 2 },
  trace: ["open", "run", "close"],
  report: "typecheck: 0 errors",
  secrets: undefined,
}

describe("resolvePath", () => {
  test("dot paths walk nested objects and arrays", () => {
    expect(resolvePath(CONTEXT, "plan.total")).toBe(2)
    expect(resolvePath(CONTEXT, "plan.nodes.0.id")).toBe("n1")
    expect(resolvePath(CONTEXT, "plan.nodes.1.status")).toBe("active")
  })

  test("missing paths resolve to undefined", () => {
    expect(resolvePath(CONTEXT, "nope")).toBeUndefined()
    expect(resolvePath(CONTEXT, "plan.nope")).toBeUndefined()
    expect(resolvePath(CONTEXT, "plan.nodes.9")).toBeUndefined()
  })
})

describe("checkAssertions extensions", () => {
  const ok = (assertion: string) => {
    const failures = checkAssertions({ domain: "context_epoch", description: "", assertions: [assertion] } as never, CONTEXT)
    expect(failures).toEqual([])
  }
  const fails = (assertion: string) => {
    const failures = checkAssertions({ domain: "context_epoch", description: "", assertions: [assertion] } as never, CONTEXT)
    expect(failures.length).toBeGreaterThan(0)
  }

  test("nested path exists / not exists", () => {
    ok("plan.nodes.0.id exists")
    ok("secrets not exists")
    fails("plan.nope exists")
    fails("plan.nodes.0.id not exists")
  })

  test("regex matching", () => {
    ok("report matches /typecheck: \\d+ errors/")
    ok("report matches /^typecheck/")
    fails("report matches /tests: \\d+ passed/")
  })

  test("array length", () => {
    ok("trace length == 3")
    ok("plan.nodes length == 2")
    ok("trace length >= 2")
    ok("trace length > 2")
    fails("trace length == 4")
    fails("trace length >= 4")
  })

  test("set containment", () => {
    ok("trace contains-set open,close")
    ok("trace contains-set run")
    fails("trace contains-set open,missing")
  })

  test("existing ops still work", () => {
    ok("plan.total equals 2")
    ok("plan.total > 1")
    ok("plan.total >= 2")
    ok("report contains typecheck")
  })
})
