/**
 * 示例冒烟:EXAMPLES 每个脚本经 engine 跑通(示例永不失效的守门测试)
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DynamicWorkflowEngine } from "../src/engine.js"
import { createFakePort, structuredResult, failedResult } from "./fake-port.js"
import { EXAMPLES } from "../examples/examples.js"

const ok = (text: string) => ({ output: [{ type: "text", text }], stopReason: "completed" as const })

/** 每个示例的 fake 结果序列(start 顺序) */
function fakeResultsFor(name: string): unknown[] {
  switch (name) {
    case "fan-out-research":
      return [ok("性能要点"), ok("安全要点"), ok("兼容性要点"), ok("汇总结论")]
    case "multi-angle-review":
      return [
        structuredResult({ score: 0.9 }), structuredResult({ score: 0.8 }),   // 方案甲 x2
        structuredResult({ score: 0.5 }), structuredResult({ score: 0.4 }),   // 方案乙 x2
        structuredResult({ score: 0.7 }), structuredResult({ score: 0.6 }),   // 方案丙 x2
      ]
    case "verify-claim":
      return [
        structuredResult({ real: true, reason: "r1" }),
        structuredResult({ real: true, reason: "r2" }),
        structuredResult({ real: false, reason: "r3" }),
      ]
    case "gate-then-deploy":
      return [ok("计划:1.发布 2.观察"), ok("上线完成")]
    case "resilient-pipeline":
      // a 成功;b 首次失败(retries:1)后重试成功;c 成功
      return [ok("a-done"), failedResult("b 瞬时故障"), ok("b-done"), ok("c-done")]
    default:
      return [ok("fallback")]
  }
}

for (const example of EXAMPLES) {
  test(`示例冒烟:${example.file}(${example.summary})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwf-ex-"))
    const { start } = createFakePort({ results: fakeResultsFor(example.file.replace(/\.js$/, "")) as never })
    const engine = new DynamicWorkflowEngine({
      startSubagent: start,
      cwd: dir,
      confirm: example.file === "gate-then-deploy.js"
        ? () => Promise.resolve(true)
        : undefined,
    })
    const result = await engine.run({ script: example.script })
    assert.ok(result.agentCount >= 1, "至少一个 agent")

    // 定点断言(与示例语义绑定的最小面)
    if (example.file === "fan-out-research.js") {
      assert.equal(JSON.stringify((result.result as { findings: string[] }).findings), JSON.stringify(["性能要点", "安全要点", "兼容性要点"]))
    }
    if (example.file === "multi-angle-review.js") {
      assert.equal((result.result as { index: number }).index, 0, "方案甲均分 0.85 胜出")
    }
    if (example.file === "verify-claim.js") {
      const v = result.result as { real: boolean; total: number }
      assert.equal(v.total, 3)
      assert.equal(v.real, true, "2/3 >= 0.6 判真")
    }
    if (example.file === "gate-then-deploy.js") {
      assert.equal(JSON.stringify(result.result), JSON.stringify({ deployed: true, result: "上线完成" }))
    }
    if (example.file === "resilient-pipeline.js") {
      assert.equal(JSON.stringify(result.result), JSON.stringify({ ok: 3, failed: [] }))
    }
  })
}
