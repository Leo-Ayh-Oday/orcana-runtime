/** useOverlayController — overlay 互斥状态 + settings 对话框按键处理（Depthline P1）。
 *
 *  从 main.tsx ChatApp 提取：
 *    - OverlayState 互斥 union 状态
 *    - settings 对话框（model list / API key / custom model / URL / effort）全部按键逻辑
 *
 *  ChatApp 只负责：confirm/rewind/clarification/scroll 的既有动作分发。
 */

import { useCallback, useState } from "react"
import type { Key } from "ink"
import type { Runtime } from "../../runtime/bootstrap"
import type { TuiStore } from "../state/tui-store"
import { cleanAgentError } from "../state/adapter-helpers"
import type { OverlayState, SettingsDialogState, ModelDialogOption, ThinkEffort } from "../overlays"

// ── 纯辅助 ──

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (index < 0) return length - 1
  if (index >= length) return 0
  return index
}

function modelSeedFromQuery(query: string): string {
  const value = query.trim()
  if (!value || value === "/" || value.toLowerCase() === "custom" || value === "自定义") return ""
  return value
}

function normalizeBaseUrl(raw: string, fallback?: string): string | undefined {
  const value = raw.trim() || fallback?.trim() || ""
  return value || undefined
}

function isValidBaseUrl(value: string | undefined): boolean {
  return !value || /^https?:\/\//i.test(value)
}

// ── Controller ──

export interface OverlayControllerDeps {
  runtime: Runtime
  store: TuiStore
  /** 当前模型 ID（用于 buildOptions 的 current 标记）。 */
  getCurrentModel: () => string
  /** 当前推理深度（openEffort 的 selected 初始值）。 */
  getCurrentEffort: () => ThinkEffort
  setThinkEffort: (value: ThinkEffort) => void
  /** 构建模型选项列表（main.tsx 的 buildModelOptions，保持单一定义）。 */
  buildOptions: (query: string, providerFilter?: string) => ModelDialogOption[]
}

export interface OverlayController {
  overlay: OverlayState
  openModelPicker: (provider?: string) => void
  openEffort: () => void
  closeOverlay: () => void
  /** 局部更新 overlay（rewind 导航等用）。 */
  updateOverlay: (updater: (s: OverlayState) => OverlayState) => void
  /** 处理 settings 对话框按键。返回 true 表示已消费（对话框内所有键都被吞掉）。 */
  handleSettingsKey: (input: string, key: Key) => boolean
}

export function useOverlayController(deps: OverlayControllerDeps): OverlayController {
  const { runtime, store, getCurrentModel, getCurrentEffort, setThinkEffort, buildOptions } = deps
  const [overlay, setOverlay] = useState<OverlayState>({ kind: "none" })

  const openModelPicker = useCallback((provider?: string) => {
    const currentModel = getCurrentModel()
    const options = buildOptions("", provider)
    setOverlay({
      kind: "settings",
      dialog: {
        type: "models",
        phase: "list",
        query: "",
        selected: 0,
        options,
        providerFilter: provider,
        error: provider && options.length === 0 ? `没有找到 provider：${provider}` : undefined,
      },
    })
  }, [buildOptions, getCurrentModel])

  const openEffort = useCallback(() => {
    const options: ThinkEffort[] = ["auto", "high", "max"]
    const selected = Math.max(0, options.indexOf(getCurrentEffort()))
    setOverlay({
      kind: "settings",
      dialog: { type: "effort", selected, current: getCurrentEffort() },
    })
  }, [getCurrentEffort])

  const closeOverlay = useCallback(() => {
    setOverlay({ kind: "none" })
  }, [])

  const updateOverlay = useCallback((updater: (s: OverlayState) => OverlayState) => {
    setOverlay(updater)
  }, [])

  // ── settings 对话框按键 ──

  const handleSettingsKey = useCallback((input: string, key: Key): boolean => {
    const dialog = (overlay.kind === "settings" ? overlay.dialog : null) as SettingsDialogState | null
    if (!dialog) return false

    if (key.escape) {
      setOverlay({ kind: "none" })
      return true
    }

    if (dialog.type === "effort") {
      const options: ThinkEffort[] = ["auto", "high", "max"]
      if (key.upArrow) {
        setOverlay(s => s.kind === "settings" && s.dialog.type === "effort"
          ? { ...s, dialog: { ...s.dialog, selected: clampIndex(s.dialog.selected - 1, options.length) } }
          : s)
        return true
      }
      if (key.downArrow) {
        setOverlay(s => s.kind === "settings" && s.dialog.type === "effort"
          ? { ...s, dialog: { ...s.dialog, selected: clampIndex(s.dialog.selected + 1, options.length) } }
          : s)
        return true
      }
      if (key.return) {
        const value = options[dialog.selected] ?? "auto"
        setThinkEffort(value)
        setOverlay({ kind: "none" })
        return true
      }
      return true
    }

    // ── models / list ──
    if (dialog.phase === "list") {
      if (key.upArrow) {
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "list"
          ? { ...s, dialog: { ...s.dialog, selected: clampIndex(s.dialog.selected - 1, s.dialog.options.length) } }
          : s)
        return true
      }
      if (key.downArrow || key.tab) {
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "list"
          ? { ...s, dialog: { ...s.dialog, selected: clampIndex(s.dialog.selected + 1, s.dialog.options.length) } }
          : s)
        return true
      }
      if (key.backspace || key.delete) {
        setOverlay(s => {
          if (s.kind !== "settings" || s.dialog.type !== "models" || s.dialog.phase !== "list") return s
          const query = s.dialog.query.slice(0, -1)
          return {
            ...s,
            dialog: { ...s.dialog, query, selected: 0, options: buildOptions(query, s.dialog.providerFilter) },
          }
        })
        return true
      }
      if (key.return) {
        const selected = dialog.options[dialog.selected]
        if (!selected) return true
        if (selected.custom) {
          setOverlay(s => ({
            kind: "settings",
            dialog: {
              type: "models",
              phase: "custom",
              providerId: selected.providerId,
              providerName: selected.providerName,
              modelValue: modelSeedFromQuery(dialog.query),
            },
          }))
          return true
        }
        if (!selected.configured) {
          setOverlay(s => ({
            kind: "settings",
            dialog: {
              type: "models",
              phase: "key",
              providerId: selected.providerId,
              providerName: selected.providerName,
              modelId: selected.modelId,
              modelName: selected.modelName,
              keyValue: "",
            },
          }))
          return true
        }
        void runtime.configureModel({ providerId: selected.providerId, modelId: selected.modelId })
          .then(() => {
            store.dispatch({ type: "ui.model_name", name: selected.modelId })
            store.dispatch({ type: "session.started", sessionId: runtime.sessionId, repoRoot: process.cwd(), provider: selected.providerId, model: selected.modelId })
            store.dispatch({ type: "ui.error_line", text: "" })
            store.dispatch({ type: "ui.event_message", kind: "activity", text: `模型已切换：${selected.providerName} / ${selected.modelName}`, minIntervalMs: 0 })
            setOverlay({ kind: "none" })
          })
          .catch(err => {
            const message = cleanAgentError(err instanceof Error ? err.message : String(err))
            setOverlay(s => s.kind === "settings" && s.dialog.type === "models"
              ? { ...s, dialog: { ...s.dialog, error: message } }
              : s)
          })
        return true
      }
      if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
        const inputText = input.replace(/\r?\n/g, "")
        if (!inputText) return true
        setOverlay(s => {
          if (s.kind !== "settings" || s.dialog.type !== "models" || s.dialog.phase !== "list") return s
          const query = `${s.dialog.query}${inputText}`
          return {
            ...s,
            dialog: { ...s.dialog, query, selected: 0, options: buildOptions(query, s.dialog.providerFilter), error: undefined },
          }
        })
        return true
      }
      return true
    }

    // ── models / custom ──
    if (dialog.phase === "custom") {
      if (key.backspace || key.delete) {
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "custom"
          ? { ...s, dialog: { ...s.dialog, modelValue: s.dialog.modelValue.slice(0, -1), error: undefined } }
          : s)
        return true
      }
      if (key.return) {
        const modelId = dialog.modelValue.trim()
        if (!modelId) {
          setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "custom"
            ? { ...s, dialog: { ...s.dialog, error: "请输入模型 ID 后再回车。" } }
            : s)
          return true
        }
        setOverlay(s => ({
          kind: "settings",
          dialog: {
            type: "models",
            phase: "url",
            providerId: dialog.providerId,
            providerName: dialog.providerName,
            modelId,
            modelName: modelId,
            baseUrlValue: "",
            defaultBaseUrl: runtime.config.providers?.[dialog.providerId]?.baseUrl,
          },
        }))
        return true
      }
      if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
        const inputText = input.replace(/\r?\n/g, "")
        if (!inputText) return true
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "custom"
          ? { ...s, dialog: { ...s.dialog, modelValue: `${s.dialog.modelValue}${inputText}`, error: undefined } }
          : s)
        return true
      }
      return true
    }

    // ── models / url ──
    if (dialog.phase === "url") {
      if (key.backspace || key.delete) {
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "url"
          ? { ...s, dialog: { ...s.dialog, baseUrlValue: s.dialog.baseUrlValue.slice(0, -1), error: undefined } }
          : s)
        return true
      }
      if (key.return) {
        const baseUrl = normalizeBaseUrl(dialog.baseUrlValue, dialog.defaultBaseUrl)
        if (!baseUrl) {
          setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "url"
            ? { ...s, dialog: { ...s.dialog, error: "请输入 API URL，例如 https://api.example.com/v1。" } }
            : s)
          return true
        }
        if (!isValidBaseUrl(baseUrl)) {
          setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "url"
            ? { ...s, dialog: { ...s.dialog, error: "URL 必须以 http:// 或 https:// 开头。" } }
            : s)
          return true
        }
        if (dialog.providerId === "custom" || !runtime.isProviderConfigured(dialog.providerId)) {
          setOverlay(s => ({
            kind: "settings",
            dialog: {
              type: "models",
              phase: "key",
              providerId: dialog.providerId,
              providerName: dialog.providerName,
              modelId: dialog.modelId,
              modelName: dialog.modelName,
              keyValue: "",
              custom: true,
              baseUrl,
            },
          }))
          return true
        }
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "url"
          ? { ...s, dialog: { ...s.dialog, error: "正在保存自定义模型..." } }
          : s)
        void runtime.configureModel({
          providerId: dialog.providerId,
          modelId: dialog.modelId,
          custom: true,
          displayName: dialog.modelName,
          baseUrl,
        })
          .then(() => {
            store.dispatch({ type: "ui.model_name", name: dialog.modelId })
            store.dispatch({ type: "session.started", sessionId: runtime.sessionId, repoRoot: process.cwd(), provider: dialog.providerId, model: dialog.modelId })
            store.dispatch({ type: "ui.error_line", text: "" })
            store.dispatch({ type: "ui.event_message", kind: "activity", text: `已保存自定义模型：${dialog.providerName} / ${dialog.modelName}`, minIntervalMs: 0 })
            setOverlay({ kind: "none" })
          })
          .catch(err => {
            const message = cleanAgentError(err instanceof Error ? err.message : String(err))
            setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "url"
              ? { ...s, dialog: { ...s.dialog, error: message } }
              : s)
          })
        return true
      }
      if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
        const inputText = input.replace(/\r?\n/g, "")
        if (!inputText) return true
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "url"
          ? { ...s, dialog: { ...s.dialog, baseUrlValue: `${s.dialog.baseUrlValue}${inputText}`, error: undefined } }
          : s)
        return true
      }
      return true
    }

    // ── models / key ──
    if (dialog.phase === "key") {
      if (key.backspace || key.delete) {
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "key"
          ? { ...s, dialog: { ...s.dialog, keyValue: s.dialog.keyValue.slice(0, -1), error: undefined } }
          : s)
        return true
      }
      if (key.return) {
        const apiKey = dialog.keyValue.trim()
        if (!apiKey) {
          setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "key"
            ? { ...s, dialog: { ...s.dialog, error: "请输入 API key 后再回车。" } }
            : s)
          return true
        }
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "key"
          ? { ...s, dialog: { ...s.dialog, error: "正在保存 key 并切换模型..." } }
          : s)
        void runtime.configureModel({
          providerId: dialog.providerId,
          modelId: dialog.modelId,
          apiKey,
          custom: dialog.custom,
          displayName: dialog.modelName,
          baseUrl: dialog.baseUrl,
        })
          .then(() => {
            store.dispatch({ type: "ui.model_name", name: dialog.modelId })
            store.dispatch({ type: "session.started", sessionId: runtime.sessionId, repoRoot: process.cwd(), provider: dialog.providerId, model: dialog.modelId })
            store.dispatch({ type: "ui.error_line", text: "" })
            store.dispatch({ type: "ui.event_message", kind: "activity", text: `已保存 key，并切换到 ${dialog.providerName} / ${dialog.modelName}`, minIntervalMs: 0 })
            setOverlay({ kind: "none" })
          })
          .catch(err => {
            const message = cleanAgentError(err instanceof Error ? err.message : String(err))
            setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "key"
              ? { ...s, dialog: { ...s.dialog, error: message } }
              : s)
          })
        return true
      }
      if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
        const inputText = input.replace(/\r?\n/g, "")
        if (!inputText) return true
        setOverlay(s => s.kind === "settings" && s.dialog.type === "models" && s.dialog.phase === "key"
          ? { ...s, dialog: { ...s.dialog, keyValue: `${s.dialog.keyValue}${inputText}`, error: undefined } }
          : s)
        return true
      }
      return true
    }

    return true
  }, [overlay, runtime, store, buildOptions, setThinkEffort])

  return { overlay, openModelPicker, openEffort, closeOverlay, updateOverlay, handleSettingsKey }
}
