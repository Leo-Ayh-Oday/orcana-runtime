export type IntentMode = "readonly" | "narrow_edit" | "long_task"

export interface IntentPolicy {
  mode: IntentMode
  reason: string
}

const NO_WRITE_PATTERNS = [
  /不要(?:动手|修改|写|执行|改|落地)/i,
  /先(?:别|不要)(?:动手|修改|写|执行|改|落地)/i,
  /不(?:动|改|写)(?:代码|文件)?/i,
  /只(?:讨论|分析|评估|看看|看|读|审查)/i,
  /仅(?:讨论|分析|评估|看看|看|读|审查)/i,
  /do\s+not\s+(?:edit|write|modify|change|execute)/i,
  /no\s+(?:edit|write|modify|changes?)/i,
  /read[-\s]?only/i,
  /不(?:需要|必|用|打算)(?:实现|写|修改|执行|改|做|动)/i,
]

const DISCUSSION_PATTERNS = [
  /讨论/i,
  /评估/i,
  /分析/i,
  /看看/i,
  /看一下/i,
  /审查/i,
  /方案/i,
  /计划/i,
  /架构/i,
  /怎么(?:做|办|优化)/i,
  /聊(?:一下|聊)?/i,
  /review/i,
  /plan/i,
  /discuss/i,
  /analy[sz]e/i,
]

const EXECUTE_PATTERNS = [
  /实现/i,
  /修复/i,
  /改掉/i,
  /修改/i,
  /写(?:代码|一个|入)?/i,
  /执行/i,
  /落地/i,
  /直接(?:做|改|写|实现)/i,
  /implement/i,
  /fix/i,
  /edit/i,
  /write/i,
  /change/i,
  /跑(?:一下|一次|个)?/i,
  /运行/i,
]

const LONG_TASK_PATTERNS = [
  /完整项目/i,
  /全栈/i,
  /从零/i,
  /个人博客/i,
  /前端.*后端/i,
  /后端.*前端/i,
  /多个页面/i,
  /带测试/i,
  /创建.*项目/i,
  /实现.*系统/i,
  /full[-\s]?stack/i,
  /complete\s+(?:small\s+)?project/i,
  /from scratch/i,
  /frontend.*backend/i,
  /backend.*frontend/i,
  /react.*vite/i,
  /personal blog/i,
]

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

export function classifyIntent(prompt: string): IntentPolicy {
  const text = prompt.trim()
  if (!text) return { mode: "readonly", reason: "empty prompt" }

  const noWrite = matchesAny(text, NO_WRITE_PATTERNS)
  const discussion = matchesAny(text, DISCUSSION_PATTERNS)
  const execute = matchesAny(text, EXECUTE_PATTERNS)
  const longTask = matchesAny(text, LONG_TASK_PATTERNS)

  if (noWrite) return { mode: "readonly", reason: "explicit no-write request" }
  if (discussion && !execute) return { mode: "readonly", reason: "discussion/planning request" }
  if (longTask) return { mode: "long_task", reason: "multi-step project request" }

  return { mode: "narrow_edit", reason: execute ? "explicit execution request" : "default execution mode" }
}
