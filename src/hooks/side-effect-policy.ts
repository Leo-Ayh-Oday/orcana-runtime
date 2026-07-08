import { analyzeSideEffects, formatSideEffectReport } from "../sandbox/side-effect-guard"
import type { LegacyHookHandler } from "./index"

export interface SideEffectPolicyOptions {
  projectRoot?: string
}

export function createSideEffectPolicyHook(options: SideEffectPolicyOptions = {}): LegacyHookHandler {
  const projectRoot = options.projectRoot ?? process.cwd()

  return (input) => {
    if (input.tool !== "shell") return {}

    const command = typeof input.params?.command === "string" ? input.params.command : ""
    if (!command.trim()) return {}

    const report = analyzeSideEffects(command, projectRoot)
    if (report.severity === "none") return {}

    const warn = formatSideEffectReport(report)
    if (report.severity === "danger") {
      return { blocked: true, warn, source: "hooks:side-effect-policy" }
    }
    return { warn, source: "hooks:side-effect-policy" }
  }
}
