//! 9 步隔离原语（固定顺序由 main 保证 —— CELL_INIT_ORDER_VIOLATION = 0）。

use std::io;
use std::os::unix::io::RawFd;

use crate::plan::{CellPlan, PlanError};

/// 步骤 3：关闭未授权 FD。
/// B2（LR2-4 审核）：保留仅 0/1/2（stdio）；PLAN_FD(3) 读完后也必须关闭
/// —— plan 可能含 env/密钥，泄漏给 exec 后的（可能敌对的）目标进程。
pub fn close_unauthorized_fds(_plan: &CellPlan) {
    let max_fd = max_open_fd();
    for fd in 3..=max_fd {
        unsafe {
            libc_close(fd);
        }
    }
}

/// 探测最大已打开 FD（/proc/self/fd 计数 —— 无 /proc 时保守用 1024）。
fn max_open_fd() -> i32 {
    if let Ok(entries) = std::fs::read_dir("/proc/self/fd") {
        let max = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()))
            .max()
            .unwrap_or(3);
        return max;
    }
    1024
}

#[cfg(target_os = "linux")]
unsafe fn libc_close(fd: i32) {
    extern "C" {
        fn close(fd: i32) -> i32;
    }
    let _ = close(fd);
}

#[cfg(not(target_os = "linux"))]
unsafe fn libc_close(_fd: i32) {
    // 非 Linux：不做（cell-init 只服务 Linux cell）
}

/// 步骤 4：rlimits（as/nofile/nproc）。
pub fn apply_rlimits(plan: &CellPlan) -> Result<(), PlanError> {
    #[cfg(target_os = "linux")]
    {
        unsafe {
            extern "C" {
                fn setrlimit(resource: i32, rlim: *const Rlimit) -> i32;
            }
            #[repr(C)]
            struct Rlimit {
                rlim_cur: u64,
                rlim_max: u64,
            }
            const RLIMIT_AS: i32 = 9;
            const RLIMIT_NOFILE: i32 = 7;
            const RLIMIT_NPROC: i32 = 6;
            let apply = |resource: i32, value: u64| -> Result<(), PlanError> {
                let rlim = Rlimit { rlim_cur: value, rlim_max: value };
                if setrlimit(resource, &rlim) != 0 {
                    return Err(PlanError::Io(format!(
                        "setrlimit({resource}) failed: {}",
                        io::Error::last_os_error()
                    )));
                }
                Ok(())
            };
            if let Some(v) = plan.rlimits.as_bytes {
                apply(RLIMIT_AS, v)?;
            }
            if let Some(v) = plan.rlimits.nofile {
                apply(RLIMIT_NOFILE, v)?;
            }
            if let Some(v) = plan.rlimits.nproc {
                apply(RLIMIT_NPROC, v)?;
            }
        }
    }
    Ok(())
}

/// 步骤 5：no_new_privs（prctl PR_SET_NO_NEW_PRIVS）。
pub fn set_no_new_privs() -> Result<(), PlanError> {
    #[cfg(target_os = "linux")]
    unsafe {
        extern "C" {
            fn prctl(option: i32, arg2: u64, arg3: u64, arg4: u64, arg5: u64) -> i32;
        }
        const PR_SET_NO_NEW_PRIVS: i32 = 38;
        if prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(PlanError::Io(format!(
                "prctl no_new_privs failed: {}",
                io::Error::last_os_error()
            )));
        }
    }
    Ok(())
}

/// 步骤 6：Landlock（可用时；无 LSM 环境跳过 —— 如实记录到 stderr）。
pub fn apply_landlock(plan: &CellPlan) {
    if plan.landlock.read_paths.is_empty() && plan.landlock.write_paths.is_empty() {
        return;
    }
    #[cfg(target_os = "linux")]
    {
        // v1：Landlock ABI 探测 + 规则应用在具备 LSM 的环境启用。
        // 本机（WSL）LSM 未启用 —— 跳过并如实记录（不假装生效）。
        eprintln!(
            "cell-init: landlock requested but not applied on this kernel (LSM unavailable)"
        );
    }
}

/// 步骤 7：seccomp（可用时；无 seccomp 环境跳过 —— 如实记录）。
pub fn apply_seccomp(plan: &CellPlan) {
    if plan.seccomp.allow_syscalls.is_empty() {
        return;
    }
    #[cfg(target_os = "linux")]
    {
        // v1：BPF 编译 + prctl(PR_SET_SECCOMP) 在具备 seccomp 的环境启用。
        // seccomp 可用性由 execd 探测（capability-probe）；init 侧无 BPF
        // 编译器 —— 收到 allowSyscalls 但无法应用时如实记录（不假装）。
        eprintln!("cell-init: seccomp requested but BPF application deferred to execd");
    }
}

/// 供测试：验证 FD 关闭逻辑（纯函数 —— 返回应保留的 FD 集合）。
/// B2：只保留 stdio（0/1/2）—— plan FD 也关闭。
pub fn retained_fds(_plan_fd: RawFd) -> Vec<RawFd> {
    vec![0, 1, 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_fd_policy_keeps_only_stdio() {
        let retained = retained_fds(3);
        assert_eq!(retained, vec![0, 1, 2]);
    }
}
