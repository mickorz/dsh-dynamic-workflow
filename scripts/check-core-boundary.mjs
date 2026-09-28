/**
 * core 依赖边界测试(P-1):core 不允许 import 宿主与执行器概念。
 * 禁止:@opencode/*、@deepseek-ai/*、cordis、node:vm。
 * 违规即非零退出,接入 CI(npm run boundary)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const CORE = join(process.cwd(), "packages", "core", "src")
const BANNED = [/@opencode\//, /@deepseek-ai\//, /cordis/, /node:vm/, /["']vm["']/]

const violations = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!name.endsWith(".ts")) continue
    const text = readFileSync(full, "utf-8")
    for (const line of text.split("\n")) {
      const importMatch = line.match(/^\s*import\b/) || line.match(/^\s*export\s+.*\bfrom\b/)
      if (!importMatch) continue
      for (const banned of BANNED) {
        if (banned.test(line)) violations.push(`${full}: ${line.trim()}`)
      }
    }
  }
}
walk(CORE)

if (violations.length) {
  console.error("[失败] core 依赖边界违规:")
  for (const v of violations) console.error("  " + v)
  process.exit(1)
}
console.log("[成功] core 依赖边界检查通过(无宿主/执行器 import)")
