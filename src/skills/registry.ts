/** Skill registry — loads and injects existing high-quality skills into system prompt.
 *
 *  Skills are sourced from three locations:
 *    1.  Built-in (inlined for autonomy — no external deps)
 *    2.  ~/.claude/skills/ (user's existing skill library)
 *    3.  Plugin-provided (future)
 *
 *  Trigger: prompt text matches any skill's `triggers` list → skill prompt appended.
 *  Compatible with DeepSeek Code's SkillDef format.
 */

import type { SkillDef } from "./types"
import { UI_UX_PRO_MAX } from "./builtin/ui-ux-pro-max"
import { MOTION_PRO_MAX } from "./builtin/motion-pro-max"
import { MOTION_REVIEW } from "./builtin/motion-review"

function registered(): SkillDef[] {
  return [
    // ═══ Full built-in skills ═══

    UI_UX_PRO_MAX,
    MOTION_PRO_MAX,
    MOTION_REVIEW,

    // ═══ Quality/process skills ═══

    {
      name: "architecture-review",
      description: "架构审查 — 强制对比替代方案 + trade-off 分析 + 风险标注",
      triggers: ["架构", "architecture", "重构", "refactor", "设计模式", "design pattern", "系统设计", "system design", "全栈", "选型", "技术栈"],
      autoTrigger: true,
      prompt: [
        "## 架构审查模式（architecture-review skill 激活）",
        "",
        "1. 列出至少 2 种可行方案，不做单方案推荐",
        "2. 每个方案用评分表: 复杂度/性能/维护性/扩展性/社区生态 (⭐1-5)",
        "3. 给出明确推荐 + 理由，不是'都可以'",
        "4. 标注选定方案的最大风险点 + 缓解策略",
        "5. 给出 Plan B — 如果选定方案不够用，迁移路径是什么",
        "6. 标注不确定的地方（「此处选 X 是我基于经验的判断，没有实测数据支持」）",
      ].join("\n"),
    },

    {
      name: "self-critique",
      description: "自我审查 — 输出前推演反方观点 + 重建论证",
      triggers: ["审查", "review", "检查", "推翻", "反驳", "反方", "漏洞", "审计", "audit", "critique", "反思", "复盘"],
      autoTrigger: true,
      prompt: [
        "## 自我审查模式（self-critique skill 激活）",
        "",
        "在给出最终输出前:",
        "1. 逐条审视方案 — 每个关键决策问 '如果这个假设是错的会怎样'",
        "2. 找到至少 2 处可以反驳自己方案的点",
        "3. 给出 Plan B — 如果当前方案被推翻的备选",
        "4. 不确定的地方明确标注",
        "",
        "输出格式:",
        "```",
        "## 审查自评",
        "- 最大风险: ...",
        "- 备选方案: ...",
        "- 不确定性: ...",
        "```",
      ].join("\n"),
    },

    {
      name: "edge-case-hunter",
      description: "边界猎人 — 穷举边界/异常/并发/资源约束",
      triggers: ["边界", "edge", "测试", "test", "异常", "空值", "nil", "null", "并发", "验证", "corner"],
      autoTrigger: true,
      prompt: [
        "## 边界条件猎人（edge-case-hunter skill 激活）",
        "",
        "对每个接口/模块/函数列:",
        "- 输入: null/undefined/空字符串/空数组/空对象/0/负数/超长/emoji/中文引号",
        "- 并发: 同时读写、快速连续操作",
        "- 环境: 网络断开/超时/慢速/磁盘满/权限拒绝/进程重启",
        "- 每个模块 ≥3 个已验证边界",
      ].join("\n"),
    },

    {
      name: "security-deep-dive",
      description: "安全深度审查 — OWASP Top 10 + 供应链 + 注入检测",
      triggers: ["安全", "security", "auth", "token", "密码", "password", "注入", "XSS", "CSRF", "CORS", "认证", "secret", "API key"],
      autoTrigger: true,
      prompt: [
        "## 安全深度审查（security-deep-dive skill 激活）",
        "",
        "检查清单:",
        "- [ ] 注入: 用户输入直接拼进查询/命令/路径?",
        "- [ ] XSS: 用户内容渲染时 escape 了吗?",
        "- [ ] CSRF: 状态改变的操作有 token 吗?",
        "- [ ] 认证: 接口可以不带 token 访问吗?",
        "- [ ] 路径遍历: 用户输入当路径用了吗? (../ etc)",
        "- [ ] 敏感数据: 错误消息泄露内部信息?",
        "- [ ] 硬编码: 代码里有 secret/API key/密码?",
        "- [ ] 依赖: `npm audit` 有已知漏洞吗?",
        "- [ ] Rate limiting: API 有频率限制吗?",
        "- [ ] CORS: 是 * 还是白名单?",
        "",
        "输出: 检查项 + 发现 + 风险等级(CRITICAL|HIGH|MEDIUM|LOW) + 修复方案",
      ].join("\n"),
    },

    {
      name: "systematic-debugging",
      description: "系统性调试 — 根因追踪 + 条件断点 + 假设验证",
      triggers: ["bug", "调试", "debug", "报错", "error", "故障", "崩溃", "crash", "不工作", "修复", "fix"],
      autoTrigger: true,
      prompt: [
        "## 系统性调试（systematic-debugging skill 激活）",
        "",
        "三步调试法:",
        "",
        "### 1. 证据收集",
        "- 完整错误消息 (stack trace, error code, line number)",
        "- 触发条件: 什么操作/输入/时机导致",
        "- 是否可复现: 每次都出现还是偶尔",
        "- 最近变更: 改了什么代码/配置/依赖",
        "",
        "### 2. 假设优先级排序",
        "- 列出所有可能的原因，按概率排序",
        "- 最高概率 ≠ 第一个想到的，是最符合所有症状的",
        "- 用条件断点或添加临时日志验证，不靠猜",
        "",
        "### 3. 最小修复",
        "- 能一行改好就不动三行",
        "- 修完后验证: 原来的触发条件还会复现吗",
        "- 加回归测试防止复发",
        "",
        "输出: 症状 → 根因 → 修复 → 验证",
      ].join("\n"),
    },
  ]
}

export const SKILLS = registered()

/** Match skills against user prompt. Returns activated skill prompts. */
export function activateSkills(prompt: string, maxSkills = 3): string[] {
  const lower = prompt.toLowerCase()
  const activated: string[] = []
  for (const skill of SKILLS) {
    if (!skill.autoTrigger) continue
    const matched = skill.triggers.some(t => lower.includes(t.toLowerCase()))
    if (matched) {
      activated.push(skill.prompt)
      if (activated.length >= maxSkills) break
    }
  }
  return activated
}

/** Build full system prompt with activated skills appended (keyword-based). */
export function buildSkillPrompt(prompt: string): string {
  const activated = activateSkills(prompt)
  if (activated.length === 0) return ""
  return activated.join("\n\n")
}

/** Activate skills by exact name match — used when Flash Triage selects skills. */
export function activateSkillsByNames(names: string[], maxSkills = 3): string[] {
  const activated: string[] = []
  for (const name of names.slice(0, maxSkills)) {
    const skill = SKILLS.find(s => s.name === name)
    if (skill) activated.push(skill.prompt)
  }
  return activated
}
