---
description: "YXSpec 步骤驱动：两个工具，一个报告各阶段进度，一个把流程恰好推进一格，并在离开的那一步产物缺失时拒绝推进。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-step

[English](README.md) | 中文

## 概述

用 `dsh-yxspec-step` 让 ASPICE 流程一次只走一步，而不必相信智能体声称自己完成了：`yxspec_status` 报告各阶段所处位置，`yxspec_next` 返回当前步骤的契约并推进游标。凡受控部署，都应与领域服务和台账一同挂载。推进由磁盘状态而非自述决定，因此产物从未落盘的步骤会被拒绝，并列出缺失路径；`yxspec_next` 始终是推动流程向前的唯一被认可方式。冻结的 ❄ 步骤会带着标记返回，调用方据此知道应当停下询问。

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

注册这两个工具；智能体此后只通过它们走完流程。

### 何时选用

凡期望智能体自己遵循阶段模型的部署都应选用它，因为它就是"下一步做什么"的出口。只强制门禁、不驱动智能体的部署可以省略它，但那样任何步骤契约都不会被渲染，流程也就没有游标。其默认行为无需配置；仅当省略 `stage` 的调用应从首个已声明阶段之外的地方开始时，才需要设置 `defaultStage`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-step'
  config:
    defaultStage: SWE.1
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultStage` | 首个已声明阶段 | 调用省略阶段时驱动的起始阶段 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-yxspec-step)是全部可接受字段的完整来源。

### 步骤契约从何而来

`yxspec_next` 从部署自身的阶段模型与 `.agents/skills/yxspec-<阶段>/steps` 下的 skill 单元渲染契约，同一次调用还把该步骤记为发起调用的智能体当前所处步骤。正是这一写入被[阶段门禁](../yxspec-gate/README.zh.md)与[冻结点](../yxspec-freeze/README.zh.md)在下一次工具调用时读取，因此经由本包推进就是使门禁就位的动作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本插件声明 `inject = ['tools', 'yxspec', 'yxspecArtifacts']` 并注册两个工具。`yxspec_status` 是只读的：它遍历 `ctx.yxspec.stages()`，对每个阶段询问 `ctx.yxspec.status(stage.id, p => ctx.yxspecArtifacts.landed(p))`，因此进度读自文件系统而非任何先前的声称，随后报告标识、根路径与每阶段一行。

`yxspec_next` 先解析目标步骤——给定 `step` 参数时用显式值，否则用当前步骤的后继——然后施加推进门禁。`stepOutputs(step)` 返回的是 `step.requiredInputs` 而非另一份输出清单，因此一步的产物就是下一步列出为输入的那些产物，只有一个事实来源；终末步骤没有后继，也就没有需要满足的门禁。离开的那一步的产物经 `ctx.yxspecArtifacts.missingOf` 检查，结果非空即拒绝推进并逐一列出缺失路径，而不是采信智能体的说法。所得契约由阶段与步骤记录连同单元目录渲染而成；执行携带智能体时，目标会被记为该智能体当前所处步骤——按智能体而非全局，因此扇出工作流中的 worker 不会互相以对方进度为准。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 两个工具、步骤产物规则，以及契约渲染器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——这两个工具所遍历的阶段模型，以及它们观测的 `yxspec/artifact-write` 事件。
- [领域服务](../yxspec/README.zh.md)——本驱动所写入的阶段模型与按智能体的当前步骤。
- [产物台账](../yxspec-artifact/README.zh.md)——每个推进决策背后的落盘检查。
- [阶段门禁](../yxspec-gate/README.zh.md)——读取本驱动所记录当前步骤的钩子。
- [冻结点](../yxspec-freeze/README.zh.md)——`frozen` 标志所导向的人工确认。
- [Tools 子系统](../../../docs/subsystems/tools.zh.md)——两个工具经过的注册与管线。

-----

<a id="model-experience"></a>
## 模型体验

### 步骤契约

#### 模型所见

`yxspec_next` 每次调用返回一份契约，由部署的阶段模型渲染并作为工具结果的文本返回。正文是本包自有的中文散文，以带标签的行排布，冻结标记是那段字面量的一部分而非单独的提示；这是驱动告诉模型一步由什么构成的唯一位置。状态报告是第二种只读形状：一份 JSON 文档，列出标识、根路径，以及每阶段一行，含 `currentStep`、`complete` 与 `stepCount`。

#### Token 影响

首次调用前无直接 token。`yxspec_next` 随后加入一份契约正文——长度受已声明输入数量与是否存在门脚本约束——`yxspec_status` 每阶段加入一行 JSON。这里没有任何内容被前置到请求上，因此代价只由提问的那几轮承担。

#### KV Cache 影响

仅追加。两者都是 Session 日志中的普通新增，不改写 system prompt、工具提供集合或任何更早的消息，因此此前对话的提供方缓存复用得以保留。以相同参数再次读取状态会新增一个块，而不是修改先前的块。

### 推进拒绝

#### 模型所见

被拒绝的推进以 `ok: false` 载荷返回而非工具错误，因此模型把理由读作可据以行动的数据。拒绝会点名被离开的那一步以及每一条缺失路径，这正是"你不得推进"与"这两个文件就是原因"之间的差别。某一步恰好是其阶段最后一步时也以同样方式报告，并带 `complete: true`。

##### 产物缺失拒绝

```markdown
{
  "ok": false,
  "stage": "SWE.1",
  "blockedAt": "SWE.1.2",
  "missing": ["project/inputs/requirements.md"],
  "error": "上一步 SWE.1.2 的产物未落盘，不得推进。"
}
```

#### Token 影响

除拒绝载荷本身外无直接 token，该载荷是一份很短的 JSON 文档，逐一列出缺失路径。模型随后在"补齐产物"与"停下"之间选择，两种选择都要再花一次请求。

#### KV Cache 影响

仅追加，与任何其他工具结果相同。拒绝只新增一个块，不改写更早的内容，因此它本身不会使可复用前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一步的产物就是其后继的输入** — `stepOutputs` 返回 `requiredInputs`，因此某步产出但没有后续步骤声明为输入的产物无法被门禁覆盖，终末步骤则完全没有门禁。
- **存在性就是全部推进判据** — 台账回答的是路径是否为可读文件，因此产物被创建但内容为空时仍然过门。
- **对离开步骤的门禁属纵深防御** — `status()` 只会点名自身输入已落盘的步骤，而 `stepOutputs` 是同一份清单，因此该守卫的 `missing` 列表在构造上为空；它保留是因为两条规则写在不同位置。
- **当前步骤只存在内存中** — 被记录的当前步骤不持久化，因此宿主重启后游标丢失，下次调用从磁盘重新推导。
- **单元目录是写死的** — 契约渲染 `.agents/skills/yxspec-<阶段>/steps`，无可配置项，因此把单元放在别处的部署会得到无法解析的路径。
- **契约文本未做本地化** — 渲染出的正文是固定中文散文，因此纯英文部署会让操作者与模型都看到中文。
- **跳到显式步骤仍走同一门禁** — 传入 `step` 可以跳过若干步，但不会绕过检查，因此跳转无法用来逃离被阻塞的前置步骤。
- **阶段 id 每次调用只解析一次** — 目标阶段在任何 await 之前查得，因此调用途中的阶段模型变化不会被重新读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
