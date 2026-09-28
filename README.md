# Dynamic Workflows

Advanced workflow runtime for AI coding agents.

**Durable. Composable. Resumable. Verifiable. Human-in-the-loop.**

一套跨宿主(Agent Harness)的动态工作流运行时:Main Agent 生成 JavaScript 编排脚本,Runtime 沙箱执行,`agent() / parallel() / pipeline() / sequence() / fallback() / race()` 派发子代理并行工作,脚本内汇总后仅返回最终结果,避免大规模并行任务的上下文污染。

## 宿主(Hosts)

| 宿主 | 包 | 状态 |
|---|---|---|
| OpenCode | `@mickorz/opencode-dynamic-workflows` | 生产(与原独立插件行为零变化) |
| DeepSeek Harness (DSH) | `@mickorz/dynamic-workflow-adapter-dsh` | fake-port 契约验证全绿;真机联调点见 glue.ts |

架构:`packages/core`(宿主无关编排核心,零宿主依赖,CI 边界守门)+ `packages/executor-vm`(node:vm 执行后端)+ 宿主 adapter。架构决策见 [Docs/可行性分析.md](Docs/可行性分析.md)(Architecture Decision v1,已冻结;本地)与 ADR 系列。

## 快速上手(DSH adapter,编程面)

```ts
import {
  DynamicWorkflowEngine,
  BackgroundRunManager,
  buildDynamicWorkflowTool,
  buildWorkflowControlTool,
  createCronTrigger,
} from "@mickorz/dynamic-workflow-adapter-dsh"

const engine = new DynamicWorkflowEngine({
  startSubagent: (request) => ctxSubagentsStart("spawn", request), // glue:接宿主 subagent seam
  cwd: projectDir,
})

// 前台:阻塞直到脚本 return
const out = await engine.run({ script })

// 后台:立即返回 runId,经 control 工具查询/停止;中断后可 resume
const manager = new BackgroundRunManager()
const tool = buildDynamicWorkflowTool({ engine, background: manager })
const control = buildWorkflowControlTool(manager)

// 定时触发(Trigger 薄层;多实例去重归宿主调度器)
const trigger = createCronTrigger(engine, { cron: "*/30 * * * *", input: { script } })
trigger.start()
```

模型面:注册 `dynamic_workflow`(编排执行,支持 `background` / `resumeFromRunId` / `agentTimeoutMs` 等)与 `dynamic_workflow_control`(后台 run 的 list/status/stop)两个工具。

## DSL 参考(脚本内可用全局)

| 分组 | 全局 | 说明 |
|---|---|---|
| 执行 | `agent(prompt, opts)` | 派发子代理;opts: label / phase / schema / model("provider/modelId") / tier / timeoutMs / retries / isolation:"worktree" |
| 执行 | `parallel(thunks)` / `pipeline(items, ...stages)` | 并发(栅栏)/ 逐条多段(无跨段栅栏);可恢复失败塌缩 null |
| 执行 | `sequence(nodes)` / `fallback(nodes)` / `race(nodes)` | 串行传递 / 换候选 / 并行竞争(胜出取消兄弟) |
| 执行 | `workflow(ref, args)` | 嵌套子流程;显式路径或注册名(DSH 查 `.dynamic-workflows/workflows/`) |
| 验证 | `check(cond, msg)` / `fileExists` / `commandSuccess` | 确定性事实(不达标 = 可恢复失败) |
| 验证 | `verify(item, {reviewers, threshold, lens})` | 对抗式评审投票 |
| 验证 | `judgePanel(candidates, {judges, rubric})` | 评审团打分择优 |
| 人工 | `checkpoint({id, message, payload, defaultAction, timeoutMs})` | 五态状态机(ADR-004);拒绝 = 强停止 |
| 可靠 | `retry(thunk, {attempts, until})` / `setConcurrency(n)` | 有界重试 / 动态并发 |
| 辅助 | `phase(title)` / `log(msg)` / `args` | 进度分组 / 叙事 / 工具入参 |

脚本契约:首条语句 `export const meta = { name, description, phases? }`;禁 `Date.now() / Math.random() / new Date() / import`(resume 确定性);`agent()` 至少一次;return 的 JSON 值即结果。

## 示例

见 [packages/adapter-dsh/examples/](packages/adapter-dsh/examples/)(fan-out 调研 / 评审团 / 对抗验证 / 人工门禁 / 容错流水线),冒烟测试守门,永不失效。

## 副作用红线(必读)

> **journal/resume 保证的是 Workflow 执行的回放语义,不天然保证外部系统副作用的 exactly-once;外部 effect 应通过幂等键或补偿机制控制。**

- 已完成的 agent 在 resume 时**直接回放缓存结果,不会重新调用子代理**(副作用不重复触发);
- 但 hash miss(prompt 变更)会使该调用重跑,**外部副作用随之重发 —— 这是设计内行为**;
- race 的被取消兄弟在 resume 时会重跑一次再被取消,取消前的进行中调用可能已产生部分副作用;
- 生产环境的不可逆操作(发消息、建 Issue、改库)请自行设计幂等键(未来版本评估提供 `idempotencyKey` / `effect()` 原语)。

## 目录约定(DSH 宿主)

```
<project>/.dynamic-workflows/
├── journal/<runId>.json      # 运行 journal(resume 回放源;原子写)
├── workflows/                # workflow() 按名引用的注册表
└── model-tiers.json          # tier 名 -> "provider/modelId" 分层配置
```

## 开发

```bash
npm install
npm run build      # 全部包构建
npm test           # 全部包测试(core 163 + opencode 162 + adapter-dsh 49)
npm run boundary   # core 依赖边界检查(禁宿主/执行器 import)
```

## 路线图(全部完成)

P-1 Core Extraction(行为零变化)-> P0 Architecture Spike -> P0.5 Durability Spike(六场景中断-续跑)-> P1 差异化能力(全 DSL)-> P1.5 HITL(checkpoint 五态)-> P2 Production(后台/超时配额/worktree/同步切片超时)-> P3 生态(示例集/cron 触发薄层)。

P2 说明:后台运行、run 级超时/重试参数面、worktree 隔离、vm 同步切片超时(syncTimeoutMs,默认 5000ms)已交付;**executor-ptc 完整进程隔离后端推迟**至真机需求牵引(异步回调内的新同步自旋需进程级隔离,WorkflowExecutor 接口已备,届时新增包不动 core)。

同样按真机需求后置:durable Chat 记录对齐、client UI 增强、`idempotencyKey`/`effect()` 原语。
