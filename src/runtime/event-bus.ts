import { EventEmitter } from "node:events"
import type { RuntimeEvent } from "./events"

export type RuntimeEventListener = (event: RuntimeEvent) => void

export class RuntimeEventBus {
  private readonly emitter = new EventEmitter()
  private readonly history: RuntimeEvent[] = []
  private readonly maxHistory: number

  constructor(maxHistory = 2000) {
    this.maxHistory = Math.max(0, Math.floor(maxHistory))
  }

  emitEvent(event: RuntimeEvent): void {
    if (this.maxHistory > 0) {
      this.history.push(event)
      if (this.history.length > this.maxHistory) {
        this.history.splice(0, this.history.length - this.maxHistory)
      }
    }
    this.emitter.emit("event", event)
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.emitter.on("event", listener)
    return () => {
      this.emitter.off("event", listener)
    }
  }

  getHistory(): RuntimeEvent[] {
    return [...this.history]
  }
}
