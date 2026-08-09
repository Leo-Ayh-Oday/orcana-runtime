import { WorldStore } from "../../../src/kernel/world"

const root = process.argv[2]
const crashPoint = process.argv[3]
if (!root) throw new Error("usage: schema-bootstrap-child <world-root> [fault-point]")

const store = new WorldStore(root, {
  faultInjector: point => {
    if (point === crashPoint) process.exit(91)
  },
})
store.close()
