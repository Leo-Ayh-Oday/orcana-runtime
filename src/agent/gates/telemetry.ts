/** Gate telemetry — minimal instrumentation for the 3-step gate validation plan.
 *
 *  Design constraints:
 *    - No framework dependency (plain Map + counters)
 *    - Only instrument gates that have a corresponding failure case from Step 1
 *    - Pure data collector — never affects gate decisions
 *    - JSON-serializable for persistence across sessions
 *
 *  Usage:
 *    const tel = new GateTelemetry()
 *    chain.evaluate(ctx, tel)
 *    // After task completes:
 *    tel.markFalsePositive("quality")   // human review: quality gate blocked but shouldn't have
 *    tel.markMissed("ripple_exit")      // human review: ripple_exit should have blocked but didn't
 *    console.log(tel.report())
 */

export interface GateHit {
  triggers: number       // times the gate was evaluated
  passes: number         // times the gate allowed execution
  blocks: number         // times the gate blocked execution
  falsePositives: number // human-annotated: blocked but shouldn't have
  missed: number         // human-annotated: should have blocked but didn't
}

export class GateTelemetry {
  private hits = new Map<string, GateHit>()

  // ── Recording ──

  /** Record a gate evaluation outcome. Called automatically by GateChain. */
  record(gateName: string, outcome: "pass" | "block"): void {
    const h = this.ensure(gateName)
    h.triggers++
    if (outcome === "pass") h.passes++
    else h.blocks++
  }

  // ── Human annotation (post-task review) ──

  /** Mark that a gate blocked when it shouldn't have.
   *  No-ops if the gate has no blocks — a false positive requires at least one block. */
  markFalsePositive(gateName: string): void {
    const h = this.hits.get(gateName)
    if (!h || h.blocks === 0) return
    h.falsePositives++
  }

  /** Mark that a gate should have blocked but didn't. */
  markMissed(gateName: string): void {
    const h = this.ensure(gateName)
    h.missed++
  }

  // ── Queries ──

  /** Intercept rate (0–1): how often the gate blocks when triggered. */
  interceptRate(gateName: string): number {
    const h = this.hits.get(gateName)
    if (!h || h.triggers === 0) return 0
    return h.blocks / h.triggers
  }

  /** False positive rate (0–1): how often a block was wrong. */
  falsePositiveRate(gateName: string): number {
    const h = this.hits.get(gateName)
    if (!h || h.blocks === 0) return 0
    return h.falsePositives / h.blocks
  }

  /** All recorded gate names. */
  gateNames(): string[] {
    return [...this.hits.keys()]
  }

  /** Get raw hit data for a gate. */
  get(gateName: string): GateHit | undefined {
    return this.hits.get(gateName)
  }

  // ── Report ──

  /** Generate a markdown report sorted by blocks descending. */
  report(): string {
    const lines = ["## Gate Telemetry Report", ""]
    const entries = [...this.hits.entries()]
      .sort((a, b) => b[1].blocks - a[1].blocks)
    if (entries.length === 0) {
      lines.push("_No gate evaluations recorded._")
      return lines.join("\n")
    }
    for (const [name, h] of entries) {
      const iRate = h.triggers > 0 ? ((h.blocks / h.triggers) * 100).toFixed(0) : "0"
      const fpRate = h.blocks > 0 ? ((h.falsePositives / h.blocks) * 100).toFixed(0) : "0"
      lines.push(`- **${name}**: ${h.triggers} triggers, ${h.blocks} blocks (${iRate}%), ${h.falsePositives} FP (${fpRate}%), ${h.missed} missed`)
    }
    return lines.join("\n")
  }

  /** Compact single-line summary for console/status display. */
  summary(gateName: string): string {
    const h = this.hits.get(gateName)
    if (!h) return `${gateName}: no data`
    const iRate = h.triggers > 0 ? ((h.blocks / h.triggers) * 100).toFixed(0) : "0"
    return `${gateName}: ${h.triggers}t/${h.blocks}b/${h.passes}p (${iRate}% int)`
  }

  // ── Serialization ──

  /** Export all data as a plain object for JSON serialization. */
  toJSON(): Record<string, GateHit> {
    const obj: Record<string, GateHit> = {}
    for (const [name, h] of this.hits) {
      obj[name] = { ...h }
    }
    return obj
  }

  /** Import data from a plain object (e.g., from a previous session).
   *  Validates every field is a finite number — skips malformed entries silently. */
  static fromJSON(json: Record<string, unknown>): GateTelemetry {
    const tel = new GateTelemetry()
    for (const [name, raw] of Object.entries(json)) {
      const h = raw as Record<string, unknown>
      const triggers = Number(h.triggers)
      const passes = Number(h.passes)
      const blocks = Number(h.blocks)
      const falsePositives = Number(h.falsePositives)
      const missed = Number(h.missed)
      if ([triggers, passes, blocks, falsePositives, missed].some(n => !Number.isFinite(n))) continue
      tel.hits.set(name, { triggers, passes, blocks, falsePositives, missed })
    }
    return tel
  }

  /** Merge another telemetry instance into this one (additive). */
  merge(other: GateTelemetry): void {
    for (const [name, h] of other.hits) {
      const mine = this.ensure(name)
      mine.triggers += h.triggers
      mine.passes += h.passes
      mine.blocks += h.blocks
      mine.falsePositives += h.falsePositives
      mine.missed += h.missed
    }
  }

  /** Reset all counters. */
  reset(): void {
    this.hits.clear()
  }

  // ── File persistence ──

  /** Save telemetry to a JSON file. Returns the path written. */
  async saveToFile(filePath: string): Promise<string> {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(this.toJSON(), null, 2), "utf-8")
    return filePath
  }

  /** Load telemetry from a JSON file. Returns empty if file doesn't exist. */
  static async loadFromFile(filePath: string): Promise<GateTelemetry> {
    const fs = await import("node:fs/promises")
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid telemetry file: expected object, got ${typeof parsed}`)
      }
      return GateTelemetry.fromJSON(parsed as Record<string, unknown>)
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new GateTelemetry()
      throw e
    }
  }

  // ── Internal ──

  private ensure(name: string): GateHit {
    const existing = this.hits.get(name)
    if (existing) return existing
    const h: GateHit = { triggers: 0, passes: 0, blocks: 0, falsePositives: 0, missed: 0 }
    this.hits.set(name, h)
    return h
  }
}
