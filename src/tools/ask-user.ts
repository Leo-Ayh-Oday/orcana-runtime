/** AskUser tool — structured user questions initiated by the model.
 *
 *  Allows the model to ask the user clarifying questions during execution.
 *  Unlike the clarification system (which is automatic), this is model-initiated.
 *
 *  Design:
 *    - Model calls ask_user with a question and optional options
 *    - Tool returns metadata with pendingQuestion
 *    - TUI detects this and pauses agent loop, showing the question
 *    - User's answer is injected as the next user message
 *    - Agent continues execution
 *
 *  Use cases:
 *    - Clarify ambiguous requirements
 *    - Confirm destructive operations
 *    - Choose between multiple approaches
 *    - Get user preference on implementation details
 */

import type { ToolDef } from "./registry"
import { Result } from "./registry"

export interface AskUserQuestion {
  question: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

export const ASK_USER_TOOL: ToolDef = {
  name: "ask_user",
  description:
    "向用户提问，获取澄清或确认。\n" +
    "\n" +
    "## 什么时候用它\n" +
    "- 需求不明确，需要澄清\n" +
    "- 有多个可行方案，需要用户选择\n" +
    "- 即将执行破坏性操作，需要确认\n" +
    "- 需要了解用户偏好\n" +
    "\n" +
    "## 参数\n" +
    "- question: 问题内容（必需）\n" +
    "- options: 选项列表（可选）。每个选项有 label 和 description\n" +
    "- multiSelect: 是否允许多选（可选，默认 false）\n" +
    "\n" +
    "## 行为\n" +
    "- 如果没有 options，用户可以直接回答（开放式问题）\n" +
    "- 如果有 options，用户从选项中选择一个（或多个，如果 multiSelect=true）\n" +
    "- 工具会暂停执行，等待用户回答\n" +
    "- 用户的回答会作为下一条消息注入\n" +
    "\n" +
    "## 示例\n" +
    "ask_user({ question: \"使用哪个数据库？\", options: [{ label: \"SQLite\", description: \"轻量级，适合原型\" }, { label: \"PostgreSQL\", description: \"功能强大，适合生产\" }] })",
  isReadonly: true,
  isConcurrencySafe: true,
  userFacingName: "询问用户",
  contract: {
    sideEffects: ["runtime_state"],
    stateUpdates: ["runtime_state"],
  },
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "问题内容",
      },
      options: {
        type: "array",
        description: "选项列表（可选）",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "选项标签" },
            description: { type: "string", description: "选项描述（可选）" },
          },
          required: ["label"],
        },
      },
      multiSelect: {
        type: "boolean",
        description: "是否允许多选（默认 false）",
      },
    },
    required: ["question"],
  },
  execute: async (params: Record<string, unknown>) => {
    const question = String(params.question ?? "").trim()
    if (!question) {
      return Result.fail("question 参数不能为空")
    }

    const options = Array.isArray(params.options) ? params.options : undefined
    const multiSelect = Boolean(params.multiSelect)

    // Validate options if provided
    if (options) {
      if (options.length === 0) {
        return Result.fail("options 不能为空数组")
      }
      if (options.length > 4) {
        return Result.fail("options 最多 4 个选项")
      }
      for (const opt of options) {
        if (!opt || typeof opt !== "object" || !("label" in opt)) {
          return Result.fail("options 格式错误：每个选项必须有 label 字段")
        }
      }
    }

    // Return special metadata to signal TUI to pause and ask user
    return Result.ok(
      `等待用户回答: ${question}`,
      {
        pendingQuestion: {
          question,
          options: options?.map((opt: any) => ({
            label: String(opt.label),
            description: opt.description ? String(opt.description) : undefined,
          })),
          multiSelect,
        } satisfies AskUserQuestion,
      },
    )
  },
}
