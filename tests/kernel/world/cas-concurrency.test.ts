import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { WorldStore } from "../../../src/kernel/world"

const CHILD = join(import.meta.dir, "cas-concurrency-child.ts")

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = ""
  child.stderr?.on("data", chunk => {
    stderr += String(chunk)
  })
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", code => resolve({ code, stderr }))
  })
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe("AK-1 CAS transaction concurrency", () => {
  test("recovery GC cannot pass a concurrent link transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-cas-race-"))
    const readyPath = join(root, "recovery", "link.ready")
    const releasePath = join(root, "recovery", "link.release")
    const recoveryDonePath = join(root, "recovery", "recovery.done")
    let linker: ChildProcess | undefined
    let collector: ChildProcess | undefined
    try {
      const store = new WorldStore(root)
      store.createWorld({ worldId: "w1", owner: "user:owner" })
      const content = store.cas.put(Buffer.from("link must win"), "text/plain")
      store.close()

      linker = spawn(process.execPath, [
        CHILD,
        "link",
        root,
        content.digest,
        readyPath,
        releasePath,
      ], { cwd: join(import.meta.dir, "../../.."), stdio: ["ignore", "ignore", "pipe"] })
      const linkerExit = waitForExit(linker)
      await waitForFile(readyPath)

      collector = spawn(process.execPath, [
        CHILD,
        "recover",
        root,
        content.digest,
        readyPath,
        recoveryDonePath,
      ], { cwd: join(import.meta.dir, "../../.."), stdio: ["ignore", "ignore", "pipe"] })
      const collectorExit = waitForExit(collector)

      await new Promise(resolve => setTimeout(resolve, 100))
      expect(existsSync(recoveryDonePath)).toBe(false)
      writeFileSync(releasePath, "release")

      expect(await linkerExit).toEqual({ code: 0, stderr: "" })
      expect(await collectorExit).toEqual({ code: 0, stderr: "" })
      expect(existsSync(recoveryDonePath)).toBe(true)

      const reopened = new WorldStore(root)
      try {
        expect(reopened.getWorld("w1")?.currentRevision).toBe(1n)
        expect(reopened.cas.get(content.digest).toString()).toBe("link must win")
        expect(reopened.cas.record(content.digest)?.refCount).toBe(1)
        expect(reopened.verifyIntegrity()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      if (linker?.exitCode === null) linker.kill()
      if (collector?.exitCode === null) collector.kill()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
