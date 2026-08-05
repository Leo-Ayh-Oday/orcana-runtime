/** LegacyPlanAdapter — PlanProgress 过渡适配器（Depthline P2）。
 *
 *  非交互计划进度（planning / building / complete）最终归属 Transcript 的
 *  PlanBlock（P4）。P2 期间通过本适配器保持现有 PlanPanel 渲染位置
 *  （footer 顶部、InteractionSlot 之外），P4 删除本文件。
 */

import React from "react"
import { PlanPanel, type TaskProgressState } from "./PlanPanel"

export interface LegacyPlanAdapterProps {
  task: TaskProgressState | null | undefined
  width: number
}

/** 非交互计划显示：仅当有 task 且无交互面抢占时渲染。 */
export const LegacyPlanAdapter = React.memo(function LegacyPlanAdapter({ task, width }: LegacyPlanAdapterProps) {
  if (!task || task.total === 0) return null
  return <PlanPanel task={task} width={width} />
})
