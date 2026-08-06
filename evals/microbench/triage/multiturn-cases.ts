/** ORMB-SR 多轮任务切换（计划 §四必测特殊场景 × 5 组，每组 3 轮）。
 *
 *  计划原文：Turn 1 设计架构 → Turn 2 修复安全漏洞 → Turn 3 只修改 CSS 动效，
 *  检查每轮是否使用正确 Skill，而不是永远继承第一次分诊结果。
 *
 *  当前实现是单会话一次调用的 Circuit Breaker：同一 FlashTriage 实例第 2 轮起
 *  triage() 直接返回 null → 关键词 fallback。本套件同时测"真实行为"（同一实例
 *  连调，模拟真实 loop）与"理想对照"（每轮新实例），量化 breaker 造成的能力损失。
 */

export interface MTRTurn {
  prompt: string
  requiredSkills: string[]
}

export interface MTRCase {
  caseId: string
  title: string
  turns: MTRTurn[]
}

export const MTR_CASES: MTRCase[] = [
  {
    caseId: "MTR-01",
    title: "架构设计 → 安全修复 → CSS 动效",
    turns: [
      { prompt: "帮我设计这个系统的整体架构，对比两个方案", requiredSkills: ["architecture-review"] },
      { prompt: "登录接口有注入漏洞，帮我修复", requiredSkills: ["security-deep-dive"] },
      { prompt: "只改这个按钮的 hover 样式，加个动效", requiredSkills: ["ui-ux-pro-max", "motion-pro-max"] },
    ],
  },
  {
    caseId: "MTR-02",
    title: "方案讨论 → 代码实现 → 边界测试",
    turns: [
      { prompt: "先讨论一下这个功能怎么设计", requiredSkills: [] },
      { prompt: "按刚才的方案把代码写出来", requiredSkills: [] },
      { prompt: "给这个函数写边界测试", requiredSkills: ["edge-case-hunter"] },
    ],
  },
  {
    caseId: "MTR-03",
    title: "模块重构 → 入场动画 → 加载报错",
    turns: [
      { prompt: "重构这个模块，先做架构评审", requiredSkills: ["architecture-review"] },
      { prompt: "给页面加入场动画", requiredSkills: ["motion-pro-max"] },
      { prompt: "页面加载时报错，帮我查一下", requiredSkills: ["systematic-debugging"] },
    ],
  },
  {
    caseId: "MTR-04",
    title: "接口设计 → 安全审查 → 拼写修复",
    turns: [
      { prompt: "设计这套 API 的接口规范", requiredSkills: [] },
      { prompt: "对现有代码做一次安全审查", requiredSkills: ["security-deep-dive"] },
      { prompt: "把文档里的错别字改掉", requiredSkills: [] },
    ],
  },
  {
    caseId: "MTR-05",
    title: "落地页 → 后端接口 → 数据库迁移",
    turns: [
      { prompt: "做这个产品的落地页", requiredSkills: ["ui-ux-pro-max"] },
      { prompt: "写后端接口实现", requiredSkills: [] },
      { prompt: "把数据从 MySQL 迁移到 PostgreSQL", requiredSkills: [] },
    ],
  },
]
