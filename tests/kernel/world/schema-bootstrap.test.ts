import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { WorldStore } from "../../../src/kernel/world"
import { removeTestWorldRoot } from "./helpers"

const CHILD = join(import.meta.dir, "schema-bootstrap-child.ts")

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

describe("AK-1 WorldDB schema bootstrap", () => {
  test("concurrent first open serializes bootstrap and validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-schema-race-"))
    const children: ChildProcess[] = []
    const exits: Array<Promise<{ code: number | null; stderr: string }>> = []
    try {
      for (let index = 0; index < 4; index += 1) {
        const child = spawn(process.execPath, [CHILD, root], {
          cwd: join(import.meta.dir, "../../.."),
          stdio: ["ignore", "ignore", "pipe"],
        })
        children.push(child)
        exits.push(waitForExit(child))
      }
      expect(await Promise.all(exits)).toEqual([
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
      ])
      const store = new WorldStore(root)
      try {
        expect(store.verifyIntegrity()).toEqual([])
      } finally {
        store.close()
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill()
      }
      removeTestWorldRoot(root)
    }
  })

  for (const faultPoint of [
    "after_world_db_bootstrap_intent_fsync",
    "after_world_db_bootstrap_image_fsync",
  ] as const) {
    test(`an OS-released bootstrap lock recovers ${faultPoint}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "orcana-world-schema-crash-"))
      let child: ChildProcess | undefined
      const recoveryChildren: ChildProcess[] = []
      try {
        child = spawn(process.execPath, [CHILD, root, faultPoint], {
          cwd: join(import.meta.dir, "../../.."),
          stdio: ["ignore", "ignore", "pipe"],
        })
        expect(await waitForExit(child)).toEqual({ code: 91, stderr: "" })

        const recoveryExits: Array<Promise<{ code: number | null; stderr: string }>> = []
        for (let index = 0; index < 4; index += 1) {
          const recoveryChild = spawn(process.execPath, [CHILD, root], {
            cwd: join(import.meta.dir, "../../.."),
            stdio: ["ignore", "ignore", "pipe"],
          })
          recoveryChildren.push(recoveryChild)
          recoveryExits.push(waitForExit(recoveryChild))
        }
        expect(await Promise.all(recoveryExits)).toEqual(Array.from({ length: 4 }, () => ({
          code: 0,
          stderr: "",
        })))

        const store = new WorldStore(root)
        try {
          expect(store.verifyIntegrity()).toEqual([])
          expect(existsSync(join(root, "recovery", "worlddb-bootstrap.lock"))).toBe(true)
          const state = readFileSync(
            join(root, "recovery", "worlddb-bootstrap.state"),
            "utf8",
          ).trim().split("\n")
          expect(state).toHaveLength(2)
          expect(state.map(line => JSON.parse(line).phase)).toEqual(["writing", "complete"])
          expect(readFileSync(join(root, "world.db")).subarray(0, 15).toString()).toBe(
            "SQLite format 3",
          )
        } finally {
          store.close()
        }
      } finally {
        if (child?.exitCode === null) child.kill()
        for (const recoveryChild of recoveryChildren) {
          if (recoveryChild.exitCode === null) recoveryChild.kill()
        }
        removeTestWorldRoot(root)
      }
    })
  }

  test("arbitrary stale PID text never authorizes committed WorldDB replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-schema-stale-text-"))
    try {
      const store = new WorldStore(root)
      store.createWorld({ worldId: "w1", owner: "user:owner" })
      store.close()

      writeFileSync(join(root, "recovery", "worlddb-bootstrap.lock"), "999999\n")
      const reopened = new WorldStore(root)
      try {
        expect(reopened.getWorld("w1")?.worldId).toBe("w1")
        expect(reopened.verifyIntegrity()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      removeTestWorldRoot(root)
    }
  })

  test("a non-empty database without bootstrap provenance fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-schema-unproven-"))
    const unproven = Buffer.from("unproven database bytes")
    try {
      writeFileSync(join(root, "world.db"), unproven)
      expect(() => new WorldStore(root)).toThrow(/WORLD_DB_BOOTSTRAP_STATE_MISSING/)
      expect(readFileSync(join(root, "world.db"))).toEqual(unproven)
    } finally {
      removeTestWorldRoot(root)
    }
  })
})
