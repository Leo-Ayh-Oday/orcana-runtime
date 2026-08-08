# LR2-2 性能基线（2026-08-09）

**环境：** linux-x64 / kernel 6.6.87.2-microsoft-standard-WSL2 / bun 1.3.14 / Overlay backend: git-worktree
**生成：** `bun run evals/perf/baseline.ts`（50 采样，p50/p95/avg，ms）

## 指标

| 指标 | p50 | p95 | avg |
|---|---|---|---|
| Plan 编译（冷启动，无缓存） | 0.42 | 0.83 | 0.54 |
| Plan 编译（热启动，缓存命中） | 0.056 | 0.13 | 0.062 |
| **Plan Cache 加速** | **7.4x** | — | — |
| CAS 写入（64KB 对象） | 0.14 | 2.15 | 0.26 |
| CAS 读取 | 0.13 | 0.42 | 0.16 |
| Overlay 创建（git-worktree） | 20.9 | 22.4 | 20.9 |

## 说明

- **先基线后阈值**（计划要求）：当前无硬阈值；后续（LR2-2 Gate WARM_START_REGRESSION）以本基线为参照——热启动不得劣化超过冷启动基线。
- Overlay 为 git-worktree fallback（WSL 无 OverlayFS 权限）；native/fuse 探测链保留（有权限环境自动升级）。
- CAS 大对象（64KB）写读亚毫秒级；p95 受 WSL 磁盘抖动影响。

## 复跑

```bash
bun run evals/perf/baseline.ts
```
