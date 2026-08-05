# 多 Agent 协调层 验收矩阵

> 状态：待各阶段实施时逐项更新。
> 每阶段验收门对照 MACP-1.0 execution-plan.md 第六节。

| 阶段 | 验收门 | 状态 | 证据 |
|---|---|---|---|
| M1 | DEPENDENCY_SEMANTICS / LEGACY_SPEC_COMPATIBILITY / FAILED_UPSTREAM_LEAK=0 | **PASS (v0.8.1)** | dependency-conditions.test.ts 16 项：条件判定单测 5 + scheduler 条件 9 + legacy 兼容 2 + checkpoint 恢复一致 1；全量门禁 832 pass |
| M2 | H11_ADAPTER / KERNEL_DIFF=0 / DIRECT_LLM_BYPASS=0 / DIRECT_TOOL_BYPASS=0 | **PASS (v0.8.2)** | harness-adapter.test.ts 14 项：llm_agent→LlmAgentNode（文本+usage）、tool→CapabilityRegistry（usage.toolCalls）、verification→evidence 绑定、human→interrupt、取消传递、预算结构化结果、fail-closed（无 env/无 loopDeps）、readonly 写保护、M1 组合；全量门禁 846 pass；kernel diff 0 |
| M3 | UNOWNED_WRITE=0 / WORKTREE_ESCAPE=0 / SHARED_WORKSPACE_MULTI_WRITE=0 / SINGLE_AGENT_REGRESSION=0 | **PASS (v0.8.3)** | ownership.test.ts 12 项：owned 写通过 / 他人文件拒绝 / declared≠actual 拒绝 / ../ 逃逸拒绝 / symlink 逃逸拒绝 / 绝对路径绕过拒绝 / planner 不可写 / 双 agent 独立 worktree 写入且主工作区不变 / 运行结束 dispose / 崩溃遗留检测 / 无 pool 与未分配节点旧行为不变；全量门禁 858 pass |
| M4 | PERSISTENT_INTERRUPT / DOUBLE_RESUME=0 / STALE_RESUME_ACCEPTED=0 / PROCESS_BOUND_WAITING=0 | 待做 | — |
| M5 | AUTOMATIC_CONFLICT_OVERWRITE=0 / POST_MERGE_VERIFICATION / PARTIAL_INTEGRATION=0 | 待做 | — |
| M6 | PLAN_CONTRACT_SCHEMA / HARD_CRITERION_BYPASS=0 / FAKE_DETERMINISTIC_CHECK=0 | 待做 | — |
| M7 | ROLE_OUTPUT_SCHEMA / SELF_APPROVAL=0 / ROLE_AUTHORITY_LEAK=0 | 待做 | — |
| M8 | STATIC_MULTI_AGENT_PIPELINE / PLANNER_FAILURE_CODER_START=0 / UNVERIFIED_MERGE_ACCEPTED=0 / SINGLE_AGENT_DEFAULT_CHANGED=0 | 待做 | — |
| M9 | DETERMINISTIC_ADJUDICATION / HARD_VETO_BYPASS=0 / EVIDENCE_BYPASS=0 | 待做 | — |
| M10 | 生产指标 10 项全 0 + 30 必测场景 + 冻结门禁 | 待做 | — |
