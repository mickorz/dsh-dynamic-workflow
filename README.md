# Dynamic Workflows

Advanced workflow runtime for AI coding agents.

**Durable. Composable. Resumable. Verifiable. Human-in-the-loop.**

一套跨宿主(Agent Harness)的动态工作流运行时:Main Agent 生成 JavaScript 编排脚本,Runtime 沙箱执行,`agent() / parallel() / pipeline() / sequence() / fallback() / race()` 派发子代理并行工作,脚本内汇总后仅返回最终结果,避免大规模并行任务的上下文污染。

## 宿主(Hosts)

| 宿主 | 包 | 状态 |
|---|---|---|
| OpenCode | `@mickorz/opencode-dynamic-workflows` | 生产(与原独立插件行为零变化) |
| DeepSeek Harness (DSH) | `@mickorz/dynamic-workflow-adapter-dsh` | P0.5 Spike(fake-port 契约验证);真机联调点见 glue.ts |

架构:`packages/core`(宿主无关编排核心,零宿主依赖,CI 边界守门)+ `packages/executor-vm`(node:vm 执行后端)+ 宿主 adapter。详见 [Docs/可行性分析.md](Docs/可行性分析.md)(Architecture Decision v1,已冻结)与 [Docs/ADR/](Docs/ADR/)。

## 副作用红线(必读)

> **journal/resume 保证的是 Workflow 执行的回放语义,不天然保证外部系统副作用的 exactly-once;外部 effect 应通过幂等键或补偿机制控制。**

- 已完成的 agent 在 resume 时**直接回放缓存结果,不会重新调用子代理**(副作用不重复触发);
- 但 hash miss(prompt 变更)会使该调用重跑,**外部副作用随之重发 —— 这是设计内行为**;
- race 的被取消兄弟在 resume 时会重跑一次再被取消,取消前的进行中调用可能已产生部分副作用;
- 生产环境的不可逆操作(发消息、建 Issue、改库)请自行设计幂等键(未来版本评估提供 `idempotencyKey` / `effect()` 原语)。

## 开发

```bash
npm install
npm run build      # 全部包构建
npm test           # 全部包测试(core 163 + opencode 162 + adapter-dsh 21)
npm run boundary   # core 依赖边界检查(禁宿主/执行器 import)
```

路线图:P-1 Core Extraction(完成)-> P0 Architecture Spike(完成)-> P0.5 Durability Spike(完成)-> P1 差异化能力(完成)-> P1.5 HITL(完成)-> P2 Production(完成)-> P3 生态。

P2 说明:后台运行(BackgroundRunManager + dynamic_workflow_control)、run 级超时/重试参数面、worktree 隔离、vm 同步切片超时(syncTimeoutMs,默认 5000ms)已交付;**executor-ptc 完整进程隔离后端推迟**至真机需求牵引(异步回调内的新同步自旋需进程级隔离,WorkflowExecutor 接口已备,届时新增包不动 core)。
