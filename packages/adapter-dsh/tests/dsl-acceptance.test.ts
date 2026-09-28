/**
 * P1 全 DSL 验收 —— adapter-dsh 面(fake-port)
 * 覆盖:fallback / check / verify / judgePanel / retry / 嵌套 workflow(显式路径 + registry 名字引用)
 *       / tier 解析注入 / phase 前缀。core 语义已在 core 测试覆盖,此处验收 engine 组装面。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DynamicWorkflowEngine, REGISTRY_DIR, TIER_ROOT } from "../src/engine.js"
import { createFakePort, textResult, structuredResult, failedResult } from "./fake-port.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dwf-p1-"))
}

const ok = (text: string) => textResult(text)

test("fallback:首个失败换下一候选,全部失败塌缩 null", async () => {
  // 语义注意:agent 自身可恢复失败(retry 耗尽)返回 null 被视为"成功值",不触发换候选;
  // 换候选针对 throw 型可恢复失败(check 未过 / 网关 throw / 节点内显式 throw)
  const { start, calls } = createFakePort({
    results: [ok("backup-answer")],
  })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: tmpProject() })
  const result = await engine.run({
    script: `export const meta = { name: 'fb' }
const r = await fallback([
  async () => { await check(() => false, 'primary 不达标') },
  () => agent('backup'),
])
return r`,
  })
  assert.equal(result.result, "backup-answer")
  assert.equal(calls.requests.length, 1, "只有 backup 真跑")

  // 全败路径(候选均 throw)
  const engine2 = new DynamicWorkflowEngine({ startSubagent: createFakePort({ results: [ok("bookkeep")] }).start, cwd: tmpProject() })
  const result2 = await engine2.run({
    script: `export const meta = { name: 'fb2' }
const r = await fallback([
  () => { throw new Error('A') },
  () => { throw new Error('B') },
])
await agent('bookkeeping')
return r ?? 'all-null'`,
  })
  assert.equal(result2.result, "all-null")
})

test("check:确定性事实验证(通过/可恢复失败),fileExists 与 commandSuccess helper", async () => {
  const dir = tmpProject()
  fs.writeFileSync(path.join(dir, "marker.txt"), "x", "utf-8")
  const { start } = createFakePort({ results: [ok("witness")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'chk' }
const passed = await check(() => fileExists('marker.txt'), 'marker 应存在')
const good = await check(() => commandSuccess('node -e "process.exit(0)"'), 'node 应可用')
await agent('witness')
return { passed, good }`,
  })
  assert.equal(JSON.stringify(result.result), JSON.stringify({ passed: true, good: true }))
})

test("verify:对抗式评审投票(schema 结构化经 outputSchema 透传)", async () => {
  const { start, calls } = createFakePort({
    results: [
      structuredResult({ real: true, reason: "looks solid" }),
      structuredResult({ real: false, reason: "found a hole" }),
      ok("tail"),
    ],
  })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: tmpProject() })
  const result = await engine.run({
    script: `export const meta = { name: 'ver' }
const verdict = await verify('claim: earth is round', { reviewers: 2 })
await agent('tail')
return verdict`,
  })
  const verdict = result.result as { real: boolean; realCount: number; total: number }
  // threshold 默认 0.5:1/2 = 0.5 >= 0.5 -> true
  assert.equal(verdict.real, true)
  assert.equal(verdict.total, 2)
  // schema 透传:verify 的 reviewer 均带 outputSchema
  assert.ok(calls.requests.slice(0, 2).every((r) => r.outputSchema !== undefined))
})

test("judgePanel:多评委均分选优", async () => {
  const scores = [
    structuredResult({ score: 0.9 }), // cand 0 judge 1
    structuredResult({ score: 0.8 }), // cand 0 judge 2
    structuredResult({ score: 0.4 }), // cand 1 judge 1
    structuredResult({ score: 0.6 }), // cand 1 judge 2
  ]
  const { start } = createFakePort({ results: [...scores] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: tmpProject() })
  const result = await engine.run({
    script: `export const meta = { name: 'jp' }
const best = await judgePanel(['candidate-zero', 'candidate-one'], { judges: 2 })
return best`,
  })
  const best = result.result as { index: number; score: number }
  assert.equal(best.index, 0, "candidate-zero 均分 0.85 胜出")
  assert.ok(Math.abs(best.score - 0.85) < 1e-9)
})

test("嵌套 workflow:显式路径 + phase 前缀 + args 隔离", async () => {
  const dir = tmpProject()
  fs.writeFileSync(
    path.join(dir, "sum.js"),
    `export const meta = { name: 'sum' }\nphase('inner')\nconst r = await agent('add:' + JSON.stringify(args))\nreturn r`,
    "utf-8",
  )
  const { start, calls } = createFakePort({ results: [ok("child-done")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'parent' }
const r = await workflow('./sum.js', { tag: 'X' })
return r`,
  })
  assert.equal(result.result, "child-done")
  assert.match(String(calls.requests[0].prompt[0]?.text ?? ""), /add:\{"tag":"X"\}/, "child 收到 args 注入")
  assert.ok(result.phases.some((p) => p.startsWith("▸")), `child phase 带前缀: ${result.phases}`)
  assert.ok(result.phases.includes("▸ sum / inner"), `child phase 前缀拼接: ${result.phases}`)
})

test("嵌套 workflow:registry 名字引用(.dynamic-workflows/workflows 目录)", async () => {
  const dir = tmpProject()
  const wfDir = path.join(dir, REGISTRY_DIR)
  fs.mkdirSync(wfDir, { recursive: true })
  fs.writeFileSync(
    path.join(wfDir, "audit.js"),
    `export const meta = { id: 'audit', name: 'audit' }\nconst r = await agent('audit-step')\nreturn r`,
    "utf-8",
  )
  const { start, calls } = createFakePort({ results: [ok("audited")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'root_call' }
const r = await workflow('audit')
return r`,
  })
  assert.equal(result.result, "audited")
  assert.match(String(calls.requests[0].prompt[0]?.text ?? ""), /audit-step/)
})

test("tier:model-tiers.json 注入解析(tier 名 -> provider/modelId 双字段)", async () => {
  const dir = tmpProject()
  fs.mkdirSync(path.join(dir, TIER_ROOT), { recursive: true })
  fs.writeFileSync(
    path.join(dir, TIER_ROOT, "model-tiers.json"),
    JSON.stringify({ tiers: { small: "deepseek/deepseek-chat" } }),
    "utf-8",
  )
  const { start, calls } = createFakePort({ results: [ok("tiered"), ok("tiered")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'tier_test' }
const r = await agent('work', { tier: 'small' })
return r`,
  })
  assert.equal(result.result, "tiered")
  assert.deepEqual(calls.requests[0].agentOptions, { provider: "deepseek", model: "deepseek-chat" })

  // 未配置 tier:回退会话默认(不传 agentOptions),不报错
  const result2 = await engine.run({
    script: `export const meta = { name: 'tier_missing' }
const r = await agent('work2', { tier: 'huge' })
return r`,
  })
  assert.equal(result2.result, "tiered") // fake 尾槽复用
  assert.equal(calls.requests[1].agentOptions, undefined, "未配置 tier 不传 agentOptions")
  assert.ok(result2.logs.some((l) => /tier "huge" 未配置/.test(l)), "未配置 tier 记录告警日志")
})

test("retry:可恢复失败自动重试后成功", async () => {
  const { start, calls } = createFakePort({
    results: [failedResult("flaky-1"), failedResult("flaky-2"), ok("third-time")],
  })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: tmpProject() })
  const result = await engine.run({
    script: `export const meta = { name: 'rt' }
const r = await agent('unstable', { retries: 3 })
return r`,
  })
  assert.equal(result.result, "third-time")
  assert.equal(calls.requests.length, 3)
})
