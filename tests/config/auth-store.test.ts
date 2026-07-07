import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AuthStore,
  FileAuthStore,
  MemoryAuthStore,
  getDefaultAuthStore,
  isAuthFileSecure,
} from "../../src/config/auth-store"

describe("MemoryAuthStore", () => {
  test("get returns undefined for non-existent key", async () => {
    const store = new MemoryAuthStore()
    expect(await store.get("missing")).toBeUndefined()
  })

  test("set + get roundtrip works", async () => {
    const store = new MemoryAuthStore()
    await store.set("openai", "sk-test-123")
    expect(await store.get("openai")).toBe("sk-test-123")
  })

  test("set overwrites previous value", async () => {
    const store = new MemoryAuthStore()
    await store.set("openai", "sk-old")
    await store.set("openai", "sk-new")
    expect(await store.get("openai")).toBe("sk-new")
  })

  test("delete removes key", async () => {
    const store = new MemoryAuthStore()
    await store.set("openai", "sk-test")
    await store.delete("openai")
    expect(await store.get("openai")).toBeUndefined()
  })

  test("list returns all provider IDs", async () => {
    const store = new MemoryAuthStore()
    await store.set("openai", "sk-1")
    await store.set("anthropic", "sk-2")
    await store.set("deepseek", "sk-3")
    const ids = await store.list()
    expect(ids.sort()).toEqual(["anthropic", "deepseek", "openai"])
  })

  test("list returns empty array for empty store", async () => {
    const store = new MemoryAuthStore()
    expect(await store.list()).toEqual([])
  })
})

describe("FileAuthStore", () => {
  let tempDir: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "auth-store-test-"))
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("set + get roundtrip works", async () => {
    const store = new FileAuthStore(join(tempDir, "roundtrip.json"))
    await store.set("openai", "sk-test-123")
    expect(await store.get("openai")).toBe("sk-test-123")
  })

  test("delete removes key", async () => {
    const filePath = join(tempDir, "delete.json")
    const store = new FileAuthStore(filePath)
    await store.set("openai", "sk-test")
    await store.set("anthropic", "sk-keep")
    await store.delete("openai")
    expect(await store.get("openai")).toBeUndefined()
    expect(await store.get("anthropic")).toBe("sk-keep")
  })

  test("list returns all provider IDs", async () => {
    const store = new FileAuthStore(join(tempDir, "list.json"))
    await store.set("openai", "sk-1")
    await store.set("anthropic", "sk-2")
    await store.set("deepseek", "sk-3")
    const ids = await store.list()
    expect(ids.sort()).toEqual(["anthropic", "deepseek", "openai"])
  })

  test("reading existing file works", async () => {
    const filePath = join(tempDir, "existing.json")
    writeFileSync(filePath, JSON.stringify({ openai: "sk-prewritten", deepseek: "sk-ds" }, null, 2))
    const store = new FileAuthStore(filePath)
    expect(await store.get("openai")).toBe("sk-prewritten")
    expect(await store.get("deepseek")).toBe("sk-ds")
    const ids = await store.list()
    expect(ids.sort()).toEqual(["deepseek", "openai"])
  })

  test("migrates legacy provider keys to default credential profiles", async () => {
    const filePath = join(tempDir, "legacy-migrate.json")
    writeFileSync(filePath, JSON.stringify({ deepseek: "sk-ds", qwen: "sk-qwen" }, null, 2))
    const store = new FileAuthStore(filePath)
    expect(await store.get("deepseek")).toBe("sk-ds")
    expect(await store.getCredential?.("deepseek/default")).toMatchObject({
      id: "deepseek/default",
      providerId: "deepseek",
      label: "default",
      apiKey: "sk-ds",
    })
    expect(JSON.parse(readFileSync(filePath, "utf-8")).version).toBe(2)
  })

  test("supports multiple credential profiles for one provider", async () => {
    const store = new FileAuthStore(join(tempDir, "profiles.json"))
    await store.setCredential?.({
      id: "deepseek/default",
      providerId: "deepseek",
      label: "default",
      apiKey: "sk-default",
      createdAt: 1,
      updatedAt: 1,
    })
    await store.setCredential?.({
      id: "deepseek/company",
      providerId: "deepseek",
      label: "company",
      apiKey: "sk-company",
      createdAt: 1,
      updatedAt: 1,
    })
    expect((await store.getCredential?.("deepseek/company"))?.apiKey).toBe("sk-company")
    const summaries = await store.listCredentials?.("deepseek")
    expect(summaries?.map(item => item.id).sort()).toEqual(["deepseek/company", "deepseek/default"])
    expect(JSON.stringify(summaries)).not.toContain("sk-company")
  })

  test("corrupted file returns undefined", async () => {
    const filePath = join(tempDir, "corrupted.json")
    writeFileSync(filePath, "this is not valid json {{{{")
    const store = new FileAuthStore(filePath)
    expect(await store.get("openai")).toBeUndefined()
    expect(await store.list()).toEqual([])
  })
})

describe("isAuthFileSecure", () => {
  test("returns true on Windows", () => {
    if (process.platform === "win32") {
      expect(isAuthFileSecure(join(tmpdir(), "any-path.json"))).toBe(true)
    }
  })

  test("returns true for non-existent file", () => {
    const nonExistent = join(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".json")
    expect(isAuthFileSecure(nonExistent)).toBe(true)
  })
})

describe("getDefaultAuthStore", () => {
  test("returns same instance on multiple calls (singleton)", () => {
    const a = getDefaultAuthStore()
    const b = getDefaultAuthStore()
    expect(a).toBe(b)
  })
})
