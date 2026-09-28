# dsh-dynamic-workflow

**跨 Harness 的 Agent Workflow Runtime**:Durable / Composable / Resumable / Verifiable / Human-in-the-loop。从原 `@mickorz/opencode-dynamic-workflows` 抽象出宿主无关的 Runtime Core,OpenCode 与 DeepSeek Harness (DSH) 是它的两个宿主(adapter),架构上欢迎下一个 harness。

## 项目定位

DSH 官方 workflow 是"最小可信内核";本项目提供官方 Deferred 清单里的扩展层(journal/resume、嵌套 workflow、注册表、组合控制流、质量验证、checkpoint、模型分层)。**不是"给 DSH 再做一套 workflow"**。

引擎策略(见 Docs/可行性分析.md):
- P0 `mode: "standalone"`(默认):自带增强引擎,注册独立工具 `dynamic_workflow`,与官方 `workflow` 共存,不碰 `ctx.workflowEngine`;
- P1 验证稳定后可选 `mode: "replace-official"`。

执行后端经 `WorkflowExecutor` 抽象(vm 起步,PTC 为 production 路线)。

## 仓库结构(monorepo 规划)

- `packages/core/` — 宿主无关编排核心:runtime / dsl / journal / registry / nodes / contracts。**依赖边界硬化**:core 不知道 OpenCode、DSH、node:vm、PTC、Cordis、jobs、subagents,只依赖七个注入接口(AgentRunner / WorkflowExecutor / JournalStore / CheckpointChannel / EventSink / Clock / IdGenerator),CI 依赖边界测试守门
- `packages/executor-vm/`、`packages/executor-ptc/` — 执行后端(实现 WorkflowExecutor 接口;vm 为 MVP,PTC 为 production)
- `packages/adapter-opencode/` — OpenCode 宿主 adapter(现插件重构为薄壳,行为零变化)
- `packages/adapter-dsh/` — DSH 宿主 adapter + bundle + `dynamic_workflow` 工具;adapter 声明 HostCapabilities 能力位,禁止平台 if-else
- `Docs/` — 需求、知识库、可行性分析(本地忽略不入库)

## 开发路线(P-1 至 P3,详见可行性分析 v3)

- [x] **P-1 Core Extraction 完成**(行为零变化:325/325 测试全绿、core 依赖边界 CI 守门、vm.ts 拆为 core/script/parse + executor-vm)
- [x] **P0.5 Durability Spike 完成**(六场景磁盘 journal 全链全绿;ADR-003/005 定稿;副作用红线入 README)
- [x] **P0 Architecture Spike 完成**(fake-port 面):HostCapabilities 七能力位(ADR-001)、adapter-dsh(port/runner/engine/tool/glue 分层)、契约测试 15 项全绿;真机 e2e 待 DSH 环境按 glue 三联调点核对
- [x] **P1 差异化能力完成**(全 DSL 在 adapter-dsh 面验收:fallback/check/verify/judgePanel/嵌套+registry/tier/retry;registry 与 tier 目录宿主化参数注入)
- [x] **P1.5 HITL 完成**(checkpoint 五态状态机 + pending 跨中断恢复 + ADR-004;confirm abort 中止面补缺)
- [ ] P2 Production → P3 生态
- `thirdparties/` — 第三方参考源码(不纳入版本管理,见 .gitignore)
  - `opencode-dynamic-workflows/` — 原开发的 OpenCode 插件(移植蓝本)
  - `deepseek-harness/` — DeepSeek Harness 官方源码
    - `packages/workflow/` — 官方 workflow 实现(集成参考)
      - `workflow/` — `@deepseek-ai/dsh-workflow`,ctx.workflowEngine 服务、run 词汇表、workflow/* 事件
      - `workflow-ptc/` — 共享沙箱 PTC Node 进程运行时
      - `tool-workflow/` — 注册 `workflow` 工具给模型
      - `tool-ralph/` — 注册 `ralph` 工具(fresh-agent 固定循环)

## 开发规范

- TypeScript,ESM,与 deepseek-harness 包规范保持一致
- 参考文档优先读:`thirdparties/deepseek-harness/docs/subsystems/workflow.md`
- 知识库文档位于 `Docs/`,新增分析文档按主题命名存放
- 修改/新增代码前先查 `thirdparties/` 内已有实现,避免重复造轮子

## 常用参考

- 官方 workflow 子系统文档: `thirdparties/deepseek-harness/docs/subsystems/workflow.md`
- 原插件 DSL 参考: `thirdparties/opencode-dynamic-workflows/skills/workflow-authoring/references/runtime.md`
- 官方设计笔记: `thirdparties/deepseek-harness/.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md`
