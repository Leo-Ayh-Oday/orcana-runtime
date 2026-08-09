import { WorldStore } from "../../../src/kernel/world"

const root = process.argv[2]
if (!root) throw new Error("usage: schema-bootstrap-child <world-root>")

const store = new WorldStore(root)
store.close()
