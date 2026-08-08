/** LR2-1（L1-A）：SO_PEERCRED —— Unix socket 对端凭据。
 *
 *  通过 bun:ffi 调 libc getsockopt(SOL_SOCKET=1, SO_PEERCRED=17) 获取
 *  连接方 pid/uid/gid（Linux 返回连接建立时的对端凭据，不信任客户端
 *  自报身份）。bun:ffi 不可用时降级为 undefined（认证层显式记录降级，
 *  只依赖 socket 文件权限 0600/0700）。
 */

import { dlopen } from "bun:ffi"

const SOL_SOCKET = 1
const SO_PEERCRED = 17 // linux; macOS 为 LOCAL_PEERCRED（不同结构）

export interface PeerCredentials {
  pid: number
  uid: number
  gid: number
}

let getsockoptFn: ((fd: number, level: number, opt: number, value: Uint8Array, len: Int32Array) => number) | undefined

function loadGetsockopt(): ((fd: number, level: number, opt: number, value: Uint8Array, len: Int32Array) => number) | undefined {
  if (getsockoptFn) return getsockoptFn
  if (process.platform !== "linux") return undefined
  try {
    const libc = dlopen("libc.so.6", {
      getsockopt: { args: ["int", "int", "int", "ptr", "ptr"], returns: "int" },
    })
    getsockoptFn = (fd, level, opt, value, len) => libc.symbols.getsockopt(fd, level, opt, value, len)
  } catch {
    getsockoptFn = undefined
  }
  return getsockoptFn
}

/** 读取 unix socket 对端凭据；非 linux / ffi 不可用 → undefined。 */
export function peerCredentialsOf(socket: unknown): PeerCredentials | undefined {
  const fn = loadGetsockopt()
  const handle = (socket as { _handle?: { fd?: number } })._handle
  const fd = handle?.fd
  if (!fn || !fd || fd < 0) return undefined
  try {
    const value = new Uint8Array(12) // struct ucred: pid, uid, gid (4B each)
    const len = new Int32Array(1)
    len[0] = 12
    const rc = fn(fd, SOL_SOCKET, SO_PEERCRED, value, len)
    if (rc !== 0 || len[0] < 12) return undefined
    const view = new DataView(value.buffer)
    return {
      pid: view.getUint32(0, true),
      uid: view.getUint32(4, true),
      gid: view.getUint32(8, true),
    }
  } catch {
    return undefined
  }
}
