# orcana-cell-init

LR2-4（P4-C）：非特权隔离引导 —— 在 execve 目标程序之前按固定顺序应用
隔离原语（Rust，纯 std 无外部依赖）。

固定顺序（CELL_INIT_ORDER_VIOLATION = 0）：
1. 从受保护 FD（FD 3）读取 CellPlan
2. 校验 schema/digest/授权
3. 关闭未授权 FD
4. rlimits
5. no_new_privs
6. Landlock（LSM 可用时；无则跳过并如实记录）
7. seccomp（可用时；无则跳过并如实记录）
8. cwd + 显式环境
9. execve target

构建/测试：`cargo build && cargo test`
