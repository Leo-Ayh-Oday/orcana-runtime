/**
 * Tests for UsageImpact Classifier (PR 4 — Layer 3 of Ripple Engine 2.0).
 */

import { describe, expect, test } from "bun:test"
import {
  classifyOneCaller,
  classifyCallers,
  formatUsageSummary,
  urgencyLevel,
  type UsageImpact,
  type UsageKind,
} from "../src/ripple/usage-classifier"
import type { RippleCaller } from "../src/ripple/types"
import type { ApiChange } from "../src/ripple/api-diff"

// ── Helpers ────────────────────────────────────────────────────────

function caller(overrides: Partial<RippleCaller>): RippleCaller {
  return {
    file: "src/main.ts",
    line: 10,
    symbol: "loadUser",
    text: "const user = await loadUser(id)",
    ...overrides,
  }
}

function change(
  kind: ApiChange["kind"],
  symbol = "loadUser",
  severity: ApiChange["severity"] = "block",
): ApiChange {
  return { kind, symbol, severity, detail: `${kind} on ${symbol}` }
}

// ── classifyOneCaller — usage pattern detection ────────────────────

describe("classifyOneCaller — usage detection", () => {
  test("detects direct function call: foo(args)", () => {
    const c = caller({ text: "const user = loadUser(id)" })
    const result = classifyOneCaller(c, "loadUser")
    expect(result.usage).toBe("call_expr")
    expect(result.confidence).toBeGreaterThanOrEqual(0.9)
  })

  test("detects method call: obj.foo(args)", () => {
    const c = caller({ text: "const result = api.loadUser(id)", symbol: "loadUser" })
    const result = classifyOneCaller(c, "loadUser")
    expect(result.usage).toBe("method_call")
  })

  test("detects new instance: new Foo()", () => {
    const c = caller({ text: "const store = new UserStore(cfg)", symbol: "UserStore" })
    const result = classifyOneCaller(c, "UserStore")
    expect(result.usage).toBe("new_instance")
  })

  test("detects type reference: : Foo", () => {
    const c = caller({ text: "function render(user: User): string", symbol: "User" })
    const result = classifyOneCaller(c, "User")
    expect(result.usage).toBe("type_ref")
  })

  test("detects type reference: as Foo", () => {
    const c = caller({ text: "  const x = data as User", symbol: "User" })
    const result = classifyOneCaller(c, "User")
    expect(result.usage).toBe("type_ref")
  })

  test("detects extends clause", () => {
    const c = caller({ text: "class Admin extends User {", symbol: "User" })
    const result = classifyOneCaller(c, "User")
    expect(result.usage).toBe("extends_clause")
  })

  test("detects implements clause", () => {
    const c = caller({ text: "class Auth implements IAuth {", symbol: "IAuth" })
    const result = classifyOneCaller(c, "IAuth")
    expect(result.usage).toBe("implements_clause")
  })

  test("detects typeof query", () => {
    const c = caller({ text: "type Check = typeof validator", symbol: "validator" })
    const result = classifyOneCaller(c, "validator")
    expect(result.usage).toBe("typeof_query")
  })

  test("detects generic argument", () => {
    const c = caller({ text: "const list: Array<User> = []", symbol: "User" })
    const result = classifyOneCaller(c, "User")
    expect(result.usage).toBe("generic_arg")
  })

  test("detects destructure: { foo }", () => {
    const c = caller({ text: "const { loadUser } = api", symbol: "loadUser" })
    const result = classifyOneCaller(c, "loadUser")
    expect(result.usage).toBe("destructure")
  })

  test("detects JSX element: <Foo />", () => {
    const c = caller({ text: "return <UserCard name={n} />", symbol: "UserCard" })
    const result = classifyOneCaller(c, "UserCard")
    expect(result.usage).toBe("jsx_element")
  })

  test("detects JSX attribute: prop={foo}", () => {
    const c = caller({ text: "  <Card title={formatTitle(name)} />", symbol: "formatTitle" })
    const result = classifyOneCaller(c, "formatTitle")
    expect(result.usage).toBe("jsx_attr")
  })

  test("detects re-export: export { foo }", () => {
    const c = caller({ text: "export { loadUser } from './api'", symbol: "loadUser" })
    const result = classifyOneCaller(c, "loadUser")
    expect(result.usage).toBe("re_export")
  })

  test("detects spread: ...foo", () => {
    const c = caller({ text: "const merged = { ...defaults }", symbol: "defaults" })
    const result = classifyOneCaller(c, "defaults")
    expect(result.usage).toBe("spread_expr")
  })

  test("falls back to plain_ref for simple identifier", () => {
    const c = caller({ text: "console.log(api)", symbol: "api" })
    const result = classifyOneCaller(c, "api")
    expect(result.usage).toBe("plain_ref")
  })
})

// ── classifyOneCaller — detection order priority ───────────────────

describe("classifyOneCaller — priority order", () => {
  test("JSX element beats call_expr", () => {
    // `<Symbol>` is a JSX element, not a call even if followed by paren-like chars
    const c = caller({ text: "return <UserCard name='a' />", symbol: "UserCard" })
    const result = classifyOneCaller(c, "UserCard")
    expect(result.usage).toBe("jsx_element")
  })

  test("extends beats type_ref", () => {
    const c = caller({ text: "class Admin extends User", symbol: "User" })
    const result = classifyOneCaller(c, "User")
    expect(result.usage).toBe("extends_clause")
  })

  test("new expression beats call_expr", () => {
    const c = caller({ text: "  return new UserStore(cfg)", symbol: "UserStore" })
    const result = classifyOneCaller(c, "UserStore")
    expect(result.usage).toBe("new_instance")
  })
})

// ── classifyCallers — batch with ApiChange ─────────────────────────

describe("classifyCallers — batch classification", () => {
  test("returns empty array for empty callers", () => {
    expect(classifyCallers([], [])).toEqual([])
  })

  test("classifies each caller and assigns requiredAction", () => {
    const callers: RippleCaller[] = [
      caller({ file: "src/a.ts", line: 5, text: "await loadUser(id)", symbol: "loadUser" }),
      caller({ file: "src/b.ts", line: 12, text: "const x: User = data", symbol: "User" }),
    ]
    const changes: ApiChange[] = [
      change("async_boundary_changed", "loadUser"),
      change("export_removed", "User"),
    ]

    const impacts = classifyCallers(callers, changes)
    expect(impacts).toHaveLength(2)

    const callImpact = impacts.find(i => i.caller.symbol === "loadUser")!
    expect(callImpact.usage).toBe("call_expr")
    expect(callImpact.requiredAction).toContain("await")

    const typeImpact = impacts.find(i => i.caller.symbol === "User")!
    expect(typeImpact.usage).toBe("type_ref")
    expect(typeImpact.requiredAction).toContain("migrate")
  })

  test("callers without matching changes get plain_ref for ambiguous references", () => {
    const callers = [caller({ text: "log(api)", symbol: "api" })]
    const changes: ApiChange[] = []
    const impacts = classifyCallers(callers, changes)
    expect(impacts).toHaveLength(1)
    // log(api) — symbol is passed as argument, not called directly
    expect(impacts[0]!.usage).toBe("plain_ref")
    expect(impacts[0]!.requiredAction).toContain("verify")
  })

  test("export_added produces no-action-required", () => {
    const callers = [caller({ text: "newApi()", symbol: "newApi" })]
    const changes = [change("export_added", "newApi", "info")]
    const impacts = classifyCallers(callers, changes)
    expect(impacts).toHaveLength(1)
    expect(impacts[0]!.requiredAction).toBe("no action required (new API)")
  })

  test("multi-change symbol uses highest-priority change for action", () => {
    const callers = [caller({ text: "loadUser()", symbol: "loadUser" })]
    // async_boundary beats signature_changed in priority
    const changes = [
      change("signature_changed", "loadUser"),
      change("async_boundary_changed", "loadUser"),
    ]
    const impacts = classifyCallers(callers, changes)
    expect(impacts).toHaveLength(1)
    expect(impacts[0]!.requiredAction).toContain("await")
  })
})

// ── formatUsageSummary ─────────────────────────────────────────────

describe("formatUsageSummary", () => {
  test("returns empty string for empty impacts", () => {
    expect(formatUsageSummary([])).toBe("")
  })

  test("groups by action and lists files", () => {
    const impacts: UsageImpact[] = [
      { caller: caller({ file: "src/a.ts", line: 5 }), usage: "call_expr", requiredAction: "add await to this call", confidence: 1.0 },
      { caller: caller({ file: "src/b.ts", line: 10 }), usage: "call_expr", requiredAction: "add await to this call", confidence: 1.0 },
      { caller: caller({ file: "src/c.ts", line: 15 }), usage: "type_ref", requiredAction: "update type annotation for new return type", confidence: 0.85 },
    ]
    const summary = formatUsageSummary(impacts)
    expect(summary).toContain("add await to this call")
    expect(summary).toContain("src/a.ts:5")
    expect(summary).toContain("src/b.ts:10")
    expect(summary).toContain("update type annotation")
  })

  test("truncates long file lists with +N more", () => {
    const impacts: UsageImpact[] = Array.from({ length: 5 }, (_, i) => ({
      caller: caller({ file: `src/f${i}.ts`, line: i + 1 }),
      usage: "call_expr" as UsageKind,
      requiredAction: "add await",
      confidence: 1.0,
    }))
    const summary = formatUsageSummary(impacts)
    expect(summary).toContain("+2 more")
  })
})

// ── urgencyLevel ───────────────────────────────────────────────────

describe("urgencyLevel", () => {
  test("returns info for empty impacts", () => {
    expect(urgencyLevel([])).toBe("info")
  })

  test("returns urgent when any action contains await", () => {
    const impacts: UsageImpact[] = [
      { caller: caller({}), usage: "call_expr", requiredAction: "add await to this call", confidence: 1.0 },
    ]
    expect(urgencyLevel(impacts)).toBe("urgent")
  })

  test("returns urgent when any action contains remove", () => {
    const impacts: UsageImpact[] = [
      { caller: caller({}), usage: "call_expr", requiredAction: "remove or migrate reference to removed symbol", confidence: 1.0 },
    ]
    expect(urgencyLevel(impacts)).toBe("urgent")
  })

  test("returns actionable for signature/type changes", () => {
    const impacts: UsageImpact[] = [
      { caller: caller({}), usage: "call_expr", requiredAction: "update arguments to match new signature", confidence: 1.0 },
    ]
    expect(urgencyLevel(impacts)).toBe("actionable")
  })

  test("returns info when all actions are no-action", () => {
    const impacts: UsageImpact[] = [
      { caller: caller({}), usage: "plain_ref", requiredAction: "no action required (new API)", confidence: 0.6 },
    ]
    expect(urgencyLevel(impacts)).toBe("info")
  })

  test("urgent beats actionable when mixed", () => {
    const impacts: UsageImpact[] = [
      { caller: caller({}), usage: "call_expr", requiredAction: "update arguments to match new signature", confidence: 1.0 },
      { caller: caller({}), usage: "call_expr", requiredAction: "add await to this call", confidence: 1.0 },
    ]
    expect(urgencyLevel(impacts)).toBe("urgent")
  })
})

// ── All 14 UsageKind values are reachable ──────────────────────────

describe("UsageKind coverage", () => {
  const allKinds: Array<{ kind: UsageKind; text: string; symbol: string }> = [
    { kind: "call_expr", text: "foo(args)", symbol: "foo" },
    { kind: "method_call", text: "obj.foo()", symbol: "foo" },
    { kind: "new_instance", text: "new Foo()", symbol: "Foo" },
    { kind: "type_ref", text: ": Foo", symbol: "Foo" },
    { kind: "extends_clause", text: "extends Foo {", symbol: "Foo" },
    { kind: "implements_clause", text: "implements IFoo {", symbol: "IFoo" },
    { kind: "generic_arg", text: "Array<Foo>", symbol: "Foo" },
    { kind: "typeof_query", text: "typeof foo", symbol: "foo" },
    { kind: "destructure", text: "{ foo } =", symbol: "foo" },
    { kind: "jsx_element", text: "<Foo />", symbol: "Foo" },
    { kind: "jsx_attr", text: "<div a={foo}>", symbol: "foo" },
    { kind: "re_export", text: "export { foo }", symbol: "foo" },
    { kind: "spread_expr", text: "...foo", symbol: "foo" },
    { kind: "plain_ref", text: "just foo", symbol: "foo" },
  ]

  for (const { kind, text, symbol } of allKinds) {
    test(`classifies "${text}" as ${kind}`, () => {
      const c = caller({ text, symbol })
      const result = classifyOneCaller(c, symbol)
      expect(result.usage).toBe(kind)
    })
  }
})

// ── Edge cases ─────────────────────────────────────────────────────

describe("classifyOneCaller edge cases", () => {
  test("non-exported symbol classification still works", () => {
    const c = caller({ text: "internalHelper(data)", symbol: "internalHelper" })
    const result = classifyOneCaller(c, "internalHelper")
    expect(result.usage).toBe("call_expr")
  })

  test("empty text string is plain_ref", () => {
    const c = caller({ text: "", symbol: "foo" })
    const result = classifyOneCaller(c, "foo")
    expect(result.usage).toBe("plain_ref")
    expect(result.confidence).toBeLessThan(0.7) // symbol not found in text
  })

  test("generated symbol name is plain_ref", () => {
    const c = caller({ text: "const _tmp = compute()", symbol: "compute" })
    const result = classifyOneCaller(c, "compute")
    expect(result.usage).toBe("call_expr") // compute() is a direct call
  })
})
