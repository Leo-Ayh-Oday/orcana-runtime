/** LNXF-1.0: Linux execution error codes (plan §8).
 *
 *  Every failure carries a stable error code; mapping to ToolExecutionResult
 *  happens at the Broker boundary.
 */

export const LINUX_ERROR_CODES = [
  "LINUX_PLATFORM_REQUIRED",
  "CGROUP_V2_UNAVAILABLE",
  "CGROUP_DELEGATION_UNAVAILABLE",
  "CGROUP_CONTROLLER_UNAVAILABLE",
  "USER_NAMESPACE_UNAVAILABLE",
  "BUBBLEWRAP_UNAVAILABLE",
  "BUBBLEWRAP_PROBE_FAILED",
  "ROOTLESS_PODMAN_UNAVAILABLE",
  "PODMAN_STORAGE_UNAVAILABLE",
  "ISOLATION_REQUIREMENT_UNMET",
  "DEGRADATION_NOT_ALLOWED",
  "EXECUTION_SPEC_INVALID",
  "MOUNT_POLICY_INVALID",
  "MOUNT_SOURCE_MISSING",
  "PATH_ESCAPE_BLOCKED",
  "SECRET_BINDING_DENIED",
  "HOST_ENV_INHERITANCE_BLOCKED",
  "NETWORK_POLICY_UNAVAILABLE",
  "RESOURCE_RESERVATION_FAILED",
  "CGROUP_CREATE_FAILED",
  "CGROUP_ATTACH_FAILED",
  "PROCESS_START_FAILED",
  "PROCESS_ORPHANED",
  "PROCESS_TIMEOUT",
  "PROCESS_CANCELLED",
  "PROCESS_OOM_KILLED",
  "PROCESS_PID_LIMIT",
  "PROCESS_OUTPUT_LIMIT",
  "TEMP_STORAGE_LIMIT",
  "SANDBOX_VIOLATION",
  "SANDBOX_CLEANUP_INCOMPLETE",
  "SANDBOX_RECEIPT_INCOMPLETE",
  "IMAGE_NOT_APPROVED",
  "MOUNT_SEMANTICS_UNSUPPORTED",
  "WORKSPACE_MISSING",
  "EXECUTION_AUTHORITY_MISSING",
  "WORKSPACE_NOT_AUTHORIZED",
  "WORKSPACE_PATH_ESCAPE",
  "WORKSPACE_CWD_MISSING",
  "WORKSPACE_READONLY",
  "WORKSPACE_OWNER_FILE_VIOLATION",
] as const

export type LinuxErrorCode = (typeof LINUX_ERROR_CODES)[number]

/** Tool-result mapping (plan §8). */
export type LinuxErrorOutcome =
  | "blocked"
  | "execution_failed"
  | "domain_failed"
  | "cancelled"
  | "timed_out"

export const LINUX_ERROR_OUTCOME: Record<LinuxErrorCode, LinuxErrorOutcome> = {
  MOUNT_POLICY_INVALID: "blocked",
  PATH_ESCAPE_BLOCKED: "blocked",
  NETWORK_POLICY_UNAVAILABLE: "blocked",
  SECRET_BINDING_DENIED: "blocked",
  HOST_ENV_INHERITANCE_BLOCKED: "blocked",
  ISOLATION_REQUIREMENT_UNMET: "blocked",
  DEGRADATION_NOT_ALLOWED: "blocked",
  LINUX_PLATFORM_REQUIRED: "execution_failed",
  CGROUP_V2_UNAVAILABLE: "execution_failed",
  CGROUP_DELEGATION_UNAVAILABLE: "execution_failed",
  CGROUP_CONTROLLER_UNAVAILABLE: "execution_failed",
  USER_NAMESPACE_UNAVAILABLE: "execution_failed",
  BUBBLEWRAP_UNAVAILABLE: "execution_failed",
  BUBBLEWRAP_PROBE_FAILED: "execution_failed",
  ROOTLESS_PODMAN_UNAVAILABLE: "execution_failed",
  PODMAN_STORAGE_UNAVAILABLE: "execution_failed",
  EXECUTION_SPEC_INVALID: "execution_failed",
  MOUNT_SOURCE_MISSING: "execution_failed",
  RESOURCE_RESERVATION_FAILED: "execution_failed",
  CGROUP_CREATE_FAILED: "execution_failed",
  CGROUP_ATTACH_FAILED: "execution_failed",
  PROCESS_START_FAILED: "execution_failed",
  PROCESS_ORPHANED: "execution_failed",
  PROCESS_OOM_KILLED: "execution_failed",
  PROCESS_PID_LIMIT: "execution_failed",
  PROCESS_OUTPUT_LIMIT: "execution_failed",
  TEMP_STORAGE_LIMIT: "execution_failed",
  SANDBOX_VIOLATION: "execution_failed",
  SANDBOX_CLEANUP_INCOMPLETE: "execution_failed",
  SANDBOX_RECEIPT_INCOMPLETE: "execution_failed",
  IMAGE_NOT_APPROVED: "execution_failed",
  MOUNT_SEMANTICS_UNSUPPORTED: "execution_failed",
  WORKSPACE_MISSING: "execution_failed",
  EXECUTION_AUTHORITY_MISSING: "execution_failed",
  WORKSPACE_NOT_AUTHORIZED: "execution_failed",
  WORKSPACE_PATH_ESCAPE: "execution_failed",
  WORKSPACE_CWD_MISSING: "execution_failed",
  WORKSPACE_READONLY: "execution_failed",
  WORKSPACE_OWNER_FILE_VIOLATION: "execution_failed",
  PROCESS_CANCELLED: "cancelled",
  PROCESS_TIMEOUT: "timed_out",
}

export class LinuxExecutionError extends Error {
  constructor(
    public readonly code: LinuxErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`)
    this.name = "LinuxExecutionError"
  }
}
