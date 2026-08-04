/** H12 scripted tools (plan §18.2 toolScript) — tool outputs by script.
 *
 *  Each tool consumes its step list in call order; the last step repeats when
 *  the script runs out. Without a toolScript the executor provides a minimal
 *  readonly baseline_probe.
 */

import { buildTools, Result } from "../../src/tools/registry"
import type { ToolDescriptor } from "../../src/tools/registry"
import type { ToolScriptResult } from "./contracts"

export function createScriptedTools(toolScript?: ToolScriptResult[]): ToolDescriptor[] {
  if (!toolScript || toolScript.length === 0) {
    return buildTools({
      name: "baseline_probe",
      description: "scripted probe",
      isReadonly: true,
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute() {
        return Result.ok("scripted ok")
      },
    })
  }

  return toolScript.map((scripted) => {
    let index = 0
    return buildTools({
      name: scripted.toolName,
      description: `scripted tool ${scripted.toolName}`,
      isReadonly: scripted.steps.every((s) => s.success !== false && !s.metadata?.writes),
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute() {
        const step = scripted.steps[Math.min(index, scripted.steps.length - 1)]!
        index += 1
        if (step.success === false) return Result.fail(step.content, step.content)
        return Result.ok(step.content, step.metadata)
      },
    })[0]!
  })
}
