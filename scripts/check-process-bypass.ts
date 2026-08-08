/**
 * LR2-0C：产品级直接进程执行旁路检查（DIRECT_PRODUCT_PROCESS_BYPASS）。
 *
 *  - 扫描 src/ 下所有 .ts/.tsx 的 node:child_process 导入调用、
 *    Bun.spawn / Deno.Command / shell:true；
 *  - 对照 config/runtime-process-bypass-allowlist.json 的 allowlist：
 *    允许 = Linux runtime 统一入口与监督器（唯一真实执行链）；
 *  - 任何 src/ 新增旁路 → exit 1（CI 违例）；
 *  - allowlist 内调用消失 → 也报错（防"删掉入口"式假绿）；
 *  - 用法：
 *      bun scripts/check-process-bypass.ts            # 检查（exit 0/1）
 *      bun scripts/check-process-bypass.ts --json     # 输出全部执行点 JSON
 *      bun scripts/check-process-bypass.ts --list     # 输出分类执行点清单（inventory 生成用）
 *
 *  运行环境：bun（依赖 node:fs / node:path / typescript 解析 AST）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"

const ROOT = process.cwd()
const SRC_DIR = join(ROOT, "src")
const CONFIG_PATH = join(ROOT, "config", "runtime-process-bypass-allowlist.json")

export interface SpawnSite {
  file: string
  line: number
  kind: string
}

const PROCESS_NAMES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])

/** 全仓扫描：node:child_process / Bun.spawn / Deno.Command / shell:true。 */
export function scanDirectProcessCalls(): SpawnSite[] {
  const sites: SpawnSite[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        walk(full)
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        const rel = relative(ROOT, full).split(sep).join("/")
        const source = readFileSync(full, "utf8")
        const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const importedNames = new Set<string>()
        let childProcessNamespace: string | undefined
        for (const statement of sf.statements) {
          if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
          const mod = statement.moduleSpecifier.text
          if (mod === "node:child_process" || mod === "child_process") {
            const clause = statement.importClause
            if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
              childProcessNamespace = clause.namedBindings.name.text
            } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) importedNames.add(el.name.text)
            }
          }
        }
        const fileHits: SpawnSite[] = []
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
            if (ts.isIdentifier(node.expression)) {
              if (importedNames.has(node.expression.text)) fileHits.push({ file: rel, line: line + 1, kind: node.expression.text })
            } else if (ts.isPropertyAccessExpression(node.expression)) {
              const name = node.expression.name.text
              const obj = node.expression.expression
              if (childProcessNamespace && ts.isIdentifier(obj) && obj.text === childProcessNamespace && PROCESS_NAMES.has(name)) {
                fileHits.push({ file: rel, line: line + 1, kind: `child_process.${name}` })
              }
              if (name === "spawn" && ts.isIdentifier(obj) && obj.text === "Bun") {
                fileHits.push({ file: rel, line: line + 1, kind: "Bun.spawn" })
              }
              if (name === "Command" && ts.isIdentifier(obj) && obj.text === "Deno") {
                fileHits.push({ file: rel, line: line + 1, kind: "Deno.Command" })
              }
            }
          }
          if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "shell") {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
            const valueText = node.initializer.getText(sf)
            if (valueText === "true") fileHits.push({ file: rel, line: line + 1, kind: "shell:true" })
          }
          ts.forEachChild(node, visit)
        }
        visit(sf)
        sites.push(...fileHits)
      }
    }
  }
  if (!existsSync(SRC_DIR)) return sites
  walk(SRC_DIR)
  return sites
}

/** 读取允许清单（单一事实源：config/runtime-process-bypass-allowlist.json）。 */
export function loadAllowlist(): string[] {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`allowlist missing: ${CONFIG_PATH}`)
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { allowlist: string[] }
  return raw.allowlist
}

export function isAllowed(file: string, allowlist: string[]): boolean {
  return allowlist.some(a => file === a || file.startsWith(a + "/"))
}

function main(): void {
  const args = process.argv.slice(2)
  const sites = scanDirectProcessCalls()
  const allowlist = loadAllowlist()

  if (args.includes("--json")) {
    console.log(JSON.stringify(sites, null, 2))
    return
  }
  if (args.includes("--list")) {
    const byFile = new Map<string, string[]>()
    for (const s of sites) {
      const list = byFile.get(s.file) ?? []
      list.push(`${s.kind}@${s.line}`)
      byFile.set(s.file, list)
    }
    for (const [file, kinds] of [...byFile.entries()].sort()) {
      console.log(`${file}\n    ${kinds.join(", ")}`)
    }
    return
  }

  const outside = sites.filter(s => !isAllowed(s.file, allowlist))
  const allowlistFiles = sites.filter(s => isAllowed(s.file, allowlist)).map(s => s.file)
  const covered = new Set(allowlistFiles)
  // 防假绿：allowlist 内至少一个真实执行点存在（入口未消失）。
  const unusedAllowlist = allowlist.filter(a => ![...covered].some(f => f === a || f.startsWith(a + "/")))

  if (outside.length > 0 || unusedAllowlist.length > 0) {
    if (outside.length > 0) {
      console.error(`DIRECT_PRODUCT_PROCESS_BYPASS = ${outside.length}（违例执行点）`)
      for (const s of outside) console.error(`  ✗ ${s.file}:${s.line}  ${s.kind}`)
    }
    if (unusedAllowlist.length > 0) {
      console.error(`UNCLASSIFIED_CHILD_PROCESS_IMPORT = ${unusedAllowlist.length}（allowlist 条目无真实执行点 —— 疑似入口被删的假绿）`)
      for (const a of unusedAllowlist) console.error(`  ✗ allowlist: ${a}`)
    }
    process.exit(1)
  }
  console.log(`DIRECT_PRODUCT_PROCESS_BYPASS = 0（允许 ${sites.length} 个执行点，均在统一执行链内）`)
}

main()
