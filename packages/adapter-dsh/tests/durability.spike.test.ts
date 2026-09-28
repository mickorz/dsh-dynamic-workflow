/**
 * P0.5 Durability Spike —— 六场景中断-续跑(engine + 磁盘 journal 全链)
 *
 * crash 模拟:可控 hang 的 fake port + AbortController.abort();
 * 断言核心:已完成步骤回放不再调子代理(fake start 计数),未完成重跑,
 * 结果与 journal 身份稳定。副作用红线:回放不重复触发外部调用。
 *
 * 六场景:sequence / parallel / nested / race / retry / side-effect
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DynamicWorkflowEngine } from "../src/engine.js"
import { createFakePort } from "./fake-port.js"
import type { PortStartSubagent, PortSubagentResult } from "../src/port.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dwf-spike-"))
}

/** hang 结果工厂:signal abort 时 settle 为 cancelled(模拟被取消的进行中 agent) */
function hang(): (signal: AbortSignal) => Promise<PortSubagentResult> {
  return (signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve({ output: [], stopReason: "cancelled" })
      signal.addEventListener("abort", () => resolve({ output: [], stopReason: "cancelled" }), { once: true })
    })
}

const ok = (text: string): PortSubagentResult => ({ output: [{ type: "text", text }], stopReason: "completed" })
const fail = (why: string): PortSubagentResult => ({ output: [], diagnostic: why, stopReason: "error" })

/** 构造可中断 engine:出现 n 个 agent-end 事件后延迟 abort(让进行中的 dispatch 先发出,确保落盘窗口) */
function makeInterruptibleEngine(
  opts: { startSubagent: PortStartSubagent; cwd: string },
  ends: number,
): { engine: DynamicWorkflowEngine; signal: AbortSignal } {
  const controller = new AbortController()
  let ended = 0
  const engine = new DynamicWorkflowEngine({
    ...opts,
    onProgress: (event) => {
      if (event.type === "agent-end" && ++ended >= ends) {
        setTimeout(() => controller.abort(), 80)
      }
    },
  })
  return { engine, signal: controller.signal }
}

/** 首轮中断执行(预期 reject);返回错误供断言 */
async function interruptRun(engine: DynamicWorkflowEngine, script: string, signal: AbortSignal): Promise<unknown> {
  try {
    await engine.run({ script, signal })
    return undefined
  } catch (error) {
    return error
  }
}

/** 读取落盘的 runId(目录下唯一 journal 文件) */
function firstRunId(dir: string): string {
  return fs.readdirSync(path.join(dir, ".dynamic-workflows", "journal"))[0].replace(/\.json$/, "")
}

/** resume 用的干净 engine(不带中断观察) */
function resumeEngine(opts: { startSubagent: PortStartSubagent; cwd: string }): DynamicWorkflowEngine {
  return new DynamicWorkflowEngine(opts)
}

// ── 场景 1:sequence resume ──
test("sequence resume:A B 完成后中断,C 重跑,A B 回放不调子代理", async () => {
  const dir = tmpProject()
  const { start, calls } = createFakePort({
    results: [ok("a"), ok("b"), hang(), ok("c-resumed")],
  })
  const interruptible = makeInterruptibleEngine({ startSubagent: start, cwd: dir }, 2)
  const script = `export const meta = { name: 'seq_resume' }
const r = await sequence([() => agent('step-a', { label: 'step-a' }), () => agent('step-b', { label: 'step-b' }), () => agent('step-c', { label: 'step-c' })])
return r`
  const first = await interruptRun(interruptible.engine, script, interruptible.signal)
  assert.ok(first, "中断路径应 reject(WORKFLOW_ABORTED)")
  assert.equal(calls.requests.length, 3, "首轮 3 个 start")

  // resume:A B 回放,C 真跑
  const engine = resumeEngine({ startSubagent: start, cwd: dir })
  const runId = firstRunId(dir)
  const resumed = await engine.run({ script, resumeFromRunId: runId })
  assert.equal(resumed.result, "c-resumed")
  assert.equal(resumed.resumedFromDisk, true)
  assert.equal(calls.requests.length, 4, "续跑只新增 1 次 start(C);A B 回放不调")
  const replayed = resumed.agents.filter((a) => a.replayed).map((a) => a.label)
  assert.deepEqual(replayed.sort(), ["step-a", "step-b"])
})

// ── 场景 2:parallel resume ──
test("parallel resume:A done / B failed / C 进行中中断;A 回放,B C 重跑", async () => {
  const dir = tmpProject()
  const { start, calls } = createFakePort({
    results: [ok("pa"), fail("pb-down"), hang(), ok("pb-2"), ok("pc-2")],
  })
  const interruptible = makeInterruptibleEngine({ startSubagent: start, cwd: dir }, 2)
  const script = `export const meta = { name: 'par_resume' }
const rs = await parallel([() => agent('pa', { label: 'pa' }), () => agent('pb', { label: 'pb' }), () => agent('pc', { label: 'pc' })])
return rs.map((x) => x ?? 'null')`
  const first = await interruptRun(interruptible.engine, script, interruptible.signal)
  assert.ok(first)
  assert.equal(calls.requests.length, 3)

  const engine = resumeEngine({ startSubagent: start, cwd: dir })
  const runId = firstRunId(dir)
  const resumed = await engine.run({ script, resumeFromRunId: runId })
  // B failed 不落盘 -> 重跑得 pb-2;C 进行中不落盘 -> 重跑得 pc-2;A 回放
  assert.equal(JSON.stringify(resumed.result), JSON.stringify(["pa", "pb-2", "pc-2"]))
  assert.equal(calls.requests.length, 5, "续跑只新增 B C 两次 start;A 回放不调")
  const replayed = resumed.agents.filter((a) => a.replayed).map((a) => a.label)
  assert.deepEqual(replayed, ["pa"])
})

// ── 场景 3:nested resume ──
test("nested resume:child 内首个 agent 完成后中断,续跑按 scope 链回放", async () => {
  const dir = tmpProject()
  const childScript = `export const meta = { name: 'child' }
const one = await agent('child-one', { label: 'child-one' })
const two = await agent('child-two', { label: 'child-two' })
return one + '|' + two
`
  fs.writeFileSync(path.join(dir, "child.js"), childScript, "utf-8")
  const { start, calls } = createFakePort({
    results: [ok("c1"), hang(), ok("c2-resumed")],
  })
  const interruptible = makeInterruptibleEngine({ startSubagent: start, cwd: dir }, 1)
  const parent = `export const meta = { name: 'parent' }
const r = await workflow('./child.js')
return r`
  const first = await interruptRun(interruptible.engine, parent, interruptible.signal)
  assert.ok(first)

  const engine = resumeEngine({ startSubagent: start, cwd: dir })
  const runId = firstRunId(dir)
  const journal = JSON.parse(
    fs.readFileSync(path.join(dir, ".dynamic-workflows", "journal", `${runId}.json`), "utf-8"),
  )
  // child 的 agent 落盘 key 为 runId:wf0:0(scope 链身份,ADR-003)
  assert.ok(Object.keys(journal.entries).some((k) => k === `${runId}:wf0:0`), `key 应为 runId:wf0:0,实际 ${Object.keys(journal.entries)}`)

  const resumed = await engine.run({ script: parent, resumeFromRunId: runId })
  assert.equal(resumed.result, "c1|c2-resumed")
  assert.equal(calls.requests.length, 3, "续跑只新增 child-two 一次 start(首轮 2 + 续跑 1)")
  assert.equal(resumed.agents.filter((a) => a.replayed).length, 1)
})

// ── 场景 4:race resume ──
test("race resume:胜出者落盘后续跑回放,race 结论确定性重现", async () => {
  const dir = tmpProject()
  // 首轮:rb 快胜出(ok),ra hang(被 race 取消),after hang(run 中断点)
  const { start, calls } = createFakePort({
    results: [ok("rb-wins"), hang(), hang(), hang(), ok("after-resumed")],
  })
  const interruptible = makeInterruptibleEngine({ startSubagent: start, cwd: dir }, 1)
  const script = `export const meta = { name: 'race_resume' }
const winner = await race([() => agent('ra', { label: 'ra' }), () => agent('rb', { label: 'rb' })])
const after = await agent('after', { label: 'after' })
return { winner, after }`
  const first = await interruptRun(interruptible.engine, script, interruptible.signal)
  assert.ok(first)
  assert.equal(calls.requests.length, 3, "首轮 3 start(ra/rb/after)")

  const engine = resumeEngine({ startSubagent: start, cwd: dir })
  const runId = firstRunId(dir)
  const resumed = await engine.run({ script, resumeFromRunId: runId })
  // 胜出者 ra 回放(结论确定性重现);after 中断未落盘 -> 重跑
  // 语义发现(Spike):被取消的兄弟(rb)resume 时会重跑一次再被取消 —— 无害但多花一次子代理调用,
  // 副作用敏感场景需注意(取消前的进行中调用可能已产生部分副作用)
  assert.equal(JSON.stringify(resumed.result), JSON.stringify({ winner: "rb-wins", after: "after-resumed" }))
  const winnerRecord = resumed.agents.find((a) => a.label === "ra")
  assert.equal(winnerRecord?.replayed, true, "胜出者应回放(结论确定性)")
  const loserRecord = resumed.agents.find((a) => a.label === "rb")
  assert.equal(loserRecord?.status, "aborted", "被取消兄弟重跑后再次被取消")
})

// ── 场景 5:retry resume ──
// 注意:core 的重试 attempt 不发 agent-end(仅终态发 onAgentUpdate),中断触发不能靠 end 计数,
// 改用 start 计数;且首轮必须有一个成功 agent 保证 journal 落盘(a 先 ok,b 走 retry 中断)
test("retry resume:失败 attempt 只进 executions;中断后续跑从 attempt 1 重新计并成功", async () => {
  const dir = tmpProject()
  const base = createFakePort({ results: [ok("stable-a"), fail("b1-down"), hang(), ok("b2-ok")] })
  const controller = new AbortController()
  let starts = 0
  const start: PortStartSubagent = async (request) => {
    // 计数在 base.start 之前:hang 槽位在 start 内部 await,后置计数永不触发
    if (++starts >= 3) setTimeout(() => controller.abort(), 80)
    return base.start(request)
  }
  const interruptEngine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const script = `export const meta = { name: 'retry_resume' }
const a = await agent('stable')
const b = await agent('flaky', { retries: 2 })
return a + '|' + b`
  const first = await interruptRun(interruptEngine, script, controller.signal)
  assert.ok(first, "attempt2 进行中中断应 reject")

  const engine = resumeEngine({ startSubagent: start, cwd: dir })
  const runId = firstRunId(dir)
  // 首轮 journal:stable a 已落盘;flaky b 的 entry 无 hash(executions 记 attempt1 失败)
  const journalRaw = JSON.parse(
    fs.readFileSync(path.join(dir, ".dynamic-workflows", "journal", `${runId}.json`), "utf-8"),
  )
  const stableEntry = journalRaw.entries[`${runId}:0`]
  assert.ok(stableEntry.hash, "成功 agent 已落 hash")
  const flakyEntry = journalRaw.entries[`${runId}:1`]
  assert.equal(flakyEntry.hash, undefined, "失败 entry 绝不写 hash")
  assert.equal(flakyEntry.executions?.length, 2, "attempt1 失败与 attempt2 中止都记入 executions")

  // resume:a 回放;b 从 attempt 1 重新计(fake 下一次结果 ok)并成功落 hash
  const resumed = await engine.run({ script, resumeFromRunId: runId })
  assert.equal(resumed.result, "stable-a|b2-ok")
  const finalRaw = JSON.parse(
    fs.readFileSync(path.join(dir, ".dynamic-workflows", "journal", `${runId}.json`), "utf-8"),
  )
  assert.ok(finalRaw.entries[`${runId}:1`].hash, "b 成功后补写 hash")
  assert.equal(resumed.agents.filter((x) => x.replayed).length, 1, "仅 a 回放")
})

// ── 场景 6:side-effect resume(红线验证) ──
test("side-effect resume:回放不重复触发副作用;hash miss(改 prompt)重发为设计内行为", async () => {
  const dir = tmpProject()
  let sideEffectCount = 0
  const base = createFakePort({ results: [ok("effect-a"), hang(), ok("b-resumed"), ok("effect-a-v2"), ok("b-resumed-2")] })
  // 包装 start:模拟外部副作用(计数)——只有真实 start 才触发
  const start: PortStartSubagent = async (request) => {
    sideEffectCount++
    return base.start(request)
  }
  const interruptible = makeInterruptibleEngine({ startSubagent: start, cwd: dir }, 1)

  const scriptV1 = `export const meta = { name: 'side_effect' }
const a = await agent('do-side-effect')
const b = await agent('plain-b')
return a + '|' + b`
  const first = await interruptRun(interruptible.engine, scriptV1, interruptible.signal)
  assert.ok(first)
  assert.equal(sideEffectCount, 2, "首轮 2 次真实调用(含副作用)")

  // resume 同脚本:副作用 agent 回放 -> 计数不增
  const engine = resumeEngine({ startSubagent: start, cwd: dir })
  const runId = firstRunId(dir)
  const resumed = await engine.run({ script: scriptV1, resumeFromRunId: runId })
  assert.equal(resumed.result, "effect-a|b-resumed")
  assert.equal(sideEffectCount, 3, "续跑只新增 plain-b 一次;side-effect 回放不触发(计数 2->3 而非 2->4)")

  // hash miss:改副作用 agent 的 prompt -> 身份变更 -> 重跑 -> 副作用再次触发(设计内行为)
  const scriptV2 = scriptV1.replace("do-side-effect", "do-side-effect-v2")
  const rerun = await engine.run({ script: scriptV2, resumeFromRunId: runId })
  assert.equal(rerun.result, "effect-a-v2|b-resumed-2")
  assert.equal(sideEffectCount, 5, "prompt 变更使 side-effect 重跑(4)+ plain-b miss 后重跑(5)")
})
