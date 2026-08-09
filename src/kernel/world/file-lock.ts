import { dlopen } from "bun:ffi"

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

type FlockFunction = (fd: number, operation: number) => number

let flockFunction: FlockFunction | undefined

function linuxFlock(): FlockFunction {
  if (flockFunction) return flockFunction
  if (process.platform !== "linux") {
    throw new Error("WorldDB bootstrap locking requires Linux flock(2)")
  }
  const library = dlopen("libc.so.6", {
    flock: { args: ["int", "int"], returns: "int" },
  })
  flockFunction = (fd, operation) => library.symbols.flock(fd, operation)
  return flockFunction
}

export function withExclusiveFileLock<T>(
  fd: number,
  fn: () => T,
  timeoutMs = 5_000,
): T {
  const flock = linuxFlock()
  const deadline = Date.now() + timeoutMs
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    if (Date.now() >= deadline) throw new Error("WORLD_DB_BOOTSTRAP_BUSY")
    Atomics.wait(waiter, 0, 0, 10)
  }

  let completed = false
  try {
    const result = fn()
    completed = true
    return result
  } finally {
    const unlocked = flock(fd, LOCK_UN) === 0
    if (completed && !unlocked) throw new Error("WORLD_DB_BOOTSTRAP_UNLOCK_FAILED")
  }
}
