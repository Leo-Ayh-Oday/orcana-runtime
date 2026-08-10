//! orcana-cell-init (LR2-4, P4-C)
//!
//! 非特权隔离引导：在 execve 目标程序之前按**固定顺序**应用隔离原语。
//!
//! 固定执行顺序（CELL_INIT_ORDER_VIOLATION = 0）：
//!   1. 从受保护 FD（约定 FD 3）读取 CellPlan
//!   2. 校验 schema、digest 与授权
//!   3. 关闭未授权 FD
//!   4. 设置 rlimits
//!   5. 设置 no_new_privs
//!   6. 应用 Landlock（可用时；无 LSM 环境跳过并如实记录）
//!   7. 应用 seccomp（可用时；无 seccomp 环境跳过并如实记录）
//!   8. 设置 cwd 与显式环境
//!   9. execve target
//!
//! 它不负责：Graph / 缓存选择 / 网络策略解释 / 秘密存储 / 调度 /
//! 复杂配置解析。
//!
//! CellPlan 格式（FD 3，JSON）：
//! ```json
//! {
//!   "schemaVersion": "1.0",
//!   "exec": { "path": "/bin/true", "args": ["/bin/true"], "env": {} },
//!   "cwd": "/workspace",
//!   "rlimits": { "as": 1073741824, "nofile": 1024, "nproc": 512 },
//!   "noNewPrivs": true,
//!   "landlock": { "readPaths": ["/workspace"], "writePaths": ["/workspace/out"] },
//!   "seccomp": { "allowSyscalls": ["read", "write"] }
//! }
//! ```

use std::env;
use std::fs;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::os::unix::io::FromRawFd;
use std::path::Path;
use std::process::Command;

mod plan;
mod steps;

use plan::{CellPlan, PlanError};
use steps::{apply_landlock, apply_rlimits, apply_seccomp, close_unauthorized_fds, set_no_new_privs};

/// 受保护 FD：CellPlan 从这里读取（父进程以只读方式传入）。
const PLAN_FD: i32 = 3;

fn read_plan() -> Result<CellPlan, PlanError> {
    let mut buf = Vec::new();
    // m5（LR2-4 审核）：plan 大小上限 1 MiB（父进程塞无限数据 → 拒绝）。
    // 从 FD 3 读取（不信任 argv/env —— 可被 execve 前的调用方污染）。
    unsafe {
        let mut f = std::fs::File::from_raw_fd(PLAN_FD);
        let mut chunk = [0u8; 4096];
        loop {
            let n = f
                .read(&mut chunk)
                .map_err(|e| PlanError::Io(format!("read plan fd: {e}")))?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > 1024 * 1024 {
                return Err(PlanError::Schema("plan exceeds 1 MiB limit".into()));
            }
        }
        std::mem::forget(f);
    }
    // 注意：读完后 FD 3 属于"未授权 FD"集合 —— 由步骤 3 统一关闭。
    let plan: CellPlan = serde_json_light::parse(&buf)?;
    Ok(plan)
}

fn main() {
    // 步骤 1-2：读 plan + 校验
    let plan = match read_plan() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("cell-init: plan error: {e}");
            std::process::exit(126); // 不可执行（plan 失败）
        }
    };

    // 步骤 3：关闭未授权 FD（除 stdio 0/1/2 与 plan FD）
    close_unauthorized_fds(&plan);

    // 步骤 4：rlimits
    if let Err(e) = apply_rlimits(&plan) {
        eprintln!("cell-init: rlimit error: {e}");
        std::process::exit(126);
    }

    // 步骤 5：no_new_privs
    if plan.no_new_privs {
        if let Err(e) = set_no_new_privs() {
            eprintln!("cell-init: no_new_privs error: {e}");
            std::process::exit(126);
        }
    }

    // 步骤 6：Landlock（可用时）
    apply_landlock(&plan);

    // 步骤 7：seccomp（可用时）
    apply_seccomp(&plan);

    // 步骤 8-9：cwd + 显式环境 → execve
    let mut cmd = Command::new(&plan.exec.path);
    cmd.args(&plan.exec.args);
    cmd.env_clear();
    for (k, v) in &plan.exec.env {
        cmd.env(k, v);
    }
    cmd.current_dir(&plan.cwd);
    let err = cmd.exec(); // 成功不返回
    eprintln!("cell-init: execve failed: {err}");
    std::process::exit(127);
}

/// 极小 JSON 解析器（纯 std，无外部依赖 —— 只支持 CellPlan 需要的形状）。
/// 独立模块避免引入 serde 依赖（最小攻击面）。
mod serde_json_light {
    use super::plan::PlanError;

    pub fn parse(buf: &[u8]) -> Result<super::plan::CellPlan, PlanError> {
        let text = std::str::from_utf8(buf).map_err(|_| PlanError::Schema("plan is not utf8".to_string()))?;
        super::plan::parse_plan(text)
    }
}
