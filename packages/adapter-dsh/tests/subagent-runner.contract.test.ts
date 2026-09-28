/**
 * DshSubagentRunner 契约测试(P0 出口 5:abort / error / outputSchema 行为与 OpenCode 版一致)
 * 对照基线:packages/core 测试在 fake AgentSessionRunner 上的语义
 *  - 子级失败(recoverable)在 parallel 塌缩 null(与 OpenCode AGENT_FAILED 一致)
 *  - cancelled -> WORKFLOW_ABORTED -> run 级中止
 *  - schema:completed 无 structured -> null;有 -> 原值
 *  - model "prov/id" 拆 agentOptions 双字段
 *  - onSessionCreated 建立即回传;dispose 每次调用
 */
import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow, WorkflowError } from "@mickorz/dynamic-workflow-core"
import { vmExecutor } from "@mickorz/dynamic-workflow-executor-vm"
import { DshSubagentRunner } from "../src/subagent-runner.js"
import {
  createFakePort,
  textResult,
  structuredResult,
  failedResult,
  cancelledResult,
} from "./fake-port.js"

const SCRIPT_AGENT_ONLY = `export const meta = { name: 'probe' }
const r = await agent('do work')
return r`

test("completed 文本:result 为 output 拼接,dispose 恰一次", async () => {
  const { start, calls } = createFakePort({ results: [textResult("hello world")] })
  const runner = new DshSubagentRunner({ startSubagent: start })
  const result = await runWorkflow(SCRIPT_AGENT_ONLY, { executor: vmExecutor, agent: runner })
  assert.equal(result.result, "hello world")
  assert.equal(result.agents[0].outputType, "text")
  assert.deepEqual(calls.disposed, ["fake-run-0"])
})

test("schema 结果:structured 原值透传,outputType 为 structured", async () => {
  const { start } = createFakePort({ results: [structuredResult({ real: true, reason: "x" })] })
  const runner = new DshSubagentRunner({ startSubagent: start })
  const result = await runWorkflow(
    `export const meta = { name: 'probe_s' }
const r = await agent('judge', { schema: { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] } })
return r`,
    { executor: vmExecutor, agent: runner },
  )
  assert.deepEqual(result.result, { real: true, reason: "x" })
  assert.equal(result.agents[0].outputType, "structured")
})

test("schema 结果:completed 无 structured -> null(seam 定义子级失败)", async () => {
  const { start } = createFakePort({ results: [{ output: [{ type: "text", text: "no capture" }], stopReason: "completed" }] })
  const runner = new DshSubagentRunner({ startSubagent: start })
  const result = await runWorkflow(
    `export const meta = { name: 'probe_s2' }
const r = await agent('judge', { schema: { type: 'object' } })
return r`,
    { executor: vmExecutor, agent: runner },
  )
  assert.equal(result.result, null)
})

test("子级失败(stopReason error):parallel 塌缩 null,不终止 run(与 OpenCode 一致)", async () => {
  const { start } = createFakePort({
    results: [failedResult("boom"), textResult("fine")],
  })
  const runner = new DshSubagentRunner({ startSubagent: start })
  const result = await runWorkflow(
    `export const meta = { name: 'probe_fail' }
const rs = await parallel([() => agent('a'), () => agent('b')])
return rs.map((x) => x ?? 'null')`,
    { executor: vmExecutor, agent: runner },
  )
  assert.deepEqual(result.result, ["null", "fine"])
  // 失败 attempt 的 error 信息进 record
  assert.match(result.agents[0].error ?? "", /boom/)
})

test("cancelled(stopReason cancelled):无 run 级取消时与子级失败同构(塌缩 null,与 OpenCode 一致);run 级取消则中止", async () => {
  const { start } = createFakePort({ results: [cancelledResult()] })
  const runner = new DshSubagentRunner({ startSubagent: start })
  // 伪造场景:run 未 abort,子级却 cancelled —— core 视为可恢复失败,重试耗尽塌缩 null
  const result = await runWorkflow(SCRIPT_AGENT_ONLY, { executor: vmExecutor, agent: runner })
  assert.equal(result.result, null)
  assert.equal(result.agents[0].status, "failed")
})

test("abort 级联:signal 取消传到 port 请求(run 级 -> attempt -> seam)", async () => {
  const controller = new AbortController()
  const { start, calls } = createFakePort({
    results: [
      (signal) =>
        new Promise((resolve) => {
          if (signal.aborted) return resolve(cancelledResult())
          signal.addEventListener("abort", () => resolve(cancelledResult()), { once: true })
        }),
    ],
  })
  const runner = new DshSubagentRunner({ startSubagent: start })
  const pending = runWorkflow(SCRIPT_AGENT_ONLY, { executor: vmExecutor, agent: runner, signal: controller.signal })
  await new Promise((r) => setTimeout(r, 20))
  controller.abort()
  // run 级取消:WORKFLOW_ABORTED reject(与 OpenCode abort 级联一致)
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError)
      assert.equal(error.code, "WORKFLOW_ABORTED")
      return true
    },
  )
  assert.ok(calls.requests[0].signal !== undefined)
})

test("model 传递:\"prov/id\" 拆 agentOptions 双字段;裸串按可恢复失败塌缩 null(与 OpenCode start 失败同构)", async () => {
  const { start, calls } = createFakePort({ results: [textResult("m")] })
  const runner = new DshSubagentRunner({ startSubagent: start })
  await runWorkflow(
    `export const meta = { name: 'probe_model' }
await agent('work', { model: 'deepseek/deepseek-chat' })
return 1`,
    { executor: vmExecutor, agent: runner },
  )
  assert.deepEqual(calls.requests[0].agentOptions, { provider: "deepseek", model: "deepseek-chat" })

  // 裸串:parseModelSpec 抛错发生在 start 之前,core 按可恢复失败处理(retry 耗尽 -> null)
  const bad = await runWorkflow(
    `export const meta = { name: 'probe_bad_model' }
const r = await agent('work', { model: 'no-slash' })
return r`,
    { executor: vmExecutor, agent: runner },
  )
  assert.equal(bad.result, null)
  assert.equal(bad.agents[0].status, "failed")
  assert.match(bad.agents[0].error ?? "", /provider\/modelId/)
})

test("onSessionCreated:start resolve 即回传 run.id(record.running 态带 sessionId)", async () => {
  const { start } = createFakePort({ results: [textResult("x")] })
  const seen: string[] = []
  const runner = new DshSubagentRunner({ startSubagent: start })
  await runWorkflow(SCRIPT_AGENT_ONLY, {
    executor: vmExecutor,
    agent: runner,
    onAgentUpdate: (record) => {
      if (record.sessionId && !seen.includes(record.sessionId)) seen.push(record.sessionId)
    },
  })
  assert.deepEqual(seen, ["fake-run-0"])
})

test("start 抛错(基础设施故障):core 按可恢复失败塌缩 null(与 OpenCode session create 失败同构)", async () => {
  const { start } = createFakePort({ startThrows: () => new Error("subagent seam unavailable") })
  const runner = new DshSubagentRunner({ startSubagent: start })
  const result = await runWorkflow(SCRIPT_AGENT_ONLY, { executor: vmExecutor, agent: runner })
  assert.equal(result.result, null)
  assert.match(result.agents[0].error ?? "", /subagent seam unavailable/)
})
