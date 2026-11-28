---
description: "宿主 Remote owner：把 YXSpec 阶段模型、各阶段产物落盘状态以及某个项目已声明的构建服务器发布给桌面客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-api

[English](README.md) | 中文

## 概述

用 `dsh-yxspec-api` 在桌面客户端中展示 YXSpec 流程：它通过 `yxspec` 与 `yxspecRemote` 两个 Remote 命名空间发布阶段模型、各阶段产物落盘状态与某个项目已声明的构建服务器，并接受引导向导提交的构建服务器声明。凡需要渲染流程面板之处都挂载它。两个控制器自身不持有任何规则：每个取值都来自 `ctx.yxspec` 与 `ctx.yxspecArtifacts`，也就是各门禁所依据的同一对 seam；而声明的写入走 `ctx.yxspecRemote.declare`，即 `remote_server_declare` 工具所用的同一个调用。推进步骤仍是经门禁的一次工具调用。seam 缺失会表现为带类型的错误或空清单。

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

在浏览器需要看到流程的地方加载本包，让 Web 客户端读取它发布的这两个命名空间。

### 何时选用

凡 Web bundle 挂载[流程面板](../../client/ui-yxspec/README.zh.md)的部署都应选用它。面板在 `yxspec` 命名空间上调用 `status`、`documents`、`declaredArtifacts` 与 `declaredArtifactsOf`，引导向导在 `yxspecRemote` 命名空间上调用 `servers`、`declareServer`、`probeServer` 与 `browseServer`；没有本包，这两个命名空间都不存在，两个界面都会渲染各自的不可用状态。从不展示流程的无头部署不需要 Remote owner。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-api'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| （无） | — | 本包不声明任何 `Config` 字段 |

本包不声明 `Config`：它投影的两条 seam 都在每次调用时经 `ctx.get` 读取，因此除控制器本身外，挂载它不带来别的开销。

### 投影一条缺失的 seam

两个控制器都不为各自读取的 seam 声明 `inject`，这是刻意的。声明一个会让整个插件保持 pending，于是 `ctx.yxspecController` 不存在，客户端的 `yxspec` 命名空间永不出现，面板会在没有任何诊断的情况下消失，而不是报告缺了什么。改为经 `ctx.get` 读取，就把两种情况都变成了可见状态：`status` 与 `declaredArtifacts` 抛 `yxspec/service-unavailable` 或 `yxspec/ledger-unavailable`，而 `servers` 返回空清单，因为 `ctx.yxspecRemote` 按设计是可选的，`declareServer` 则抛 `yxspecRemote/service-unavailable`——读取一无所获可以说出来，写入无处落地却不能看起来像已经落地。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`YxspecController` 在 `yxspec` 命名空间下扩展 `TypertRemoteService`，并在自身构造函数中把 `YxspecRemoteController` 作为子插件挂载，因为 `src/index.ts` 是部署点名的 Loader 入口，而每个命名空间都是独立的 Remote owner。阶段状态通过展平某个阶段内每个步骤的 `requiredInputs`、再问台账哪些缺失来计算；台账每次查询都重新 stat，因此 `landed` 反映的是当下文件系统而非缓存集合。投影出的视图携带 `hasGateScript` 而非脚本路径，因为浏览器只需要区分"这一步有决定性检查"与"没有"。

`readDocumentListing` 是对"本流程存放规范文档的两个目录"的有界枚举——每个注册根下的 `project` 与 `YX_Docs/projects`——外加上操作者在该步骤手动添加的目录，受深度与数量上限约束。候选只认 Office 文档（`.doc`、`.docx`、`.xls`、`.xlsx`、`.ppt`、`.pptx`、`.pdf`），从不认 markdown：受门禁流程的规范是交付文档，而这些树里的 markdown 是工作性文字，会把真正要找的那一份埋掉。未知项目、不存在的目录与未挂载的注册表都得到带其搜索目录的空清单，因为"还没有规范文档"是向导要渲染的一种状态（旁边就是"暂不选择"控件）而非失败。搜索结果与候选同行于同一份响应，使二者描述的是同一个文件系统状态。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `yxspec` 命名空间 owner 及其四个读取方法 |
| [`src/remote.ts`](src/remote.ts) | `yxspecRemote` 命名空间 owner：构建服务器投影，以及向导的声明写入 |
| [`src/documents.ts`](src/documents.ts) | 面向引导向导的有界候选文档枚举 |
| [`src/types.ts`](src/types.ts) | 客户端所消费的投影视图与列表类型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——本 owner 所投影的服务与 `yxspec/*` 事件。
- [领域服务](../yxspec/README.zh.md)——每个投影值所来自的阶段模型。
- [产物台账](../yxspec-artifact/README.zh.md)——回答某条已声明路径是否落盘的 seam。
- [远程编译服务](../yxspec-remote/README.zh.md)——构建服务器投影背后的 seam。
- [流程面板](../../client/ui-yxspec/README.zh.md)——读取这两个命名空间的浏览器界面。
- [Typert 协议](../../typert/protocol/README.zh.md)——本 owner 所并入的 Remote 声明与错误明细词汇表。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该 owner 通过 Remote 命名空间服务浏览器客户端，不注册任何工具、prompt 段落或 Session 事件。

#### KV Cache 影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **面板不能推进步骤** — 推进流程始终是经门禁的一次工具调用，因此 `yxspec` 命名空间不提供任何写入。想要 UI 按钮的部署没有受支持的路径，而加一个按钮会造出这套设计本就要防止的第二条不受控路径。这套界面承载的写入是「一次声明」与「一次探测的结论」，两者都不是流程步骤：存储它们的领域服务对工具路径与向导做同一份校验，而探测只改动它被给予的那一行里的 `lastProbe*` 字段。
- **seam 缺失是可见的，而不是致命的** — `status` 与 `declaredArtifacts` 抛出各自的带类型错误，`servers` 返回空清单，`declareServer` 抛 `yxspecRemote/service-unavailable`，因此部分部署的宿主会显示不可用提示或空选择器，而不是装载失败。
- **阶段状态按调用计算** — `status` 对每个被请求阶段的每条已声明输入重新 stat，因此步骤众多的阶段每次调用要为每条已声明路径付出一次文件系统 stat。仅当调用方渲染全部阶段时才省略 `landedStages`。
- **文档列表是有界的** — 候选枚举设有深度与条目上限，响应会报告是否发生了截断，而不是静默缩短列表。它遍历的两个目录是固定的，因此放在树中其他位置的规范文档，只有在操作者于该步骤手动添加该目录后才会被列出。
- **已声明产物路径未经验证** — `declaredArtifacts` 返回阶段模型点名的任何内容，包括某步骤门禁绝不会接受的路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
