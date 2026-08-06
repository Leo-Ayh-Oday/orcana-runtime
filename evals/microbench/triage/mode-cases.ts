/** ORMB-TR 40 个 Mode 路由 prompt（计划 §9 P2）。
 *
 *  四种 mode 各 10，交叉 needsWeb / riskLevel / 过度路由 / 路由不足 /
 *  表面简单实际跨模块 / 表面复杂只需一行。
 *
 *  Ground Truth：mode + needsWeb + riskLevel。
 */

export interface ModeGT {
  mode: "discussion" | "narrow_edit" | "plan_before_code" | "full_complex"
  needsWeb?: boolean
  riskLevel?: "low" | "medium" | "high"
  /** 期望场景标注：over-trap（过度路由陷阱）/ under-trap（路由不足陷阱）/ web / risk */
  tags: string[]
}

export interface ModeCase {
  caseId: string
  prompt: string
  gt: ModeGT
}

const CASES: ModeCase[] = []
let n = 0
function add(prompt: string, gt: ModeGT): void {
  n++
  CASES.push({ caseId: `TR-${String(n).padStart(2, "0")}`, prompt, gt })
}

// ── discussion（10）──
add("帮我分析一下微服务 vs 单体各自的优劣", { mode: "discussion", riskLevel: "low", tags: ["discussion"] })
add("这个需求该怎么设计数据库表结构，先不写代码", { mode: "discussion", riskLevel: "low", tags: ["discussion"] })
add("解释一下 React 的 useMemo 是干什么的", { mode: "discussion", needsWeb: false, riskLevel: "low", tags: ["discussion", "web"] })
add("帮我评估一下这个技术选型", { mode: "discussion", riskLevel: "low", tags: ["discussion"] })
add("讨论一下我们该不该上 TypeScript", { mode: "discussion", riskLevel: "low", tags: ["discussion"] })
add("这个架构图有什么问题，纯讨论", { mode: "discussion", riskLevel: "medium", tags: ["discussion"] })
add("帮我梳理一下这个模块的职责边界", { mode: "discussion", riskLevel: "low", tags: ["discussion"] })
add("讲讲 OAuth2 的授权码流程", { mode: "discussion", needsWeb: false, riskLevel: "low", tags: ["discussion", "web"] })
add("这个需求要拆成几个阶段比较合理", { mode: "discussion", riskLevel: "low", tags: ["discussion"] })
add("对比一下 Redis 和 Memcached", { mode: "discussion", riskLevel: "low", tags: ["discussion"] })

// ── narrow_edit（10）──
add("把 README 里的拼写错误改掉", { mode: "narrow_edit", riskLevel: "low", tags: ["narrow_edit", "over-trap"] })
add("这个函数名太长了，改成简短的名字", { mode: "narrow_edit", needsWeb: false, riskLevel: "low", tags: ["narrow_edit", "over-trap", "web"] })
add("修一下这个注释", { mode: "narrow_edit", needsWeb: false, riskLevel: "low", tags: ["narrow_edit", "over-trap", "web"] })
add("把按钮颜色从红色改成蓝色，一行 CSS", { mode: "narrow_edit", riskLevel: "low", tags: ["narrow_edit", "over-trap"] })
add("删掉这个没用到的 import", { mode: "narrow_edit", riskLevel: "low", tags: ["narrow_edit", "over-trap"] })
add("把日志级别从 info 改成 warn", { mode: "narrow_edit", needsWeb: false, riskLevel: "low", tags: ["narrow_edit", "web"] })
add("这个变量少了个分号，补上", { mode: "narrow_edit", riskLevel: "low", tags: ["narrow_edit", "over-trap"] })
add("把配置里的端口改成 8080", { mode: "narrow_edit", needsWeb: false, riskLevel: "low", tags: ["narrow_edit", "web"] })
add("重命名这个文件", { mode: "narrow_edit", riskLevel: "low", tags: ["narrow_edit", "over-trap"] })
add("这个报错只是类型标注写错了，改一行就行", { mode: "narrow_edit", riskLevel: "low", tags: ["narrow_edit", "over-trap", "surface"] })

// ── plan_before_code（10）──
add("把项目的构建系统从 webpack 迁移到 vite，先出方案", { mode: "plan_before_code", riskLevel: "medium", tags: ["plan", "under-trap"] })
add("数据库从 MySQL 迁到 PostgreSQL，涉及连接池和 SQL 方言", { mode: "plan_before_code", riskLevel: "high", tags: ["plan", "under-trap"] })
add("给现有系统加权限模块，跨三个服务", { mode: "plan_before_code", riskLevel: "high", tags: ["plan"] })
add("重构这个模块，先规划再动手", { mode: "plan_before_code", riskLevel: "medium", tags: ["plan"] })
add("设计 API 接口规范，需要先定方案", { mode: "plan_before_code", riskLevel: "low", tags: ["plan"] })
add("引入新的状态管理库，先对比再实施", { mode: "plan_before_code", riskLevel: "low", tags: ["plan"] })
add("把这个单体拆成微服务，需要迁移方案", { mode: "plan_before_code", riskLevel: "high", tags: ["plan", "under-trap"] })
add("升级 TypeScript 大版本，需要评估破坏性变更", { mode: "plan_before_code", needsWeb: true, riskLevel: "medium", tags: ["plan", "web"] })
add("加缓存层，需要设计失效策略", { mode: "plan_before_code", riskLevel: "medium", tags: ["plan"] })
add("改数据库 schema，涉及数据迁移脚本", { mode: "plan_before_code", riskLevel: "high", tags: ["plan", "under-trap"] })

// ── full_complex（10）──
add("从零开始写一个带认证的博客系统", { mode: "full_complex", riskLevel: "medium", tags: ["full"] })
add("给公司做一个全栈的数据看板，前端+后端+部署", { mode: "full_complex", riskLevel: "medium", tags: ["full"] })
add("完整重构这个项目，多模块 + 测试覆盖", { mode: "full_complex", riskLevel: "medium", tags: ["full"] })
add("实现一个多租户 SaaS 的骨架，含计费", { mode: "full_complex", riskLevel: "medium", tags: ["full"] })
add("搭建 CI/CD 流水线 + 测试 + 部署", { mode: "full_complex", riskLevel: "medium", tags: ["full"] })
add("写一个实时聊天应用，WebSocket + 消息持久化", { mode: "full_complex", riskLevel: "medium", tags: ["full"] })
add("从零开发一个移动端 + 后端的完整产品", { mode: "full_complex", riskLevel: "medium", tags: ["full"] })
add("做一个权限系统，涉及多角色 + 审计日志", { mode: "full_complex", riskLevel: "high", tags: ["full", "risk"] })
add("迁移整个遗留系统到新架构，全量验证", { mode: "full_complex", riskLevel: "high", tags: ["full", "risk"] })
add("实现一个支付模块，对接第三方支付", { mode: "full_complex", needsWeb: true, riskLevel: "high", tags: ["full", "web", "risk"] })

export const MODE_CASES: ModeCase[] = CASES
