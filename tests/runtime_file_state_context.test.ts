import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { agentLoop } from "../src/agent/loop"
import {
  createRuntimeFileStateContext,
  fingerprintContent,
  fingerprintFile,
  getRuntimeFileStateLedger,
  getWriteGeneration,
  recordRuntimeFileRead,
  recordRuntimeFileWrite,
  resetRuntimeFileStateLedger,
  runWithRuntimeFileStateContext,
} from "../src/file-state"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

class FileStateProbeProvider implements LLMProvider {
  rounds = 0
  observedGeneration = -1

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe", name: "file_state_probe", input: {} } }
      return
    }
    this.observedGeneration = getWriteGeneration()
    yield { type: "text", data: "done" }
  }
}

describe("runtime file-state context", () => {
  test("records the exact bytes returned by read_file instead of re-reading a changed path", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-runtime-read-"))
    const path = join(root, "race.ts")
    try {
      resetRuntimeFileStateLedger()
      writeFileSync(path, "model saw this", "utf-8")
      const observed = readFileSync(path)
      writeFileSync(path, "external replacement", "utf-8")

      const record = recordRuntimeFileRead({
        path,
        range: { kind: "full" },
        content: observed.toString("utf-8"),
        fingerprint: fingerprintContent(observed),
      })

      expect(record?.baseline.sha256).toBe(fingerprintContent(observed).sha256)
      expect(record?.baseline.sha256).not.toBe(fingerprintFile(resolve(path))?.sha256)
      expect(getRuntimeFileStateLedger().get(resolve(path))?.baseline.sha256).toBe(record?.baseline.sha256)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("concurrent agent runs keep independent write generations", async () => {
    resetRuntimeFileStateLedger()
    const first = createRuntimeFileStateContext()
    const second = createRuntimeFileStateContext()

    let releaseFirst!: () => void
    let markFirstReady!: () => void
    const firstReady = new Promise<void>(resolve => { markFirstReady = resolve })
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve })

    const [firstGeneration, secondGeneration] = await Promise.all([
      runWithRuntimeFileStateContext(first, async () => {
        recordRuntimeFileWrite({ path: "virtual/first.ts", content: "first" })
        markFirstReady()
        await firstMayFinish
        return getWriteGeneration()
      }),
      (async () => {
        await firstReady
        return runWithRuntimeFileStateContext(second, async () => {
          expect(getWriteGeneration()).toBe(0)
          recordRuntimeFileWrite({ path: "virtual/second-a.ts", content: "second-a" })
          recordRuntimeFileWrite({ path: "virtual/second-b.ts", content: "second-b" })
          releaseFirst()
          await Promise.resolve()
          return getWriteGeneration()
        })
      })(),
    ])

    expect(firstGeneration).toBe(1)
    expect(secondGeneration).toBe(2)
    expect(getWriteGeneration()).toBe(0)
  })

  test("concurrent agent loops bind tools and provider rounds to independent contexts", async () => {
    resetRuntimeFileStateLedger()
    let releaseFirst!: () => void
    let markFirstReady!: () => void
    const firstReady = new Promise<void>(resolve => { markFirstReady = resolve })
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstProvider = new FileStateProbeProvider()
    const secondProvider = new FileStateProbeProvider()

    const consume = async (provider: FileStateProbeProvider, execute: () => Promise<void>) => {
      const tools = buildTools({
        name: "file_state_probe",
        description: "Observe isolated runtime file state",
        isReadonly: true,
        isConcurrencySafe: true,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          await execute()
          return Result.ok("observed")
        },
      })
      for await (const _event of agentLoop("run the file state probe", {
        provider,
        model: "test",
        tools,
        maxRounds: 2,
      })) {
        // Consume the full run so the provider's second round observes its context.
      }
    }

    await Promise.all([
      consume(firstProvider, async () => {
        recordRuntimeFileWrite({ path: "virtual/agent-first.ts", content: "first" })
        markFirstReady()
        await firstMayFinish
      }),
      consume(secondProvider, async () => {
        await firstReady
        recordRuntimeFileWrite({ path: "virtual/agent-second.ts", content: "second" })
        releaseFirst()
      }),
    ])

    expect(firstProvider.observedGeneration).toBe(1)
    expect(secondProvider.observedGeneration).toBe(1)
    expect(getWriteGeneration()).toBe(0)
  })
})
