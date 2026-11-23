---
description: "YXSpec 能力 seam：ASPICE 阶段模型、双轨（MCU/MPU）领域映射，以及宿主强制执行的各道流程门禁所读取的规格标识。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec

[English](README.md) | 中文

## 概述

把 `dsh-yxspec` 当作一条 YXSpec 流程形状的唯一声明处：ASPICE 阶段、各阶段内的步骤、步骤运行前必须已有的产物，以及需要人工介入的冻结 ❄ 点。它还持有规格标识与双轨（MCU/MPU）领域映射。凡运行受控流程的部署都应挂载它；门禁、冻结、步骤驱动与台账都注入 `ctx.yxspec`，浏览器面板读取的也是同一份模型。该服务自身不施加任何约束——它只回答问题。按智能体划分的步骤归属，使扇出工作流中的 worker 不会以彼此进度为准。

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

挂载该服务并声明你的阶段模型；各强制执行包会读取它。

### 何时选用

凡运行受控 YXSpec 流程的部署都应选用它，因为它是各强制执行包所注入的 seam——缺少它，那些包会一直处于 pending，任何规则都不会生效。其默认阶段模型与随发行版提供的 `yxspec-swe-*` 技能所实现的 SWE.1–SWE.5 阶段一致，因此遵循该布局的项目完全不需要 `stages` 配置。运行其他流程的部署整体替换该清单；带 `yxspec.json` 的工作区则从项目自有文件取规格标识，而不必在组合中重述。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec'
  config:
    workspaceRoot: .
    projectConfigPath: yxspec.json
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `workspaceRoot` | cwd | 流程所处的工作区根；相对路径按 cwd 解析 |
| `identity` | 取自 `yxspec.json` | 要报告的规格标识；显式取值优先于文件 |
| `trackMapPath` | `swe-track-map.json` | 工作区相对的双轨映射；文件缺失时得到空领域清单而非失败 |
| `projectConfigPath` | — | 项目自有的 `yxspec.json`，其标识字段为 `identity` 提供种子 |
| `stages` | `DEFAULT_STAGES` | 已声明的阶段模型；替换它即让部署运行自己的流程 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-yxspec)是全部可接受字段的完整来源。

### 按智能体划分的步骤归属

`ctx.yxspec.activeStep(agent)` 读取某个智能体所处步骤，而[步骤驱动](../yxspec-step/README.zh.md)是唯一的写入方。归属按智能体而非全局，因为扇出工作流中的 worker 不得以彼此进度为准：处于不同步骤的两个 worker 各自强制自己的输入契约。没有当前步骤的门禁钩子则完全不施加步骤门禁。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该服务在 `yxspec` 键下扩展 Cordis `Service`，持有三样状态：解析后的阶段模型、解析后的标识，以及按智能体的当前步骤映射。`Config.stages` 以 `z.array(z.any())` 校验，因为阶段是部署数据，其形状已由导出的 `YxspecStage` 类型固定；数组为空时使用默认清单，因此误写的 `stages: []` 表现得像未给键，而不是静默声明"没有流程"。

`snapshot()` 每次调用都从 `trackMapPath` 读取双轨映射，并把不可读文件视为空领域清单，因此尚未运行 SWE.1 的工作区仍能解析出自己的阶段模型。标识字段按优先级解析：显式 `Config.identity` 取值，其次项目 `yxspec.json`，最后默认值。`status()` 是唯一接收落盘谓词而非自行读取文件系统的方法——这一反转使本包不依赖台账的 I/O，也让部署可以用 stat 之外的方式计算落盘。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体、其配置，以及默认 SWE.1–SWE.5 阶段模型 |
| [`src/types.ts`](src/types.ts) | 消费方所读的阶段、步骤、标识、领域与状态词汇表 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——各门禁的契约与 `yxspec/*` 事件。
- [产物台账](../yxspec-artifact/README.zh.md)——`status()` 所依据的落盘谓词。
- [步骤驱动](../yxspec-step/README.zh.md)——按智能体当前步骤的唯一写入方。
- [阶段门禁](../yxspec-gate/README.zh.md)——把这份模型变成拦截的钩子。
- [流程面板](../../client/ui-yxspec/README.zh.md)——这份模型在浏览器中的视图。
- [新增包](../../../docs/cookbook/adding-a-package.zh.md)——本包所遵循的 seam/提供方/消费方拓扑。

-----

<a id="model-experience"></a>
## 模型体验

无，因为领域服务为其消费方回答阶段、步骤与状态查询，不注册任何工具、prompt 段落或 Session 事件。

#### KV Cache 影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **模型是部署数据而非 schema** — `Config.stages` 只校验它是数组，因此畸形的阶段或步骤会在索引它的消费方处失败而非在装载时失败。编辑阶段模型的部署拿不到可据以定位的 schema 错误。
- **双轨映射按快照读取** — `snapshot()` 每次调用都重读 `trackMapPath`，而不可读或畸形的文件得到空领域清单而非诊断，因此映射里的笔误与"工作区尚未产出映射"无法区分。
- **当前步骤只存在内存中** — 按智能体的步骤归属不持久化，因此宿主重启会忘记每个智能体走到哪里。台账仍是"什么已落盘"的事实来源，驱动会在下次调用时从磁盘重新推导位置。
- **标识优先级不被报告** — 解析后的标识不记录各字段来自哪个来源，因此要排查意外规格 id 的组合必须分别检查项目文件与配置。
- **步骤 id 被假定全局唯一** — `step(stepId)` 扫描首个匹配，因此两个阶段声明同一步骤 id 时会静默互相遮蔽而非报错。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
