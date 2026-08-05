/** G1 acceptance: graph checkpoint + result store round-trip. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ResultStore } from "../../src/workflow/results/result-store"

describe("G1 result store + checkpoint", () => {
  test("put/get round-trips results", () => {
    const store = new ResultStore("s1")
    store.put({ nodeId: "a", status: "done", output: { x: 1 }, startedAt: 1, finishedAt: 2, durationMs: 1 })
    expect(store.get("a")?.output).toEqual({ x: 1 })
    expect(store.has("a")).toBe(true)
    expect(store.has("b")).toBe(false)
  })

  test("checkpoint file is written and restorable", () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-cp-"))
    const store = new ResultStore("spec-1", dir)
    store.put({ nodeId: "n1", status: "done", output: { content: "hello" }, startedAt: 1, finishedAt: 2, durationMs: 1 })
    store.put({ nodeId: "n2", status: "failed", output: null, error: "boom", startedAt: 1, finishedAt: 2, durationMs: 1 })

    const file = join(dir, "spec-1.json")
    const raw = readFileSync(file, "utf-8")
    expect(raw).toContain("hello")

    const restored = new ResultStore("spec-1")
    expect(restored.restore(dir)).toBe(true)
    expect(restored.get("n1")?.output).toEqual({ content: "hello" })
    expect(restored.get("n2")?.status).toBe("failed")
  })

  test("restore from a mismatched spec id returns false", () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-cp-"))
    const store = new ResultStore("spec-a", dir)
    store.put({ nodeId: "n1", status: "done", output: 1, startedAt: 1, finishedAt: 2, durationMs: 1 })
    const other = new ResultStore("spec-b")
    expect(other.restore(dir)).toBe(false)
  })

  test("checkpoint payload is redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-cp-"))
    const store = new ResultStore("spec-red", dir)
    store.put({ nodeId: "n1", status: "done", output: { apiKey: "sk-super-secret", content: "ok" }, startedAt: 1, finishedAt: 2, durationMs: 1 })
    const raw = readFileSync(join(dir, "spec-red.json"), "utf-8")
    expect(raw).not.toContain("sk-super-secret")
  })
})
