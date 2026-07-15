import { addNode, planProgress, planRef, removeNode, skipNode } from "../agent/master-plan"
import type { ToolDef } from "./registry"

const REQUEST_DEEPER_THINKING: ToolDef = {
  name: "request_deeper_thinking",
  description:
    "当你发现当前推理不足以解决此问题、需要更大的思考预算时调用。" +
    "如果问题涉及架构决策、安全审查、跨文件影响、多层抽象或需要穷举边界条件，说明理由。" +
    "触发后下一轮将升级到 think-max 32K tokens。",
  isReadonly: true,
  isConcurrencySafe: true,
  userFacingName: "更深思考",
  contract: {
    sideEffects: ["runtime_state"],
    stateUpdates: ["runtime_state"],
  },
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么需要更深推理（架构/安全/跨文件/多抽象层/边界穷举）" },
    },
    required: ["reason"],
  },
  execute: async (_params: Record<string, unknown>) => {
    return { success: true, content: "下一轮将使用 thinking max 32K tokens 深度推理。", metadata: { upgradeThinking: "max" } }
  },
}

const TASK_TOOL: ToolDef = {
  name: "task",
  description:
    "管理主计划的任务树。当一个长任务被分解为多个阶段时，用它追踪进度。\n" +
    "\n" +
    "## 什么时候用它\n" +
    "- 任务涉及 3+ 个独立交付阶段（如「后端→前端→测试」）\n" +
    "- 执行中发现新的必须完成的子任务，但不在当前计划里\n" +
    "- 某个阶段发现没必要做了，需要从计划中移除\n" +
    "- 完成一个阶段后，想查看整体进度决定下一步\n" +
    "\n" +
    "## 操作\n" +
    "- list: 查看所有节点和状态\n" +
    "- add: 新增节点。参数 title（标题）, depends_on（依赖哪个节点 ID，可选）\n" +
    "- done: 标记完成。参数 node_id, reason（完成了什么，可选）\n" +
    "- remove: 删除不需要的节点。参数 node_id, reason（为什么不需要）\n" +
    "- skip: 跳过不做的节点。参数 node_id, reason",
  isReadonly: false,
  isConcurrencySafe: false,
  userFacingName: "任务管理",
  contract: {
    sideEffects: ["runtime_state"],
    stateUpdates: ["runtime_state"],
  },
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", description: "list | add | done | remove | skip" },
      title: { type: "string", description: "add 时的节点标题" },
      node_id: { type: "string", description: "done/remove/skip 时的节点 ID" },
      depends_on: { type: "string", description: "add 时的依赖节点 ID（逗号分隔，可选）" },
      reason: { type: "string", description: "done/remove/skip 时的原因或证据" },
    },
    required: ["operation"],
  },
  execute: async (params: Record<string, unknown>) => {
    const plan = planRef.current
    if (!plan) return { success: false, content: "没有活跃的主计划。长任务启动后主计划会自动创建。", error: "no active plan" }

    const op = String(params.operation ?? "")
    switch (op) {
      case "list": {
        const nodes = plan.nodes.map(n => {
          const icon = { pending: "🔵", active: "🔄", blocked: "🟡", done: "✅", skipped: "❌" }[n.status]
          return `${icon} ${n.id}. ${n.title}${n.dependsOn.length ? ` (依赖: ${n.dependsOn.join(", ")})` : ""}${n.evidence ? ` — ${n.evidence}` : ""}`
        })
        return { success: true, content: `主计划: ${planProgress(plan)}\n\n${nodes.join("\n")}` }
      }
      case "add": {
        const title = String(params.title ?? "").trim()
        if (!title) return { success: false, content: "add 需要 title 参数", error: "missing title" }
        const deps = String(params.depends_on ?? "").split(",").map(s => s.trim()).filter(Boolean)
        const node = addNode(plan, title, deps)
        return { success: true, content: `已添加节点 ${node.id}. ${title}${deps.length ? ` (依赖: ${deps.join(", ")})` : ""}` }
      }
      case "done": {
        const id = String(params.node_id ?? "")
        if (!id) return { success: false, content: "done 需要 node_id 参数", error: "missing node_id" }
        const node = plan.nodes.find(n => n.id === id)
        if (!node) return { success: false, content: `节点 ${id} 不存在`, error: "not found" }
        node.status = "done"
        node.evidence = String(params.reason ?? "")
        plan.updatedAt = Date.now()
        return { success: true, content: `节点 ${id}. ${node.title} 已标记完成。${node.evidence ? `证据: ${node.evidence}` : ""}` }
      }
      case "remove": {
        const id = String(params.node_id ?? "")
        const reason = String(params.reason ?? "")
        const ok = removeNode(plan, id, reason)
        return ok
          ? { success: true, content: `节点 ${id} 已删除。${reason ? `原因: ${reason}` : ""}` }
          : { success: false, content: `无法删除节点 ${id}（不存在或已完成）`, error: "cannot remove" }
      }
      case "skip": {
        const id = String(params.node_id ?? "")
        const reason = String(params.reason ?? "")
        const ok = skipNode(plan, id, reason)
        return ok
          ? { success: true, content: `节点 ${id} 已跳过。${reason ? `原因: ${reason}` : ""}` }
          : { success: false, content: `无法跳过节点 ${id}（不存在或已完成）`, error: "cannot skip" }
      }
      default:
        return { success: false, content: `未知操作: ${op}。支持: list | add | done | remove | skip`, error: "unknown operation" }
    }
  },
}

export const META_BUILTIN_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  TASK_TOOL,
  REQUEST_DEEPER_THINKING,
])
