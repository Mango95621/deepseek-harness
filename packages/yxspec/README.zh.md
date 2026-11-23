---
description: "YXSpec 包组：ASPICE 阶段模型、由宿主强制执行的各类门禁、盲派发与远程编译验证。"
kind: "package-group"
---

# yxspec/ — 受控 ASPICE 研发流程

[English](README.md) | 中文

## Summary

YXSpec 包族把 ASPICE 软件流程从"每步请智能体自觉遵守"的文字约定，变成由宿主强制执行的拦截。领域服务持有阶段模型、双轨映射与规格标识；其余包据此进行门禁、推进、派发与验证。完成状态读自磁盘上的产物，而非智能体的汇报，因此产物从未落盘的步骤无法推进，已冻结的产物不经变更请求不得改写。项目需要留下可审计的过程轨迹时选用这些包；浏览器面板渲染的正是门禁所依据的同一份模型。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`yxspec/`](yxspec/README.zh.md) | 持有 ASPICE 阶段模型、双轨映射与规格标识；自身不施加任何约束 | `ctx.yxspec` |
| [`yxspec-artifact/`](yxspec-artifact/README.zh.md) | 回答声明的产物是否已落盘，每次查询都重新 stat | `ctx.yxspecArtifacts` |
| [`yxspec-step/`](yxspec-step/README.zh.md) | 暴露 `yxspec_status` 与 `yxspec_next`：一次一步，产物缺失时拒绝推进 | registers on `ctx.tools` |
| [`yxspec-gate/`](yxspec-gate/README.zh.md) | 拒绝会改写已冻结产物、或在步骤输入缺失时运行的工具调用 | registers on `ctx.tools` |
| [`yxspec-freeze/`](yxspec-freeze/README.zh.md) | 将 ❄ 步骤的调用路由到 `ctx.approval`，无人应答即保持关闭 | registers on `ctx.tools` |
| [`yxspec-api/`](yxspec-api/README.zh.md) | 向桌面客户端发布阶段模型与构建服务器列表 | `ctx.yxspecController`、`ctx.yxspecRemoteController` |
| [`yxspec-dispatch/`](yxspec-dispatch/README.zh.md) | 渲染并落盘 worker 提示词，返回哈希句柄而非正文 | `ctx.yxspecDispatch` |
| [`yxspec-remote/`](yxspec-remote/README.zh.md) | 声明构建服务器，并通过 OpenSSH 执行编译配方 | `ctx.yxspecRemote` |
| [`ui-yxspec`](../client/ui-yxspec/README.zh.md) | 渲染阶段面板，并把空白会话挡在引导流程之后 | —（浏览器） |

-----

<a id="related-documentation"></a>
## Related documentation

- [YXSpec 子系统](../../docs/subsystems/yxspec.zh.md) — 各服务、产物台账词汇，以及 `yxspec/*` 事件。
- [Tools](../../docs/subsystems/tools.zh.md) — 每个门禁钩子所运行的受控执行管线。
- [用户审批](../../docs/subsystems/approval.zh.md) — 冻结点所需的一次性授权及其 `unavailable` 结果。
- [Subprocess](../../docs/subsystems/subprocess.zh.md) — 远程编译服务驱动 OpenSSH 所经的 seam。
- [新增包](../../docs/cookbook/adding-a-package.zh.md) — 本包族所遵循的组与包布局。

<a id="dev-note"></a>
## Dev Note

None.
