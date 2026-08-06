/** Readline-based input — slash commands are dispatched via CommandRegistry. */

import * as readline from "node:readline"

const cyan = (s: string) => `\x1b[1;36m${s}\x1b[0m`

/**
 * Start readline input loop. Every line is forwarded to `onLine` —
 * command dispatch happens in cli.ts via CommandRegistry.execute.
 *
 * `onClose` runs when the readline stream closes (EOF/Ctrl-D) — the CLI
 * uses it to flush the session before process.exit (D5 EXIT_PATH_FLUSHES_SESSION).
 *
 * Returns the readline interface so the caller can reprompt.
 */
export function startInput(onLine: (line: string) => void, onClose?: () => void) {
  const isTTY = process.stdin.isTTY
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: isTTY ? `${cyan("> ")}` : "> ",
    terminal: isTTY,
  })

  rl.prompt()

  rl.on("line", (raw: string) => {
    const line = raw.trim()
    if (!line) { rl.prompt(); return }

    onLine(line)
  })

  rl.on("close", () => {
    if (onClose) onClose()
    process.exit(0)
  })

  return rl
}

/** Signal readline to show prompt again after agent output. */
export function reprompt(rl: readline.Interface) {
  rl.resume()
  rl.prompt()
}
