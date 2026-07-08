import { randomUUID } from "node:crypto"
import { resolveRuntimeControlIntent, type RuntimeCommandCatalogEntry, type RuntimeControlIntent } from "./control-plane"
import { RuntimeEventBus } from "./event-bus"
import type { RuntimeEvent, RuntimeStatus, UserIntent } from "./events"
import { createRuntimeSession, updateRuntimeSessionStatus, type RuntimeSession } from "./session"

export type RuntimeControllerAction =
  | "started"
  | "agent_request"
  | "queued"
  | "local_command"
  | "interrupted"
  | "approval"
  | "rewind"
  | "panel"

export interface RuntimeControllerResult {
  ok: boolean
  action: RuntimeControllerAction
  status: RuntimeStatus
  message?: string
  controlIntent?: RuntimeControlIntent
}

export interface RuntimeControllerOptions {
  sessionId?: string
  repoRoot: string
  eventBus?: RuntimeEventBus
  commandCatalog?: readonly RuntimeCommandCatalogEntry[]
  now?: () => number
}

export class RuntimeController {
  readonly eventBus: RuntimeEventBus
  private session: RuntimeSession
  private readonly now: () => number
  private readonly commandCatalog?: readonly RuntimeCommandCatalogEntry[]
  private started = false

  constructor(options: RuntimeControllerOptions) {
    this.eventBus = options.eventBus ?? new RuntimeEventBus()
    this.now = options.now ?? Date.now
    this.commandCatalog = options.commandCatalog
    this.session = createRuntimeSession({
      sessionId: options.sessionId ?? randomUUID(),
      repoRoot: options.repoRoot,
      timestamp: this.now(),
    })
  }

  getSession(): RuntimeSession {
    return { ...this.session }
  }

  emit(event: RuntimeEvent): void {
    this.eventBus.emitEvent(event)
  }

  start(): RuntimeControllerResult {
    if (!this.started) {
      this.started = true
      const timestamp = this.now()
      this.emit({
        type: "session.started",
        sessionId: this.session.sessionId,
        repoRoot: this.session.repoRoot,
        timestamp,
      })
      this.setStatus("idle", timestamp)
    }

    return {
      ok: true,
      action: "started",
      status: this.session.status,
    }
  }

  setStatus(status: RuntimeStatus, timestamp = this.now()): void {
    this.session = updateRuntimeSessionStatus(this.session, status, timestamp)
    this.emit({ type: "session.status", status, timestamp })
  }

  handleIntent(intent: UserIntent): RuntimeControllerResult {
    switch (intent.type) {
      case "submit_prompt": {
        this.setStatus("planning")
        return {
          ok: true,
          action: "agent_request",
          status: this.session.status,
        }
      }
      case "queue_message":
        return {
          ok: true,
          action: "queued",
          status: this.session.status,
        }
      case "slash_command":
        if (this.commandCatalog) {
          const controlIntent = resolveRuntimeControlIntent(intent.raw, this.commandCatalog, {
            isRunning: this.session.status === "planning" || this.session.status === "running",
          })
          if (controlIntent.kind === "unknown_command") {
            this.setStatus("planning")
            return {
              ok: true,
              action: "agent_request",
              status: this.session.status,
              controlIntent,
            }
          }
          if (controlIntent.kind === "blocked_command") {
            return {
              ok: false,
              action: "local_command",
              status: this.session.status,
              message: controlIntent.reason,
              controlIntent,
            }
          }
          return {
            ok: true,
            action: "local_command",
            status: this.session.status,
            controlIntent,
          }
        }
        return {
          ok: true,
          action: "local_command",
          status: this.session.status,
        }
      case "interrupt":
        this.setStatus("blocked")
        return {
          ok: true,
          action: "interrupted",
          status: this.session.status,
        }
      case "approve_plan":
      case "reject_plan":
      case "approve_tool":
      case "deny_tool":
        return {
          ok: true,
          action: "approval",
          status: this.session.status,
        }
      case "rewind":
        return {
          ok: true,
          action: "rewind",
          status: this.session.status,
        }
      case "open_panel":
        return {
          ok: true,
          action: "panel",
          status: this.session.status,
        }
    }
  }
}
