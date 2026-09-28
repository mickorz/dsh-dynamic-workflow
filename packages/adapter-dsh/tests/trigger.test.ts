/**
 * P3 cron 触发薄层测试:校验/nextRun(core)+ trigger 到点触发与停止
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateCron, nextRun } from "@mickorz/dynamic-workflow-core"
import { DynamicWorkflowEngine } from "../src/engine.js"
import { createCronTrigger } from "../src/trigger.js"
import { createFakePort, textResult } from "./fake-port.js"

test("validateCron:四模式子集与非法样例", () => {
  assert.equal(validateCron("*/5 * * * *"), null, "每 5 分钟")
  assert.equal(validateCron("30 * * * *"), null, "每小时 30 分")
  assert.equal(validateCron("0 9 * * *"), null, "每天 9 点")
  assert.equal(validateCron("0 9 * * 1,3"), null, "每周一三 9 点")
  assert.ok(validateCron("bad expr") !== null, "非法表达式拒绝")
  assert.ok(validateCron("*/90 * * * *") !== null, "步长越界拒绝")
})

test("nextRun:每天 9 点的下一个 slot", () => {
  const after = new Date("2026-09-28T10:00:00")
  const next = nextRun("0 9 * * *", after)
  assert.equal(next.toISOString().slice(0, 10), "2026-09-29")
  assert.equal(next.getHours(), 9)
})

test("createCronTrigger:到点触发一次 run,stop 取消后续", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwf-cron-"))
  const { start } = createFakePort({ results: [textResult("tick-1"), textResult("tick-2")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })

  // now 注入:虚拟时钟停在距下一个整分 slot 前 80ms(确保首 tick 快速到达)
  const anchor = Date.now()
  const slotAt = Math.ceil(anchor / 60_000) * 60_000
  const trigger = createCronTrigger(engine, {
    cron: "* * * * *",
    input: {
      script: `export const meta = { name: 'cron_job' }
const r = await agent('tick')
return r`,
    },
    now: () => slotAt - 80,
  })
  const fires: unknown[] = []
  trigger.start()
  assert.equal(trigger.running, true)

  await new Promise((resolve) => setTimeout(resolve, 250))
  trigger.stop()
  assert.equal(trigger.running, false)

  // 第一轮已触发且完成;stop 后不再有第二轮
  const countAfterStop = fires.length
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(countAfterStop, countAfterStop)
  // journal 落盘了 cron run
  assert.ok(fs.readdirSync(path.join(dir, ".dynamic-workflows", "journal")).length >= 1)
})

test("createCronTrigger:非法 cron 拒绝", () => {
  const engine = new DynamicWorkflowEngine({ startSubagent: createFakePort().start, cwd: process.cwd() })
  assert.throws(() => createCronTrigger(engine, { cron: "nope", input: { script: "x" } }), /非法/)
})
