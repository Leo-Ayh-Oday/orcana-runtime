# 多 Agent 协调层 架构决策记录（ADR）

> 状态：待 M0 基线冻结后逐条填写。
> 每条 ADR 记录：背景 / 决策 / 后果 / 关联阶段。

| ADR | 决策 | 状态 | 关联阶段 |
|---|---|---|---|
| ADR-001 | 条件依赖 `WorkflowDependency{nodeId, when}`；schemaVersion 0.1 字符串依赖 = terminal；0.2 = 条件依赖。接受状态由节点输出 `metadata.acceptance` 显式声明（M1 只解释声明，声明权威在 M7/M9）。未满足条件 → 下游 `blocked` 终态（fail-closed，无死锁） | **已定案 (v0.8.1)** | M1 |
| ADR-002 | Workflow 节点通过 H11 HarnessNode 执行（function/tool/llm_agent/verification/human），禁止旁路 | 待定 | M2 |
| ADR-003 | Worktree 为写操作的唯一真实工作区；写任务禁止降级共享工作区 | 待定 | M3 |
| ADR-004 | 所有权强制走规范化路径 + 实际写入路径二次比对 | 待定 | M3 |
| ADR-005 | 人工等待持久化（interrupt-store + resume-token + 图版本校验） | 待定 | M4 |
| ADR-006 | 合并禁止 later-wins；冲突保留双方产物 → ConflictSet → 裁决 | 待定 | M5 |
| ADR-007 | CompletionCriterion 类型化完成条件；doneCriteria 保留为显示层 | 待定 | M6 |
| ADR-008 | 角色 = 任务内职责标签（PlannerOutput/CoderOutput/ReviewerOutput schema），权限由 Assignment+Policy+Ownership+Worktree+Budget+Approval 决定 | 待定 | M7 |
| ADR-009 | 确定性裁决控制器（CoordinationDecisionController）而非 Meta Agent；hard 条件禁止被评分覆盖 | 待定 | M9 |
| ADR-010 | 置信度只影响策略（加 Reviewer/验证/缩权限），不影响证据与完成 | 待定 | M12 |
