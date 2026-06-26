import { describe, expect, test } from "bun:test"
import {
  diffApiSurface,
  toSymbolShapes,
  changedSymbolNames,
  hasSeverity,
  type SymbolShape,
} from "../src/ripple/api-diff"

// ── Test helpers ────────────────────────────────────────────────

function sym(overrides: Partial<SymbolShape> & { name: string; kind: SymbolShape["kind"] }): SymbolShape {
  return {
    exported: true,
    header: "",
    async: false,
    returnType: "",
    fields: [],
    line: 1,
    nameStart: 0,
    nameEnd: 0,
    declStart: 0,
    declEnd: 0,
    ...overrides,
  }
}

function makeMap(shapes: SymbolShape[]): Map<string, SymbolShape> {
  const m = new Map<string, SymbolShape>()
  for (const s of shapes) m.set(s.name, s)
  return m
}

// ── Tests ───────────────────────────────────────────────────────

describe("api-diff", () => {
  // ── export_removed ──

  test("detects exported symbol removal", () => {
    const old = makeMap([sym({ name: "load", kind: "function", header: "export function load(id: string): User" })])
    const newer = makeMap([])
    const changes = diffApiSurface(old, newer)

    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe("export_removed")
    expect(changes[0]!.symbol).toBe("load")
    expect(changes[0]!.severity).toBe("block")
    expect(changes[0]!.detail).toContain("was removed")
  })

  test("non-exported symbol removal produces no change", () => {
    const old = makeMap([sym({ name: "internal", kind: "function", exported: false })])
    const newer = makeMap([])
    const changes = diffApiSurface(old, newer)

    expect(changes).toHaveLength(0)
  })

  // ── export_added ──

  test("detects exported symbol addition", () => {
    const old = makeMap([])
    const newer = makeMap([sym({ name: "newApi", kind: "function", header: "export function newApi(): void" })])
    const changes = diffApiSurface(old, newer)

    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe("export_added")
    expect(changes[0]!.symbol).toBe("newApi")
    expect(changes[0]!.severity).toBe("info")
  })

  test("non-exported addition produces no change", () => {
    const old = makeMap([])
    const newer = makeMap([sym({ name: "helper", kind: "function", exported: false })])
    const changes = diffApiSurface(old, newer)

    expect(changes).toHaveLength(0)
  })

  // ── signature_changed ──

  test("detects signature change (header differs)", () => {
    const old = makeMap([sym({ name: "add", kind: "function", header: "export function add(a: number, b: number): number" })])
    const newer = makeMap([sym({ name: "add", kind: "function", header: "export function add(a: number, b: number, c: number): number" })])
    const changes = diffApiSurface(old, newer)

    const sig = changes.find(c => c.kind === "signature_changed")
    expect(sig).toBeDefined()
    expect(sig!.symbol).toBe("add")
    expect(sig!.severity).toBe("block")
  })

  test("non-exported signature change severity is warn", () => {
    const old = makeMap([sym({ name: "helper", kind: "function", exported: false, header: "function helper(x: string): void" })])
    const newer = makeMap([sym({ name: "helper", kind: "function", exported: false, header: "function helper(x: string, y: string): void" })])
    const changes = diffApiSurface(old, newer)

    const sig = changes.find(c => c.kind === "signature_changed")
    expect(sig).toBeDefined()
    expect(sig!.severity).toBe("warn")
  })

  // ── async_boundary_changed ──

  test("detects sync → async transition", () => {
    const old = makeMap([sym({ name: "fetch", kind: "function", async: false, header: "export function fetch(): Data" })])
    const newer = makeMap([sym({ name: "fetch", kind: "function", async: true, header: "export async function fetch(): Promise<Data>" })])
    const changes = diffApiSurface(old, newer)

    const asyncChange = changes.find(c => c.kind === "async_boundary_changed")
    expect(asyncChange).toBeDefined()
    expect(asyncChange!.symbol).toBe("fetch")
    expect(asyncChange!.severity).toBe("block")
    expect(asyncChange!.detail).toContain("sync to async")
  })

  test("detects async → sync transition", () => {
    const old = makeMap([sym({ name: "fetch", kind: "function", async: true, header: "export async function fetch(): Promise<Data>" })])
    const newer = makeMap([sym({ name: "fetch", kind: "function", async: false, header: "export function fetch(): Data" })])
    const changes = diffApiSurface(old, newer)

    const asyncChange = changes.find(c => c.kind === "async_boundary_changed")
    expect(asyncChange).toBeDefined()
    expect(asyncChange!.detail).toContain("async to sync")
  })

  // ── return_type_changed ──

  test("detects return type change (co-occurs with signature change)", () => {
    const old = makeMap([sym({ name: "getUser", kind: "function", header: "export function getUser(id: number): User", returnType: "User" })])
    const newer = makeMap([sym({ name: "getUser", kind: "function", header: "export function getUser(id: number): User | null", returnType: "User | null" })])
    const changes = diffApiSurface(old, newer)

    const rt = changes.find(c => c.kind === "return_type_changed")
    expect(rt).toBeDefined()
    expect(rt!.symbol).toBe("getUser")
    expect(rt!.severity).toBe("warn")
    // Should also have signature_changed since header differs
    expect(changes.some(c => c.kind === "signature_changed")).toBe(true)
  })

  test("return type change for non-exported symbol is info", () => {
    const old = makeMap([sym({ name: "internal", kind: "function", exported: false, header: "function internal(): string", returnType: "string" })])
    const newer = makeMap([sym({ name: "internal", kind: "function", exported: false, header: "function internal(): number", returnType: "number" })])
    const changes = diffApiSurface(old, newer)

    const rt = changes.find(c => c.kind === "return_type_changed")
    expect(rt).toBeDefined()
    expect(rt!.severity).toBe("info")
  })

  // ── kind_changed ──

  test("detects kind change (function → const)", () => {
    const old = makeMap([sym({ name: "api", kind: "function", header: "export function api(): void" })])
    const newer = makeMap([sym({ name: "api", kind: "const", header: "export const api = (): void => {}" })])
    const changes = diffApiSurface(old, newer)

    const kc = changes.find(c => c.kind === "kind_changed")
    expect(kc).toBeDefined()
    expect(kc!.symbol).toBe("api")
    expect(kc!.severity).toBe("block")
    expect(kc!.detail).toContain("function to const")
  })

  test("detects kind change (interface → type)", () => {
    const old = makeMap([sym({ name: "Config", kind: "interface" })])
    const newer = makeMap([sym({ name: "Config", kind: "type" })])
    const changes = diffApiSurface(old, newer)

    const kc = changes.find(c => c.kind === "kind_changed")
    expect(kc).toBeDefined()
  })

  // ── interface_field_removed / added ──

  test("detects interface field removal", () => {
    const old = makeMap([sym({ name: "User", kind: "interface", fields: ["id", "name", "email"] })])
    const newer = makeMap([sym({ name: "User", kind: "interface", fields: ["id", "name"] })])
    const changes = diffApiSurface(old, newer)

    const removed = changes.filter(c => c.kind === "interface_field_removed")
    expect(removed).toHaveLength(1)
    expect(removed[0]!.symbol).toBe("User.email")
    expect(removed[0]!.severity).toBe("block")
  })

  test("detects interface field addition", () => {
    const old = makeMap([sym({ name: "User", kind: "interface", fields: ["id"] })])
    const newer = makeMap([sym({ name: "User", kind: "interface", fields: ["id", "role"] })])
    const changes = diffApiSurface(old, newer)

    const added = changes.filter(c => c.kind === "interface_field_added")
    expect(added).toHaveLength(1)
    expect(added[0]!.symbol).toBe("User.role")
    expect(added[0]!.severity).toBe("info")
  })

  test("class field changes are detected (same logic as interface)", () => {
    const old = makeMap([sym({ name: "Store", kind: "class", fields: ["state", "update"] })])
    const newer = makeMap([sym({ name: "Store", kind: "class", fields: ["state"] })])
    const changes = diffApiSurface(old, newer)

    const removed = changes.filter(c => c.kind === "interface_field_removed")
    expect(removed).toHaveLength(1)
    expect(removed[0]!.symbol).toBe("Store.update")
  })

  // ── Multiple changes on one symbol ──

  test("a single symbol can produce multiple ApiChange entries", () => {
    const old = makeMap([sym({ name: "load", kind: "function", async: false, header: "export function load(id: string): User", returnType: "User" })])
    const newer = makeMap([sym({ name: "load", kind: "function", async: true, header: "export async function load(id: string): Promise<User>", returnType: "Promise<User>" })])
    const changes = diffApiSurface(old, newer)

    // Should have: async_boundary_changed + signature_changed + return_type_changed
    const kinds = changes.map(c => c.kind).sort()
    expect(kinds).toContain("async_boundary_changed")
    expect(kinds).toContain("signature_changed")
    expect(kinds).toContain("return_type_changed")
  })

  // ── Unchanged symbols produce no entries ──

  test("unchanged symbol produces no ApiChange", () => {
    const s = sym({ name: "stable", kind: "function", header: "export function stable(): void" })
    const old = makeMap([s])
    const newer = makeMap([s])
    const changes = diffApiSurface(old, newer)

    expect(changes).toHaveLength(0)
  })

  // ── Simultaneous add + remove (rename detection baseline) ──

  test("handles rename-like pattern (old removed, new added)", () => {
    const old = makeMap([sym({ name: "oldLoader", kind: "function", header: "export function oldLoader(): Data" })])
    const newer = makeMap([sym({ name: "newLoader", kind: "function", header: "export function newLoader(): Data" })])
    const changes = diffApiSurface(old, newer)

    expect(changes).toHaveLength(2)
    expect(changes.some(c => c.kind === "export_removed" && c.symbol === "oldLoader")).toBe(true)
    expect(changes.some(c => c.kind === "export_added" && c.symbol === "newLoader")).toBe(true)
  })

  // ── toSymbolShapes ──

  test("toSymbolShapes converts internal SymbolInfo to SymbolShape", () => {
    const internalSymbols = new Map<string, {
      name: string; kind: "function"; exported: boolean; header: string; async: boolean;
      returnType: string; fields: Set<string>; line: number;
      nameStart: number; nameEnd: number; declStart: number; declEnd: number;
    }>()
    internalSymbols.set("foo", {
      name: "foo", kind: "function", exported: true, header: "export function foo(): void",
      async: false, returnType: "void", fields: new Set(["bar"]), line: 5,
      nameStart: 100, nameEnd: 103, declStart: 93, declEnd: 200,
    })

    const shapes = toSymbolShapes(internalSymbols)
    expect(shapes.size).toBe(1)
    expect(shapes.get("foo")!.name).toBe("foo")
    expect(shapes.get("foo")!.fields).toEqual(["bar"])
    expect(shapes.get("foo")!.nameStart).toBe(100)
    expect(shapes.get("foo")!.nameEnd).toBe(103)
    expect(shapes.get("foo")!.declStart).toBe(93)
    expect(shapes.get("foo")!.declEnd).toBe(200)
  })

  // ── changedSymbolNames ──

  test("changedSymbolNames extracts unique names", () => {
    const changes = [
      { kind: "signature_changed" as const, symbol: "foo", severity: "block" as const, detail: "" },
      { kind: "return_type_changed" as const, symbol: "foo", severity: "warn" as const, detail: "" },
      { kind: "export_removed" as const, symbol: "bar", severity: "block" as const, detail: "" },
    ]
    const names = changedSymbolNames(changes)
    expect(names).toHaveLength(2)
    expect(names).toContain("foo")
    expect(names).toContain("bar")
  })

  test("changedSymbolNames normalizes field-level changes to the owning symbol", () => {
    const changes = [
      { kind: "interface_field_removed" as const, symbol: "User.email", severity: "block" as const, detail: "" },
      { kind: "interface_field_added" as const, symbol: "User.role", severity: "info" as const, detail: "" },
    ]

    expect(changedSymbolNames(changes)).toEqual(["User"])
  })

  test("changedSymbolNames returns empty for no changes", () => {
    expect(changedSymbolNames([])).toEqual([])
  })

  // ── hasSeverity ──

  test("hasSeverity detects block-level changes", () => {
    const changes = [
      { kind: "export_added" as const, symbol: "x", severity: "info" as const, detail: "" },
      { kind: "signature_changed" as const, symbol: "y", severity: "block" as const, detail: "" },
    ]
    expect(hasSeverity(changes, "block")).toBe(true)
    expect(hasSeverity(changes, "warn")).toBe(true) // block ≥ warn
    expect(hasSeverity(changes, "info")).toBe(true)
  })

  test("hasSeverity returns false for empty changes", () => {
    expect(hasSeverity([], "block")).toBe(false)
    expect(hasSeverity([], "warn")).toBe(false)
    expect(hasSeverity([], "info")).toBe(false)
  })

  test("hasSeverity warn matches warn + block", () => {
    const changes = [
      { kind: "return_type_changed" as const, symbol: "x", severity: "warn" as const, detail: "" },
    ]
    expect(hasSeverity(changes, "block")).toBe(false)
    expect(hasSeverity(changes, "warn")).toBe(true)
  })

  // ── Verify exported shapes carry old/new references ──

  test("ApiChange carries oldShape for removals", () => {
    const old = makeMap([sym({ name: "gone", kind: "function", exported: true, line: 42 })])
    const newer = makeMap([])
    const changes = diffApiSurface(old, newer)

    expect(changes[0]!.oldShape).toBeDefined()
    expect(changes[0]!.oldShape!.line).toBe(42)
    expect(changes[0]!.newShape).toBeUndefined()
  })

  test("ApiChange carries newShape for additions", () => {
    const old = makeMap([])
    const newer = makeMap([sym({ name: "fresh", kind: "const", exported: true, line: 7 })])
    const changes = diffApiSurface(old, newer)

    expect(changes[0]!.newShape).toBeDefined()
    expect(changes[0]!.newShape!.line).toBe(7)
    expect(changes[0]!.oldShape).toBeUndefined()
  })

  test("ApiChange carries both shapes for modifications", () => {
    const old = makeMap([sym({ name: "mod", kind: "function", exported: true, line: 10 })])
    const newer = makeMap([sym({ name: "mod", kind: "function", exported: true, line: 10, async: true })])
    const changes = diffApiSurface(old, newer)

    for (const c of changes) {
      expect(c.oldShape).toBeDefined()
      expect(c.newShape).toBeDefined()
    }
  })
})
