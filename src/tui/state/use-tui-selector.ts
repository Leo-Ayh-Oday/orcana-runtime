/** use-tui-selector — 订阅切片化基础（Depthline P1）。
 *
 *  与顶层 useSyncExternalStore 订阅不同，组件通过 selector 订阅自己的
 *  数据切片；selector 结果在内部缓存，字段未变化时返回同一引用，
 *  因此与调用方无关的 store 更新不会触发该组件重渲染。
 *
 *  API：
 *    const messages = useTuiSelector(store, s => s.messages)
 *    const status   = useTuiSelector(store, s => s.status)
 *    // 组合对象需显式 shallowEqual：
 *    const slice = useTuiSelector(store, s => ({ a: s.a, b: s.b }), shallowEqual)
 *
 *  createSelectorSnapshot 为纯函数，便于脱离 React 单元测试。
 */

import { useMemo, useSyncExternalStore } from "react"
import type { TuiStore } from "./tui-store"
import type { TuiState } from "./types"
import { renderMetrics } from "../render-metrics"

export type TuiSelector<T> = (state: TuiState) => T

/** 缓存最近一次 selector 结果；字段未变时返回同一引用（Object.is 默认）。 */
export function createSelectorSnapshot<T>(
  store: TuiStore,
  selector: TuiSelector<T>,
  isEqual: (a: T, b: T) => boolean = Object.is,
): () => T {
  let initialized = false
  let selected: T | undefined

  return () => {
    const next = selector(store.getState())
    if (!initialized || !isEqual(selected as T, next)) {
      selected = next
      initialized = true
    }
    renderMetrics.incSelectorNotification()
    return selected as T
  }
}

/** 数组/对象浅比较，供组合 selector 显式使用。 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  const keysA = Object.keys(a as object)
  const keysB = Object.keys(b as object)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

/** 订阅 store 数据切片。selector 需稳定（模块级函数或 useMemo）。 */
export function useTuiSelector<T>(
  store: TuiStore,
  selector: TuiSelector<T>,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const getSnapshot = useMemo(
    () => createSelectorSnapshot(store, selector, isEqual),
    [store, selector, isEqual],
  )
  return useSyncExternalStore(
    (onChange: () => void) => store.subscribe(onChange),
    getSnapshot,
    getSnapshot,
  )
}
