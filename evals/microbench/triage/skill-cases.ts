/** ORMB-SR 50 个 Skill 路由 prompt（计划 §9 P2）。
 *
 *  技能清单从 registry 动态读取（SKILLS），不在测试里硬编码。
 *  Ground Truth 用 required/optional/forbidden 三分类（计划 §四）：
 *  - required：必须激活
 *  - optional：激活有帮助但非必须
 *  - forbidden：激活即失败（负迁移）
 *
 *  结构：程序化生成（直接匹配 2×7、隐含匹配 1×7、关键词陷阱 2×7）
 *        + 手写（组合 4、近邻混淆 5、No-Skill 6）= 50
 */

import { SKILLS, type SkillDef } from "../../../src/skills/registry"

export interface SkillGT {
  required: string[]
  optional: string[]
  forbidden: string[]
}

export interface SkillCase {
  caseId: string
  prompt: string
  gt: SkillGT
  tags: string[]
}

/** autoTrigger 技能（关键词路径只会激活这些）。motion-review 是手动触发。 */
export const AUTO_SKILLS: SkillDef[] = SKILLS.filter((s) => s.autoTrigger)

/** 每个技能的行为描述（用于隐含匹配句的生成）。 */
const ACTION: Record<string, string> = {
  "ui-ux-pro-max": "提升界面的视觉质感",
  "motion-pro-max": "做页面动效",
  "architecture-review": "评审系统架构",
  "self-critique": "审查方案",
  "edge-case-hunter": "检查边界情况",
  "security-deep-dive": "做安全审查",
  "systematic-debugging": "调试",
}

const CASES: SkillCase[] = []
let n = 0
function add(prompt: string, gt: SkillGT, tags: string[]): void {
  n++
  CASES.push({ caseId: `SR-${String(n).padStart(2, "0")}`, prompt, gt, tags })
}

// ── 1) 直接明确匹配：每技能 2 条（用 triggers 词构造） ──
// 注意 forbidden 不设"所有其他技能"：触发词天然交叠（如"页面"也命中 ui-ux、
// "审查"也命中 self-critique），direct 用例只测 required 召回。
for (const skill of AUTO_SKILLS) {
  const t = skill.triggers
  add(`帮我${ACTION[skill.name] ?? "处理"}，主要涉及${t[0]}方面的内容`, { required: [skill.name], optional: [], forbidden: [] }, ["direct", skill.name])
  add(`这个任务需要${t[1] ?? t[0]}，${ACTION[skill.name] ?? "请处理"}一下`, { required: [skill.name], optional: [], forbidden: [] }, ["direct", skill.name])
}

// ── 2) 语义隐含匹配：每技能 1 条（无 trigger 词，靠语义） ──
const IMPLICIT: Array<{ skill: string; prompt: string }> = [
  { skill: "ui-ux-pro-max", prompt: "这个页面看起来太简陋了，帮我提升一下它的视觉档次" },
  { skill: "motion-pro-max", prompt: "给这个网站加一些交互反馈效果，让操作更有节奏感" },
  { skill: "architecture-review", prompt: "我们在两个方案之间犹豫，帮我分析一下哪个更合适" },
  { skill: "self-critique", prompt: "帮我从反方角度挑挑这个设计的毛病" },
  { skill: "edge-case-hunter", prompt: "这个接口可能会收到各种奇怪的输入，帮我考虑周全" },
  { skill: "security-deep-dive", prompt: "这个登录功能做得靠谱吗，帮我检查一下" },
  { skill: "systematic-debugging", prompt: "程序时不时就卡住，帮我查一下原因" },
]
for (const { skill, prompt } of IMPLICIT) {
  // 隐含匹配：无触发词，关键词路径按设计激活不了——只测语义路径（run.ts 里跳过关键词断言）
  add(prompt, { required: [skill], optional: [], forbidden: [] }, ["implicit", skill])
}

// ── 3) 关键词陷阱：包含 trigger 词但任务无关 → 不应激活（每技能 2 条） ──
const TRAPS: Array<{ skill: string; prompts: string[] }> = [
  {
    skill: "ui-ux-pro-max",
    prompts: [
      "写一封关于 CSS 历史的科普邮件",
      "帮我把这段 HTML 导出成 PDF",
    ],
  },
  {
    skill: "motion-pro-max",
    prompts: [
      "给这篇动画电影写一篇影评",
      "翻译一下 motion 这个词在不同语境下的含义",
    ],
  },
  {
    skill: "architecture-review",
    prompts: [
      "把这个文档里的 architecture 单词全部替换成 structure",
      "整理一份关于设计模式的读书笔记",
    ],
  },
  {
    skill: "self-critique",
    prompts: [
      "把 review 这个词翻译成中文",
      "给这篇文章写一个摘要，不用评价好坏",
    ],
  },
  {
    skill: "edge-case-hunter",
    prompts: [
      "帮我把测试报告整理成表格",
      "这周的空值率统计报表帮我核对一下",
    ],
  },
  {
    skill: "security-deep-dive",
    prompts: [
      "README 里出现了 security 这个单词，帮我翻译这个文件",
      "把这篇文章里的 token 全部替换成占位符",
    ],
  },
  {
    skill: "systematic-debugging",
    prompts: [
      "别修 bug，把这段报错日志存档就行",
      "把 crash 这个英文单词在代码注释里的用法列出来",
    ],
  },
]
for (const { skill, prompts } of TRAPS) {
  for (const prompt of prompts) {
    add(prompt, { required: [], optional: [], forbidden: [skill] }, ["trap", skill])
  }
}

// ── 4) 多技能组合：required ≥ 2（计划 §四：多个 Skill 冲突场景） ──
add("做一个带动效的落地页，配色和排版都好看点", { required: ["ui-ux-pro-max", "motion-pro-max"], optional: [], forbidden: [] }, ["combo"])
add("调试这个 bug，顺便从反方角度审查一下我的方案", { required: ["systematic-debugging", "self-critique"], optional: [], forbidden: [] }, ["combo"])
add("重构这个模块，先做架构评审再动手", { required: ["architecture-review"], optional: ["self-critique"], forbidden: [] }, ["combo"])
add("安全审查这个登录模块，重点看注入和边界情况", { required: ["security-deep-dive", "edge-case-hunter"], optional: [], forbidden: [] }, ["combo"])

// ── 5) 近邻混淆：容易选错的相邻任务 ──
add("这段报错日志为什么偶尔出现", { required: ["systematic-debugging"], optional: [], forbidden: [] }, ["confusable"])
add("检查这个函数在并发下的行为", { required: ["edge-case-hunter"], optional: ["self-critique"], forbidden: [] }, ["confusable"])
add("给按钮加个弹跳效果", { required: ["ui-ux-pro-max", "motion-pro-max"], optional: [], forbidden: [] }, ["confusable"])
add("帮我修这个拼写错误", { required: [], optional: [], forbidden: [] }, ["confusable", "no-skill"])
add("这个登录接口老是被绕过，帮我看看", { required: ["security-deep-dive"], optional: [], forbidden: [] }, ["confusable", "implicit"])

// ── 6) No-Skill：40 条计划的 P2 子集（6 条） ──
add("把昨天的会议记录整理成要点", { required: [], optional: [], forbidden: [] }, ["no-skill"])
add("帮我写一首关于秋天的诗", { required: [], optional: [], forbidden: [] }, ["no-skill"])
add("这个表格怎么导入 Excel", { required: [], optional: [], forbidden: [] }, ["no-skill"])
add("给我推荐三本编程书", { required: [], optional: [], forbidden: [] }, ["no-skill"])
add("帮我把这段文字翻译成英文", { required: [], optional: [], forbidden: [] }, ["no-skill"])
add("设置一个 8 点的闹钟提醒", { required: [], optional: [], forbidden: [] }, ["no-skill"])

export const SKILL_CASES: SkillCase[] = CASES
