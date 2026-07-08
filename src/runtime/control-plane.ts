export interface RuntimeCommandCatalogEntry {
  name: string
  aliases?: readonly string[]
  safeConcurrent?: boolean
}

export interface ParsedRuntimeCommand {
  raw: string
  name: string
  argsText: string
  argv: string[]
}

export type ParsedRuntimeInput =
  | { kind: "empty"; raw: string }
  | { kind: "prompt"; raw: string; text: string }
  | ({ kind: "slash_command" } & ParsedRuntimeCommand)

export type RuntimeControlIntent =
  | { kind: "empty"; raw: string }
  | { kind: "agent_prompt"; raw: string; text: string }
  | ({ kind: "unknown_command" } & ParsedRuntimeCommand)
  | ({ kind: "local_command"; canonicalName: string; safeConcurrent: boolean } & ParsedRuntimeCommand)
  | ({ kind: "blocked_command"; canonicalName: string; safeConcurrent: false; reason: string } & ParsedRuntimeCommand)

export function parseRuntimeInput(input: string): ParsedRuntimeInput {
  const raw = input
  const trimmed = input.trim()
  if (!trimmed) return { kind: "empty", raw }
  if (!trimmed.startsWith("/")) return { kind: "prompt", raw, text: trimmed }

  const body = trimmed.slice(1)
  const spaceIdx = body.search(/\s/)
  const name = spaceIdx >= 0 ? body.slice(0, spaceIdx) : body
  const argsText = spaceIdx >= 0 ? body.slice(spaceIdx).trim() : ""
  return {
    kind: "slash_command",
    raw: trimmed,
    name,
    argsText,
    argv: splitRuntimeArgs(argsText),
  }
}

export function resolveRuntimeControlIntent(
  input: string,
  catalog: readonly RuntimeCommandCatalogEntry[],
  options: { isRunning?: boolean } = {},
): RuntimeControlIntent {
  const parsed = parseRuntimeInput(input)
  if (parsed.kind === "empty") return parsed
  if (parsed.kind === "prompt") return { kind: "agent_prompt", raw: parsed.raw, text: parsed.text }

  const command = toRuntimeCommand(parsed)
  const entry = findCatalogEntry(parsed.name, catalog)
  if (!entry) return { kind: "unknown_command", ...command }

  const safeConcurrent = entry.safeConcurrent ?? false
  if (options.isRunning && !safeConcurrent) {
    return {
      kind: "blocked_command",
      ...command,
      canonicalName: entry.name,
      safeConcurrent: false,
      reason: `Command /${entry.name} is not available while the agent is running.`,
    }
  }

  return {
    kind: "local_command",
    ...command,
    canonicalName: entry.name,
    safeConcurrent,
  }
}

function findCatalogEntry(name: string, catalog: readonly RuntimeCommandCatalogEntry[]): RuntimeCommandCatalogEntry | undefined {
  return catalog.find(entry => entry.name === name || (entry.aliases ?? []).includes(name))
}

function toRuntimeCommand(parsed: Extract<ParsedRuntimeInput, { kind: "slash_command" }>): ParsedRuntimeCommand {
  return {
    raw: parsed.raw,
    name: parsed.name,
    argsText: parsed.argsText,
    argv: parsed.argv,
  }
}

function splitRuntimeArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: string | null = null

  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (ch === "\"" || ch === "'") {
      quote = ch
      continue
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += ch
  }

  if (current) tokens.push(current)
  return tokens
}
