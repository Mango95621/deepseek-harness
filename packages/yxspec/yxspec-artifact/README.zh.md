---
description: "YXSpec 产物台账：以磁盘上的存在性作为某一步是否完成的判据，取代智能体的自述。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-artifact

[English](README.md) | 中文

## 概述

把 `dsh-yxspec-artifact` 当作流程询问"这一步的工作真的发生了吗"的唯一位置：它针对阶段模型声明的工作区相对路径回答存在性查询，且每次查询都重新 stat 文件系统。凡运行受控流程的部署，都应在领域服务旁边挂载它；步骤驱动与两个门禁钩子都注入 `ctx.yxspecArtifacts`。因为答案来自磁盘而非智能体的一面之词，产物从未落盘的步骤无法推进，而带外删除文件会让对应步骤退回门禁失败。它可选地在每次观察到的写入上发出一个事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把台账挂在领域服务旁边，让各道门禁去问它什么已落盘。

### 何时选用

凡流程受控的场合都应选用它，因为它是唯一依据真实状态判定完成的组件——[步骤驱动](../yxspec-step/README.zh.md)、[阶段门禁](../yxspec-gate/README.zh.md)与 [Remote owner](../yxspec-api/README.zh.md)都消费它。只想渲染阶段模型而不要任何门禁的部署则不需要它。台账没有需要预热的累积状态，因此挂载它在启动时不产生开销。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-artifact'
  config:
    emitIntervalMs: 0
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `emitIntervalMs` | `0` | `yxspec/artifact-write` 事件的发出间隔；为零时关闭发出而查询照常工作 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-yxspec-artifact)是全部可接受字段的完整来源。

### 询问什么已落盘

`landed(rel)` 回答单个路径，`landedOf(rels)` 与 `missingOf(rels)` 按输入顺序回答一批。两个批量方法都对每一项调用单路径检查而非发起一次目录遍历，因为阶段声明的路径不一定同属一个目录，而部分答案比更慢的答案更糟。

`isDeclared(rel)` 报告是否有任何阶段步骤把该路径列为必需输入，这正是部署得以区分"流程在意的产物"与"一次普通文件写入"的依据。`observe(rel)` 记录一次写入并对外公开，因此带外监视器也能喂给台账；插件自身的钩子会为宿主执行的写入调用它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`YxspecArtifactLedger` 在 `yxspecArtifacts` 键下扩展 Cordis `Service`，并从 `ctx.yxspec.root` 解析其根，因此它回答的每条路径都与各门禁做相对化时所用的基准相同。`landed` 在 `try` 内执行一次 `stat`，对任何失败返回 `false`，从而把"不存在"、"是个目录"与"不可读"并成一个诚实的答案：门禁想知道的是产物是否在那里可被读取，而这三者都意味着不是。

该类刻意不保存任何已观察写入的集合。累积集合会依据历史作答，把已删除的文件报为存在，因此 `landed` 每次调用都重新 stat，而 `observe` 只为那个可选事件以及它返回的字节数而存在。`emitIntervalMs` 是正整数设置，因为该事件是诊断取样口而非正确性机制；台账在取零时表现完全相同。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 台账服务、其存在性查询，以及可选观察事件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——台账的词汇与 `yxspec/*` 事件。
- [领域服务](../yxspec/README.zh.md)——台账为其已声明输入作答的阶段模型。
- [步骤驱动](../yxspec-step/README.zh.md)——在产物缺失时拒绝推进的消费方。
- [阶段门禁](../yxspec-gate/README.zh.md)——在某步输入缺失期间拒绝调用的钩子。
- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——观察钩子所跟随的宿主 seam。

-----

<a id="model-experience"></a>
## 模型体验

无，因为台账为其消费方回答存在性查询，并发出一个仅写日志、没有模型请求读取的观察事件。

#### KV Cache 影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **存在性就是全部判据** — 台账只回答某路径是否为可读文件，对其内容、大小或新鲜度一无所知。被写出来但从未填写的产物仍然过门，因为陈旧的文件也是文件。
- **批量检查每条路径一次 stat** — `landedOf` 与 `missingOf` 对每一项调用单路径检查，因此声明许多输入的阶段每次调用都要付出相应次数的 stat，而 Remote 的 `status` 路由会对每个被请求阶段重复这一过程。
- **观察钩子只看到宿主写入** — `yxspec/artifact-write` 只为宿主执行的写入触发，因此带外进程创建的文件对 `landed` 可见，却从不产生事件。要从监视器喂事件需要直接调用 `observe`。
- **目录缺失与文件缺失无法区分** — 根不存在会使它下面每条路径都被读作不存在，因此配置错误的 `workspaceRoot` 看起来与"什么都没产出的项目"一模一样。
- **事件是选择加入且不批处理的** — `emitIntervalMs` 为正时台账对每次观察到的写入发出一个事件且不合并，因此批量写入会产生一阵突发。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
