import { describe, expect, test } from "bun:test"
import { bindProviderAbort, type ClosableAsyncIterable } from "../src/provider/stream-lifecycle"

describe("provider stream lifecycle", () => {
  test("local abort consumes an asynchronous stream close rejection", () => {
    const controller = new AbortController()
    let rejectionHandled = false
    const rejectedClose = {
      catch() {
        rejectionHandled = true
        return this
      },
    } as unknown as Promise<unknown>
    const stream = {
      async *[Symbol.asyncIterator]() {},
      return() {
        return rejectedClose
      },
    } satisfies ClosableAsyncIterable

    const binding = bindProviderAbort(stream, controller.signal)
    controller.abort()
    binding.dispose()

    expect(rejectionHandled).toBe(true)
  })
})
