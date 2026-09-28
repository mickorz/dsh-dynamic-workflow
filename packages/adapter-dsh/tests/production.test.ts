/**
 * P2 Production 验收 —— 后台运行 / 超时与重试 / worktree 隔离 / 同步切片超时
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"
import { DynamicWorkflowEngine } from "../src/engine.js"
import { BackgroundRunManager } from "../src/background-runs.js"
import { buildDynamicWorkflowTool, buildWorkflowControlTool } from "../src/index.js"
import { createFakePort, textResult } from "./fake-port.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dwf-p2-"))
}

const ok = (text: string) => textResult(text)

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil 超时")
    await new Promise((r) => setTimeout(r, 25))
  }
}

test("后台运行:立即返回 runId,完成态可查询,结果与 journal 落盘一致", async () => {
  const dir = tmpProject()
  const { start } = createFakePort({ results: [ok("bg-1"), ok("bg-2")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const manager = new BackgroundRunManager()
  const tool = buildDynamicWorkflowTool({ engine, background: manager })

  const launched = await tool.execute({
    script: `export const meta = { name: 'bg_job' }
const a = await agent('one')
const b = await agent('two')
return a + '|' + b`,
    background: true,
  })
  assert.equal(launched.ok, true)
  assert.match(launched.output, /后台工作流已启动/)
  const runId = launched.runId
  assert.ok(runId, "返回 runId")

  await waitUntil(() => {
    const [info] = manager.status(runId)
    return info !== undefined && info.status === "completed"
  })
  const [info] = manager.status(runId)
  assert.equal(info.name, "bg_job")
  assert.equal(info.value, "bg-1|bg-2")
  assert.equal(info.agents.length, 2)

  // journal 已落盘(可续跑)
  assert.ok(fs.existsSync(path.join(dir, ".dynamic-workflows", "journal", `${runId}.json`)))
})

test("后台运行:非法脚本同步拒绝(不产生 run);stop 后终态 aborted", async () => {
  const dir = tmpProject()
  const port = createFakePort()
  const engine = new DynamicWorkflowEngine({ startSubagent: port.start, cwd: dir })
  const manager = new BackgroundRunManager()
  const tool = buildDynamicWorkflowTool({ engine, background: manager })

  const bad = await tool.execute({ script: "await agent('x')\nreturn 1", background: true })
  assert.equal(bad.ok, false)
  assert.match(bad.output, /脚本预验|meta/)
  assert.equal(manager.status().length, 0, "非法脚本不注册 run")

  // 停止:hang agent 的后台 run
  const dir2 = tmpProject()
  const hang = (signal?: AbortSignal) =>
    new Promise<{ output: []; stopReason: "cancelled" }>((resolve) => {
      const s = signal ?? new AbortController().signal
      if (s.aborted) return resolve({ output: [], stopReason: "cancelled" })
      s.addEventListener("abort", () => resolve({ output: [], stopReason: "cancelled" }), { once: true })
    })
  const { start: start2 } = createFakePort({ results: [hang] })
  const engine2 = new DynamicWorkflowEngine({ startSubagent: start2, cwd: dir2 })
  const manager2 = new BackgroundRunManager()
  const tool2 = buildDynamicWorkflowTool({ engine: engine2, background: manager2 })
  const launched = await tool2.execute({
    script: `export const meta = { name: 'bg_hang' }\nconst r = await agent('hang')\nreturn r`,
    background: true,
  })
  const runId = launched.runId
  await waitUntil(() => manager2.status(runId)[0] !== undefined)
  const control = buildWorkflowControlTool(manager2)
  const stopped = await control.execute({ operation: "stop", runId })
  assert.equal(stopped.ok, true)
  await waitUntil(() => manager2.status(runId)[0].status === "aborted")
  const [info] = manager2.status(runId)
  assert.equal(info.status, "aborted")
})

test("run 级超时:agentTimeoutMs 触发后按可恢复失败处理(retry 后 null)", async () => {
  const dir = tmpProject()
  const never = (): Promise<{ output: { type: "text"; text: string }[]; stopReason: "completed" | "cancelled" | "error" }> => new Promise(() => {})
  const { start, calls } = createFakePort({ results: [never] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'timeout_run' }
const r = await agent('slow')
return r ?? 'timed-out-null'`,
    agentTimeoutMs: 80,
  })
  assert.equal(result.result, "timed-out-null")
  assert.equal(result.agents[0].status, "failed")
  assert.match(result.agents[0].error ?? "", /超时/)
  assert.ok(calls.requests.length >= 1)
})

test("run 级重试:agentRetries=2 时失败自动重试后成功", async () => {
  const dir = tmpProject()
  const { start, calls } = createFakePort({
    results: [
      { output: [], diagnostic: "x1", stopReason: "error" },
      { output: [], diagnostic: "x2", stopReason: "error" },
      ok("third"),
    ],
  })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'retry_run' }
const r = await agent('flaky')
return r`,
    agentRetries: 2,
  })
  assert.equal(result.result, "third")
  assert.equal(calls.requests.length, 3)
})

test("worktree 隔离:isolation worktree 在独立 git worktree 中运行并自动拆除", async () => {
  const dir = tmpProject()
  // 建一个 git 项目(worktree 需要;git commit 需至少一个文件)
  fs.writeFileSync(path.join(dir, "base.txt"), "base", "utf-8")
  execSync("git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init", { cwd: dir })
  const { start, calls } = createFakePort({ results: [ok("iso-done")] })
  const engine = new DynamicWorkflowEngine({ startSubagent: start, cwd: dir })
  const result = await engine.run({
    script: `export const meta = { name: 'iso' }
const r = await agent('write-file', { isolation: 'worktree' })
return r`,
  })
  assert.equal(result.result, "iso-done")
  // prompt 注入了工作目录(独立 worktree 内操作的语义说明)
  assert.match(String(calls.requests[0].prompt[0]?.text), /独立(的)? git worktree|工作目录/, "worktree prompt 注入")
  // 结束后 worktree 拆除:无残留 worktree 分支目录
  const worktrees = execSync("git worktree list --porcelain", { cwd: dir, encoding: "utf8" })
  assert.equal(worktrees.split("worktree ").length - 1, 1, "主 worktree 之外无残留")
})

test("同步切片超时:vm 死循环被 syncTimeout 杀死而非挂死宿主", async () => {
  const { runScriptInVm } = await import("@mickorz/dynamic-workflow-executor-vm")
  const body = "while (true) {}"
  await assert.rejects(
    () => runScriptInVm(body, "spin", {}, 200),
    (error: unknown) => {
      // node:vm 同步抛出 ERR_SCRIPT_EXECUTION_TIMEOUT;跨模块边界 instanceof 不可靠,按 code/消息判定
      const code = (error as { code?: string })?.code
      const message = (error as Error)?.message ?? ""
      return code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(message)
    },
    "同步死循环应在 syncTimeout 内被杀",
  )
})
