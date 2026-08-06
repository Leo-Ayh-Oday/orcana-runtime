# Reliability 故障注入（RC-00）

独立于 main 测试套件的故障注入入口，与 docs/reliability/gate-matrix.md 联动。

运行：
```bash
bun run evals/reliability/verify-fail-closed.ts
```

## 场景清单（对应 invariants.md 编号）

- V-01/V-02: tsc 非零退出/unavailable 不得 pass（tests/tools/typescript_rc01.test.ts）
- V-03/V-04: 末轮预算耗尽 incomplete（tests/completion_rc02.test.ts）
- V-05: 未来时态按句判定（tests/completion_rc02.test.ts）
- S-01: 进程别名统一禁令（tests/permission_rc04a.test.ts）
- S-02: 配置损坏 safe mode（tests/permission_rc04a.test.ts）
- S-06: seccomp deny-by-default（tests/runtime/linux/backend-facts.test.ts）
- C-01: revisePlan 恢复链（tests/task_tracker_rc13.test.ts）
- C-05/C-06: 约束蒸馏 + 错误行保留（tests/contextguard_rc025.test.ts）
