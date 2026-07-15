/** Provider stream lifecycle helpers shared by Anthropic-compatible adapters. */

export interface ClosableAsyncIterable extends AsyncIterable<unknown> {
  controller?: { abort?: () => void }
  abort?: () => void
  return?: () => Promise<unknown>
}

export interface ProviderAbortBinding {
  isAborted(): boolean
  dispose(): void
}

/** Bind a local AbortSignal to every close mechanism exposed by provider SDK streams. */
export function bindProviderAbort(
  stream: ClosableAsyncIterable,
  signal?: AbortSignal,
): ProviderAbortBinding {
  let locallyAborted = signal?.aborted ?? false
  const onAbort = () => {
    locallyAborted = true
    closeProviderStream(stream)
  }

  signal?.addEventListener("abort", onAbort, { once: true })
  if (locallyAborted) closeProviderStream(stream)

  return {
    isAborted: () => locallyAborted,
    dispose: () => signal?.removeEventListener("abort", onAbort),
  }
}

function closeProviderStream(stream: ClosableAsyncIterable): void {
  try { stream.controller?.abort?.() } catch { /* best effort */ }
  try { stream.abort?.() } catch { /* best effort */ }
  try {
    const closing = stream.return?.()
    if (closing) void closing.catch(() => {})
  } catch { /* best effort */ }
}
