# Reliability Gate Matrix（RC-00）

> 每个 RC 的硬门槛。值为允许的最大违规数；超出即门禁红。
> 本地门禁：`bun run typecheck / test / build / eval:linux / bench:mini / git diff --check`。

## P0 Gate（必须全零）

| Gate | 含义 | 覆盖 defect | 当前值 | 目标 |
|---|---|---|---|---|
| FALSE_VERIFICATION_PASS | 验证非零退出/不可用被记为通过 | A1 A2 | 0 | 0 |
| UNAVAILABLE_EVIDENCE_ACCEPTED | unavailable 入账通过证据 | A2 | 0 | 0 |
| BUDGET_EXHAUSTED_COMPLETED | 末轮无证据按完成结束 | A4 | 0 | 0 |
| UNEXECUTED_GATE_PASSED | 未执行 gate 直接放行 | A4 | 0 | 0 |
| FUTURE_TENSE_SKIPS_VERIFICATION | 未来时态整段跳过真实性检查 | A3 | 0 | 0 |
| PATCH_FALSE_SUCCESS | apply_patch 阶段2 未应用报成功 | G1 | 0 | 0 |
| PERMISSION_ALIAS_BYPASS | 危险命令经工具别名绕过禁令 | B1 | 0 | 0 |
| INVALID_CONFIG_ALLOW_ALL | 配置损坏静默放行 | B2 | 0 | 0 |
| STRICT_PROFILE_DEGRADED | strict profile 静默降级 | C1 | TBD | 0 |
| ORPHAN_PROCESS | 清理后进程残留 | F4 | TBD | 0 |
| WRONG_PROCESS_KILL | pid<=0 信号操作 | F7 | TBD | 0 |
| ABORT_IGNORED | 取消后进程继续运行 | F2 | TBD | 0 |
| SECRET_TEMP_RESIDUE | /tmp 临时资源残留 | C5 | TBD | 0 |
| DUPLICATE_PROVIDER_SIDE_EFFECT | 流重试重复输出 | G3 | TBD | 0 |
| SESSION_MESSAGE_DUPLICATION | 会话保存消息膨胀 | D1 | TBD | 0 |
| CHECKPOINT_RESUME_UNUSED | checkpoint 恢复未接线 | D4 | TBD | 0 |

## 状态记录

| RC | 完成提交 | 门禁结果 | 新 Gate 值 |
|---|---|---|---|
| RC-01 | 13ff6f2 | 3162/254 全绿 | FALSE_VERIFICATION_PASS=0, UNAVAILABLE_EVIDENCE_ACCEPTED=0 |
| RC-02 | 80d2245 | 同基线 | BUDGET_EXHAUSTED_COMPLETED=0, FUTURE_TENSE_SKIPS_VERIFICATION=0 |
| RC-02.5 | 0874f8c | 同基线 | — |
| RC-03 | d122ee2 | 同基线 | PATCH_FALSE_SUCCESS=0 |
| RC-04a | 5f52dba | 同基线 | PERMISSION_ALIAS_BYPASS=0, INVALID_CONFIG_ALLOW_ALL=0 |
| RC-04b | 083ed83 | 同基线 | — |
| RC-05 | 898f5f7 | 同基线 | — |
| RC-06 | fe9bff8 | runtime/linux 组 162 全绿 | SECCOMP_DENY_BY_DEFAULT=0 |
| RC-13 | dd820c9 | 31 相关测试全绿 | REVISE_PLAN_NEVER_DEADLOCKS=0 |

TBD 项随对应 RC（RC-07~12, RC-14~17）落地后回填。
