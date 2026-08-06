# Orcana Runtime Invariants（RC-00）

> 这些是 Runtime 必须成立的不变量。任何修复 PR 必须声明其关闭/强化的 invariant，
> 并附带使 invariant 可验证的失败测试。禁止使用"增加安全检查""优化错误处理"这类
> 无可度量语义的描述。

## V：验证与完成语义

| ID | 不变量 | 度量 |
|---|---|---|
| V-01 | VERIFICATION_NONZERO_EXIT_CANNOT_PASS | tsc/test/build 非零退出在任何路径下不得产生通过证据：0 |
| V-02 | UNAVAILABLE_VERIFICATION_ACCEPTED | 验证器不可用不得入账"通过"（只能 unavailable 诊断）：0 |
| V-03 | BUDGET_EXHAUSTED_COMPLETED | 轮次预算耗尽 ≠ 完成：末轮无通过证据必须 incomplete：0 |
| V-04 | UNEXECUTED_GATE_PASSED | 未执行的 Gate 不得 pass：0 |
| V-05 | FUTURE_TENSE_SKIPS_VERIFICATION | 未来时态词只跳过对应声明句，不得跳过整段真实性检查：0 |
| V-06 | JUDGE_TIMEOUT_COMPLETED | Judge 超时结果 = unavailable，不得 pass：0 |
| V-07 | LSP_DIAGNOSTICS_FRESH_BEFORE_VERDICT | 判定必须基于当前文件版本：0 |
| V-08 | PATCH_FALSE_SUCCESS | apply_patch 阶段 2 未应用不得报告成功：0 |
| V-09 | STATE_MACHINE_MATCHES_TERMINAL_STATE | SM 终态由 CompletionResolution 驱动，预算耗尽不得标 DONE：0 |
| V-10 | NO_MOJIBAKE_IN_MODEL_CONTEXT | 模型上下文不得出现乱码字符串：0 |

## S：安全与权限

| ID | 不变量 | 度量 |
|---|---|---|
| S-01 | PERMISSION_ALIAS_BYPASS | 危险命令经任何工具别名（shell/run_process/run_shell_script/MCP/service）都必须命中相同规则：100% 拒绝 |
| S-02 | INVALID_CONFIG_ALLOW_ALL | 配置损坏必须进入 permission-safe-mode，不得静默退回 allow：0 |
| S-03 | PATH_NORMALIZED_BEFORE_MATCH | 路径比对前必须 resolve/normalize + 符号链接检查：0 |
| S-04 | UNKNOWN_MCP_CAPABILITY_NOT_CONCURRENT_SAFE | 未声明能力的 MCP 工具默认 isReadonly=false / isConcurrencySafe=false：0 |
| S-05 | RIPPLE_GATE_INDEPENDENT_OF_CACHE | ripple 写阻断不受 cacheStableTools 影响：0 |
| S-06 | SECCOMP_DENY_BY_DEFAULT | seccomp 过滤器 defaultAction=ERRNO，仅白名单 syscall 放行：0 |
| S-07 | STRICT_PROFILE_DEGRADED | strict profile（untrusted/evolution/dependency）不得降级：0 |

## E：执行与生命周期

| ID | 不变量 | 度量 |
|---|---|---|
| E-01 | PROFILE_IS_SOLE_AUTHORITY | ProcessExecutor 不硬编码 minimum/allowDegradation，以 profile 默认值为准：0 |
| E-02 | CPU_QUOTA_MICROS_UNIT_CONSISTENT | 全链路统一 µs（1 core=100_000），禁止 /10_000 折算：0 |
| E-03 | ISOLATION_LOCK_WAITS_NOT_THROWS | 锁竞争等待/超时/取消三态，不得抛 EXECUTION_SPEC_INVALID：0 |
| E-04 | BWRAP_NEVER_CHDIR_UNBOUND_WORKSPACE | 无 worktreeRoot 时不得 --chdir /workspace：0 |
| E-05 | WRONG_PROCESS_KILL | pid<=0 任何信号操作必须拒绝：0 |
| E-06 | RECEIPT_CLEANUP_MEASURED | Receipt 清理字段来自实测（orphan 检测/容器检查），不得硬编码：0 |
| E-07 | CGROUP_ATTACH_FAILURE_DEGRADED_NOT_SILENT | attach 失败必须记录 degraded 并进入 Receipt：0 |
| E-08 | ABORT_IGNORED | 所有工具执行必须透传 abortSignal，取消后不得继续运行：0 |
| E-09 | TERMINATE_TREE_NON_BLOCKING | 终止路径不得同步阻塞事件循环（无 Atomics.wait）：0 |
| E-10 | JANITOR_CLEANS_ALL_RUN_RESIDUE | 启动扫描 cgroup/进程/run 目录/临时文件并清理：0 |
| E-11 | RUN_JSON_CELLS_WRITES_CELL_ID | 状态文件 cells 字段必须是 cellId：0 |
| E-12 | SECRET_TEMP_RESIDUE | /tmp seccomp/cidfile/secret 绑定随 cell 清理：0 |
| E-13 | CELL_ID_UNIQUE | cellId 生成不得碰撞：0 |

## D：持久化与恢复

| ID | 不变量 | 度量 |
|---|---|---|
| D-01 | SESSION_MESSAGE_DUPLICATION | 同一会话重复保存 N 次，消息数不变：100 次保存零膨胀 |
| D-02 | SINGLE_SHOT_MODE_PERSISTS | 单次模式结束必须落盘：0 |
| D-03 | CHECKPOINT_USES_REAL_SESSION_ID | checkpoint 写入真实会话：0 |
| D-04 | CHECKPOINT_RESUME_USED | resumeFromCheckpoint 必须被 agentLoop 消费：0 |
| D-05 | EXIT_PATH_FLUSHES_SESSION | 所有退出路径（EOF/SIGINT/单次/异常）走统一 flush：0 |
| D-06 | COMMAND_CTX_READS_CURRENT_SESSION_ID | /save 等命令读到最新 sessionId：0 |
| D-07 | COLD_ARCHIVE_ATOMIC | 归档写 tmp+fsync+rename：0 |
| D-08 | SQLITE_DELETE_CLEANS_WAL_SHM | 删除必须关闭连接并清理 -wal/-shm：0 |

## P：Provider 与工具

| ID | 不变量 | 度量 |
|---|---|---|
| P-01 | DUPLICATE_PROVIDER_SIDE_EFFECT | 已产出文本/tool call 的流不得重试：1000 分片零重复 |
| P-02 | THINKING_BLOCKS_SENT_ONCE | thinking 块只发增量：0 |
| P-03 | RETRY_AFTER_CAPPED | Retry-After 上限 60s：0 |
| P-04 | MCP_REQUEST_CORRELATION | 并发请求按 requestId 关联，退出 rejectAll：1000 并发零串线 |
| P-05 | FIM_HAS_TIMEOUT | FIM 请求必须有超时：0 |
| P-06 | SERVICE_LOG_TAIL_READ | 日志读取不得全量载入内存：0 |
| P-07 | DURATION_MEASURED_FROM_START | 工具 duration 从执行前计时：0 |
| P-08 | EDIT_SYMBOL_IN_TRANSACTION | edit_symbol 必须走 PatchTransaction/freshness：0 |
| P-09 | TOKEN_ESTIMATE_MEANINGFUL | tokenEstimate 按内容估算而非位数：0 |
| P-10 | TIMEOUT_PARSE_GUARDED | timeout 解析失败回退默认值：0 |

## C：上下文与内核

| ID | 不变量 | 度量 |
|---|---|---|
| C-01 | REVISE_PLAN_NEVER_DEADLOCKS | 修订后必须有可达的完成路径（pending 激活）：0 |
| C-02 | NO_ADJACENT_USER_MESSAGES | 消息序列不得出现相邻 user：0 |
| C-03 | NODE_SWITCH_FLUSHES_TEXT | 节点切换前 flush 缓冲文本：0 |
| C-04 | MAINTENANCE_ERRORS_OBSERVABLE | 维护异常必须可观察（record 而非静默 catch）：0 |
| C-05 | USER_CONSTRAINTS_SURVIVE_EVICTION | 用户硬约束（禁止/必须/验收标准）在窗口/epoch 淘汰后仍可恢复：0 |
| C-06 | MICROCOMPACT_PRESERVES_ERROR_LINES | 工具结果压缩保留错误特征行：0 |
| C-07 | STABLE_TOKENS_TRULY_STABLE | cache-anatomy 只把真稳定内容标 stable：0 |
