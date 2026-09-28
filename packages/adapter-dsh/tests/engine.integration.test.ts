/**
 * DynamicWorkflowEngine 集成测试(P0 出口 2 的 fake-port 等价面:agent/sequence/parallel + 事件通道)
 * 真机验证(装好 DSH 环境):见 glue.ts 真机联调点三处核对后跑同形 e2e。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { DynamicWorkflowEngine } from "../src/engine.js"
import { buildDynamicWorkflowTool } from "../src/tool.js"
import { DSH_HOST_CAPABILITIES } from "../src/capabilities.js"
import { createFakePort, textResult, failedResult } from "./fake-port.js"

test("engine 全链:agent + parallel + sequence 编排", async () => {
  const { start } = createFakePort({
    results: [
      textResult("a1"),
      textResult("a2"),
      textResult("seq-prev"),
      textResult("seq-last"),
    ],
  })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: process.cwd() })
  const result = await engine.run({
    script: `export const meta = { name: 'spike_e2e' }
phase('fan')
const fan = await parallel([() => agent('one'), () => agent('two')])
phase('chain')
const chain = await sequence([() => agent('first'), (prev) => agent('second:' + prev)])
return { fan, chain }`,
  })
  assert.equal(JSON.stringify(result.result), JSON.stringify({ fan: ["a1", "a2"], chain: "seq-last" }))
  assert.equal(result.agentCount, 4)
  assert.deepEqual(result.phases, ["fan", "chain"])
})

test("进度事件通道:agent-start/agent-end 序列完整(observe-only 快照)", async () => {
  const { start } = createFakePort({ results: [textResult("x"), textResult("y")] })
  const events: string[] = []
  const engine = new DynamicWorkflowEngine({
    startSubagent: start,
    cwd: process.cwd(),
    onProgress: (event) => {
      if (event.type === "phase") events.push(`phase:${event.title}`)
      else if (event.type === "agent-start") events.push(`agent-start:${event.label}`)
      else events.push(`agent-end:${event.label}:${event.status}`)
    },
  })
  await engine.run({
    script: `export const meta = { name: 'spike_events' }
phase('p1')
await parallel([() => agent('e1'), () => agent('e2')])
return 1`,
  })
  // P0 事件面:agent-start/agent-end(core 的 phase 无实时回调面,由 meta.phases 声明分组)
  assert.equal(events.filter((e) => e.startsWith("agent-start")).length, 2)
  assert.equal(events.filter((e) => e.endsWith(":ok")).length, 2)
  assert.ok(!events.some((e) => e.endsWith(":failed") || e.endsWith(":aborted")))
})

test("dynamic_workflow 工具:成功与失败结果形状", async () => {
  const okPort = createFakePort({ results: [textResult("42")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: okPort.start, cwd: process.cwd() })
  const tool = buildDynamicWorkflowTool({ engine })
  const ok = await tool.execute({
    script: "export const meta = { name: 'tool_ok' }\nconst r = await agent('q')\nreturn r",
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.value, "42")
  assert.match(ok.output, /"tool_ok" 完成/)

  const badEngine = new DynamicWorkflowEngine({
    startSubagent: createFakePort({ startThrows: () => new Error("seam down") }).start,
    cwd: process.cwd(),
  })
  const badTool = buildDynamicWorkflowTool({ engine: badEngine })
  const bad = await badTool.execute({ script: "export const meta = { name: 'tool_bad' }\nconst r = await agent('q')\nreturn r" })
  // start 抛错在 core 是可恢复失败(与 OpenCode session create 失败同构):run 完成,result null
  // (已知语义:全部 agent 失败时 run 仍成功返回 null;record.error 携带原因)
  assert.equal(bad.ok, true)
  assert.equal(bad.value, null)
  assert.match(bad.output, /1 agents/)
})

test("工具剥围栏:markdown 围栏脚本正常执行(与 OpenCode normalize 同语义)", async () => {
  const { start } = createFakePort({ results: [textResult("fenced")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: process.cwd() })
  const tool = buildDynamicWorkflowTool({ engine })
  const result = await tool.execute({
    script: "```js\nexport const meta = { name: 'fenced' }\nconst r = await agent('q')\nreturn r\n```",
  })
  assert.equal(result.ok, true)
  assert.equal(result.value, "fenced")
})

test("能力位:DSH 声明面(ADR-001;usageReporting=false 因 seam 无 usage 回传)", async () => {
  assert.equal(DSH_HOST_CAPABILITIES.structuredOutput, true)
  assert.equal(DSH_HOST_CAPABILITIES.usageReporting, false)
  assert.equal(DSH_HOST_CAPABILITIES.interactiveCheckpoint, false)
})

test("部分失败:parallel 塌缩 null 后 run 仍完成(engine 不吞错误面)", async () => {
  const { start } = createFakePort({ results: [failedResult("one down"), textResult("two ok")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: process.cwd() })
  const result = await engine.run({
    script: `export const meta = { name: 'partial' }
const rs = await parallel([() => agent('bad'), () => agent('good')])
return rs`,
  })
  assert.deepEqual(result.result, [null, "two ok"])
})
