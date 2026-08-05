/** overlays — TUI overlay 互斥状态（Depthline P1）。
 *
 *  原实现为三个 nullable 字段（confirm/rewind/runtime），P1 合并为互斥 union，
 *  消除"同一时刻可能同时打开多个 modal"的语义歧义。
 *
 *  命名约定（评审修正 #6）：
 *    - settings  = 模型配置对话框（model list / API key / custom model / URL / effort）
 *    - runtime-inspector = RuntimeInspector overlay（P2 引入，RightRail 能力迁移）
 *    - permission / question / clarification 不属于 overlay，走 InteractionSlot（P2）
 */

import type { ConfirmRequest } from "./confirm-stubs"
import type { RewindModalState } from "./components/RewindModal"

export type ThinkEffort = "auto" | "high" | "max"

export interface ModelDialogOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  configured: boolean
  current: boolean
  tier: string
  thinking: boolean
  contextWindow: number
  custom?: boolean
}

/** 模型/推理深度配置对话框状态机（原 RuntimeDialogState）。 */
export type SettingsDialogState =
  | {
      type: "models"
      phase: "list"
      query: string
      selected: number
      options: ModelDialogOption[]
      providerFilter?: string
      error?: string
    }
  | {
      type: "models"
      phase: "key"
      providerId: string
      providerName: string
      modelId: string
      modelName: string
      keyValue: string
      custom?: boolean
      baseUrl?: string
      error?: string
    }
  | {
      type: "models"
      phase: "custom"
      providerId: string
      providerName: string
      modelValue: string
      error?: string
    }
  | {
      type: "models"
      phase: "url"
      providerId: string
      providerName: string
      modelId: string
      modelName: string
      baseUrlValue: string
      defaultBaseUrl?: string
      error?: string
    }
  | {
      type: "effort"
      selected: number
      current: ThinkEffort
      error?: string
    }

export type OverlayState =
  | { kind: "none" }
  | { kind: "confirm"; request: ConfirmRequest; position: string }
  | { kind: "rewind"; state: RewindModalState }
  | { kind: "settings"; dialog: SettingsDialogState }
