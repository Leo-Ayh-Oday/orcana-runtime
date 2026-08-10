/** LR2-1v2（L2-B）验收：LogStore + AttachLogs 完整回放。 */

import { describe, test, expect } from "bun:test"
import { LogStore, memLogFs, memLogIndex, type AttachChunk } from "../../../src/execd/log-store"

function setup() {
  const { fs, files } = memLogFs()
  const index = memLogIndex()
  const store = new LogStore({ logRoot: "/logs", fs, index, now: () => 1_700_000_000_000 })
  return { store, files, index }
}

describe("L2-B: LogStore", () => {
  test("append writes file + index; attach reads full content", () => {
    const { store } = setup()
    store.append("cell-1", "stdout", "line1\n")
    store.append("cell-1", "stdout", "line2\n")
    const chunk = store.attach("cell-1", "stdout", 0)
    expect(chunk.data).toBe("line1\nline2\n")
    expect(chunk.eof).toBe(true)
    expect(chunk.totalBytes).toBe(12)
  })

  test("ATTACH_LOGS_TRUNCATED: >16KB content fully readable via attach (index-only path truncates)", () => {
    const { store } = setup()
    const big = "x".repeat(40 * 1024) // 40KB —— 远超在线事件 16KB 截断
    store.append("cell-1", "stderr", big)
    const chunk = store.attach("cell-1", "stderr", 0)
    expect(chunk.data.length).toBe(40 * 1024) // 完整
  })

  test("attach with offset resumes (breakpoint continuation)", () => {
    const { store } = setup()
    store.append("cell-1", "stdout", "AAAA")
    store.append("cell-1", "stdout", "BBBB")
    const first = store.attach("cell-1", "stdout", 0)
    expect(first.data).toBe("AAAABBBB")
    // 模拟消费一半后重连
    const resumed = store.attach("cell-1", "stdout", 4)
    expect(resumed.data).toBe("BBBB")
    expect(resumed.eof).toBe(true)
  })

  test("attach beyond EOF → empty eof chunk", () => {
    const { store } = setup()
    store.append("cell-1", "stdout", "abc")
    const chunk = store.attach("cell-1", "stdout", 99)
    expect(chunk.data).toBe("")
    expect(chunk.eof).toBe(true)
    expect(chunk.totalBytes).toBe(3)
  })

  test("attach on never-written cell → eof empty", () => {
    const { store } = setup()
    const chunk: AttachChunk = store.attach("cell-x", "stdout", 0)
    expect(chunk.data).toBe("")
    expect(chunk.eof).toBe(true)
    expect(chunk.totalBytes).toBe(0)
  })

  test("sizeOf tracks appended bytes", () => {
    const { store } = setup()
    expect(store.sizeOf("cell-1", "stdout")).toBe(0)
    store.append("cell-1", "stdout", "hello")
    expect(store.sizeOf("cell-1", "stdout")).toBe(5)
  })

  test("LOG_LEAK_AFTER_CLEANUP: remove deletes files + index", () => {
    const { store, files, index } = setup()
    store.append("cell-1", "stdout", "a")
    store.append("cell-1", "stderr", "b")
    store.remove("cell-1")
    expect([...files.keys()]).toHaveLength(0)
    expect(index.get("cell-1", "stdout")).toBeUndefined()
    expect(index.get("cell-1", "stderr")).toBeUndefined()
    expect(store.attach("cell-1", "stdout", 0).data).toBe("")
  })

  test("empty append is no-op (no file creation)", () => {
    const { store, files } = setup()
    store.append("cell-1", "stdout", "")
    expect([...files.keys()]).toHaveLength(0)
  })

  test("index length accumulates across appends", () => {
    const { store, index } = setup()
    store.append("cell-1", "stdout", "12345")
    store.append("cell-1", "stdout", "67890")
    expect(index.get("cell-1", "stdout")?.lengthBytes).toBe(10)
  })
})
