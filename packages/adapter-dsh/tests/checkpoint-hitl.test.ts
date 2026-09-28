/**
 * P1.5 HITL 验收 —— checkpoint 五态状态机(ADR-004)
 * 契约:pending 落盘可跨进程恢复(resume 重现等待而非 replay);approved/expired 确定性回放;
 *       rejected 强停止确定性重现;headless 走 defaultAction。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DynamicWorkflowEngine } from "../src/engine.js"
import { createFakePort, textResult } from "./fake-port.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dwf-p15-"))
}

function firstRunId(dir: string): string {
  return fs.readdirSync(path.join(dir, ".dynamic-workflows", "journal"))[0].replace(/\.json$/, "")
}

function readCheckpoint(dir: string, runId: string, key: string) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(dir, ".dynamic-workflows", "journal", `${runId}.json`), "utf-8"),
  )
  return raw.entries[key]?.checkpoint
}

test("pending 恢复等待:中断在等待人工时,resume 重新询问而非回放", async () => {
  const dir = tmpProject()
  const port = createFakePort({ results: [textResult("after-approval")] })
  const controller = new AbortController()
  const engine = new DynamicWorkflowEngine({
    startSubagent: port.start,
    cwd: dir,
    confirm: () => new Promise(() => {}), // 永不决:模拟等待人工
  })
  const script = `export const meta = { name: 'cp_pending' }
await checkpoint({ id: 'gate', message: '放行?' })
const r = await agent('post')
return r`
  const pending = engine.run({ script, signal: controller.signal })
  await new Promise((r) => setTimeout(r, 50))
  controller.abort() // 中断在 pending
  await assert.rejects(() => pending)
  const runId = firstRunId(dir)
  const onDisk = readCheckpoint(dir, runId, `${runId}:0`)
  assert.equal(onDisk?.status, "pending", `中断时 checkpoint 落盘 pending: ${JSON.stringify(onDisk)}`)
  assert.equal(onDisk?.checkpointId, "gate")

  // resume:pending 不回放,重新询问 -> 人工 approve -> 流程完成
  let asked = 0
  const resumeEngine = new DynamicWorkflowEngine({
    startSubagent: port.start,
    cwd: dir,
    confirm: () => { asked++; return Promise.resolve(true) },
  })
  const resumed = await resumeEngine.run({ script, resumeFromRunId: runId })
  assert.equal(resumed.result, "after-approval")
  assert.equal(asked, 1, "resume 对 pending checkpoint 重新询问(不回放)")
  assert.equal(readCheckpoint(dir, runId, `${runId}:0`)?.status, "approved")
})

test("已批回放:approved checkpoint 在 resume 时不重问", async () => {
  const dir = tmpProject()
  const port = createFakePort({ results: [textResult("tail-1"), textResult("tail-2")] })
  let asked = 0
  const engine = new DynamicWorkflowEngine({
    startSubagent: port.start,
    cwd: dir,
    confirm: (msg) => { asked++; void msg; return Promise.resolve("proceed") },
  })
  const script = `export const meta = { name: 'cp_ok' }
const decision = await checkpoint({ id: 'step-gate', message: '批?', defaultAction: true })
const r = await agent('tail')
return { decision, r }`
  const first = await engine.run({ script })
  assert.equal(asked, 1)
  assert.equal(JSON.stringify(first.result), JSON.stringify({ decision: "proceed", r: "tail-1" }))

  const runId = first.runId
  assert.equal(readCheckpoint(dir, runId, `${runId}:0`)?.status, "approved")

  // resume:agent hash 命中同样回放(tail-1);checkpoint approved 回放,confirm 不再调用
  const resumed = await engine.run({ script, resumeFromRunId: runId })
  assert.equal(asked, 1, "approved 回放不重问")
  assert.equal(JSON.stringify(resumed.result), JSON.stringify({ decision: "proceed", r: "tail-1" }))
})

test("Human Reject 强停止:拒绝确定性回放(resume 不重问)", async () => {
  const dir = tmpProject()
  const port = createFakePort({ results: [textResult("never")] })
  let asked = 0
  const engine = new DynamicWorkflowEngine({
    startSubagent: port.start,
    cwd: dir,
    confirm: () => { asked++; return Promise.resolve(false) },
  })
  const script = `export const meta = { name: 'cp_reject' }
await checkpoint({ id: 'final-gate', message: '上线?' })
const r = await agent('deploy')
return r`
  await assert.rejects(
    () => engine.run({ script }),
    (error: unknown) => {
      assert.ok(String((error as Error)?.message).includes("人工拒绝"))
      return true
    },
  )
  assert.equal(asked, 1)
  const runId = firstRunId(dir)
  assert.equal(readCheckpoint(dir, runId, `${runId}:0`)?.status, "rejected")

  // resume:拒绝确定性重现(强停止),不重问
  await assert.rejects(
    () => engine.run({ script, resumeFromRunId: runId }),
    (error: unknown) => {
      assert.ok(String((error as Error)?.message).includes("回放"))
      return true
    },
  )
  assert.equal(asked, 1, "拒绝回放不重问")
})

test("expired:超时取 defaultAction,流程继续,状态记 expired", async () => {
  const dir = tmpProject()
  const port = createFakePort({ results: [textResult("done")] })
  const engine = new DynamicWorkflowEngine({
    startSubagent: port.start,
    cwd: dir,
    confirm: () => new Promise(() => {}), // 永不决,靠 timeout
  })
  const result = await engine.run({
    script: `export const meta = { name: 'cp_expire' }
const d = await checkpoint({ id: 'auto-gate', message: '等 50ms', defaultAction: 'auto-go', timeoutMs: 50 })
const r = await agent('tail')
return { d, r }`,
  })
  assert.equal(JSON.stringify(result.result), JSON.stringify({ d: "auto-go", r: "done" }))
  const runId = result.runId
  const onDisk = readCheckpoint(dir, runId, `${runId}:0`)
  assert.equal(onDisk?.status, "expired")
  assert.equal(onDisk?.response?.decision, "auto-go")
})

test("headless:无 confirm 通道时按 defaultAction(能力位 interactiveCheckpoint=false)", async () => {
  const dir = tmpProject()
  const port = createFakePort({ results: [textResult("head-tail")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: port.start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'cp_headless' }
const d = await checkpoint({ id: 'auto', message: '无人值守', defaultAction: 'auto-pass' })
const r = await agent('tail')
return { d, r }`,
  })
  assert.equal(JSON.stringify(result.result), JSON.stringify({ d: "auto-pass", r: "head-tail" }))
})
