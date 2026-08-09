import { dlopen, read } from "bun:ffi"

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const EINTR = 4
const EAGAIN = 11

type FlockFunction = (fd: number, operation: number) => number

interface LinuxFlock {
  readonly flock: FlockFunction
  readonly errno: () => number
}

let flockApi: LinuxFlock | undefined

function linuxFlock(): LinuxFlock {
  if (flockApi) return flockApi
  if (process.platform !== "linux") {
    throw new Error("WorldDB bootstrap locking requires Linux flock(2)")
  }
  const library = dlopen("libc.so.6", {
    flock: { args: ["int", "int"], returns: "int" },
    __errno_location: { args: [], returns: "ptr" },
  })
  flockApi = {
    flock: (fd, operation) => library.symbols.flock(fd, operation),
    errno: () => {
      const pointer = library.symbols.__errno_location()
      if (pointer === null) throw new Error("WORLD_DB_BOOTSTRAP_ERRNO_UNAVAILABLE")
      return read.i32(pointer, 0)
    },
  }
  return flockApi
}

export function withExclusiveFileLock<T>(
  fd: number,
  fn: () => T,
  timeoutMs = 5_000,
): T {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("WorldDB bootstrap lock timeout must be finite and non-negative")
  }
  const { flock, errno } = linuxFlock()
  const deadline = performance.now() + timeoutMs
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) break
    const errorNumber = errno()
    if (errorNumber === EINTR) {
      if (performance.now() >= deadline) throw new Error("WORLD_DB_BOOTSTRAP_BUSY")
      continue
    }
    if (errorNumber !== EAGAIN) {
      throw new Error(`WORLD_DB_BOOTSTRAP_LOCK_FAILED: errno=${errorNumber}`)
    }
    if (performance.now() >= deadline) throw new Error("WORLD_DB_BOOTSTRAP_BUSY")
    Atomics.wait(waiter, 0, 0, 10)
  }

  let completed = false
  try {
    const result = fn()
    completed = true
    return result
  } finally {
    const unlocked = flock(fd, LOCK_UN) === 0
    if (completed && !unlocked) {
      throw new Error(`WORLD_DB_BOOTSTRAP_UNLOCK_FAILED: errno=${errno()}`)
    }
  }
}
