import { existsSync, writeFileSync } from "node:fs"
import {
  assertWorldRecovered,
  recoverWorldStore,
  WorldStore,
  type CasDigest,
} from "../../../src/kernel/world"

const scenario = process.argv[2]
const root = process.argv[3]
const digest = process.argv[4] as CasDigest | undefined
const readyPath = process.argv[5]
const releasePath = process.argv[6]
if (!scenario || !root || !digest || !readyPath || !releasePath) {
  throw new Error("usage: cas-concurrency-child <link|recover> <root> <digest> <ready> <release>")
}

if (scenario === "link") {
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  const store = new WorldStore(root, {
    faultInjector: point => {
      if (point !== "before_cas_link_insert") return
      writeFileSync(readyPath, "ready")
      const deadline = Date.now() + 10_000
      while (!existsSync(releasePath) && Date.now() < deadline) {
        Atomics.wait(waiter, 0, 0, 10)
      }
      if (!existsSync(releasePath)) throw new Error("link release timed out")
    },
  })
  try {
    store.compareAndCommit({
      worldId: "w1",
      branchId: "main",
      baseRevision: 0n,
      actor: "agent:linker",
      commitId: "commit-linker",
      mutations: [{
        type: "object.put",
        objectId: "file",
        objectType: "file",
        contentRef: digest,
      }],
    })
  } finally {
    store.close()
  }
} else if (scenario === "recover") {
  const store = new WorldStore(root)
  try {
    assertWorldRecovered(recoverWorldStore(store))
    writeFileSync(releasePath, "complete")
  } finally {
    store.close()
  }
} else {
  throw new Error(`unknown concurrency scenario: ${scenario}`)
}
