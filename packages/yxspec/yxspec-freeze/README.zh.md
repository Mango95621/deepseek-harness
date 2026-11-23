---
description: "把 ASPICE ❄ 人工签核步骤路由到 ctx.approval，使无人值守的 YXSpec 流程失败关闭，而不是自行签核通过。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-freeze

[English](README.md) | 中文

## 概述

用 `dsh-yxspec-freeze` 让 ❄ 冻结点名副其实：属于冻结步骤的工具调用，在人工通过 `ctx.approval` 授权之前不会运行。凡受控部署，都应在领域服务旁边挂载它。失败模式本身才是重点——没有人在键盘前的流程会在冻结点停下，而不是自行签核通过，因为除 `allowed-once` 以外的任何一种结果都拒绝该调用。它在结构性门禁之后运行，因此在输入缺失时已经失败的调用会在用户被问到之前就被拒绝。

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

注册该钩子；此后操作一个冻结步骤都需要人工授权。

### 何时选用

凡运行受控 YXSpec 流程、且不得让无人值守会话自行批准自己冻结产物的部署都应选用它。把它与[阶段门禁](../yxspec-gate/README.zh.md)加在一起，它刻意排在其后运行。设 `enabled: false` 可退回原工具链那种仅靠散文的方式，对冻结步骤尚无实际意义的工作区有用。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-freeze'
  config:
    enabled: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `guardedTools` | `write`、`edit`、`multi_edit`、`apply_patch`、`str_replace`、`bash` | 构成"操作一个冻结步骤"、因而必须被确认的工具 |
| `enabled` | `true` | 冻结钩子是否生效；关闭后退回仅靠散文的强制方式 |

默认集合在写入族之外还包含 `bash`，因为冻结步骤的签核同时覆盖它产出的产物与产出它的命令。步骤只冻结所写产物的部署可以收窄该列表。

### 为什么结果不是布尔值

`ctx.approval.request()` 会落到四种结果之一，而只有 `allowed-once` 放行该调用。`unavailable` 意味着没有应答者接管该请求——即无人值守的情形——它与 `rejected` 和 `cancelled` 一样拒绝。把 `unavailable` 并入放行，会恰好在最需要这道门的部署上让它静默消失，因此钩子对除一次性授权以外的一切都拒绝，并在理由中点名该结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本插件声明 `inject = ['tools', 'yxspec', 'approval']`，并注册第二个 `tools/pre-execute` 监听器。监听器顺序正是让它排在[阶段门禁](../yxspec-gate/README.zh.md)之后的原因：那个插件的结构性检查先跑，因此因输入缺失而失败的调用不会去打扰用户。对不是受护工具、没有智能体、或当前步骤并未冻结的每一次调用，钩子都返回 `next()`，这使常规路径不含审批流量。

`guardedTools` 在 schemastery `Config` 中给出默认值而非在读取点兜底，原因与阶段门禁在那里给写入清单设默认值相同：裸 `z.array(z.string())` 会解析为 `[]`，使读取点兜底不可达并静默地让每个工具免于确认。`enabled` 在监听器是否注册之前就被检查，因此关闭的冻结点每次调用零开销。

请求携带智能体、工具名、调用 id、一段点名阶段与步骤的中文理由，以及该调用自身的中止信号——因此被取消的调用会取消它待定的确认，而不是留待事后作答。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | pre-execute 钩子、其受护工具集合，以及审批请求与拒绝 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——冻结点的契约与它所读取的服务。
- [审批子系统](../../../docs/subsystems/approval.zh.md)——一次性授权 seam、其应答者契约与 `unavailable` 结果。
- [领域服务](../yxspec/README.zh.md)——钩子所读取的冻结标志与按智能体当前步骤。
- [阶段门禁](../yxspec-gate/README.zh.md)——在本钩子之前运行的结构性钩子。
- [步骤驱动](../yxspec-step/README.zh.md)——分配步骤并可能将其标为冻结的工具。

-----

<a id="model-experience"></a>
## 模型体验

### 冻结点拒绝

#### 模型所见

确认未获授权的冻结步骤调用会成为失败调用的内容。理由点名结果以及阶段与步骤，因此模型能区分"人工拒绝"与"审批通道缺失"。确认提示本身是展示给人的，不是给模型的。

##### 冻结点未获确认

```markdown
冻结点未获人工确认（<outcome>）：<stageId>/<stepId>
```

#### Token 影响

没有冻结步骤处于活动状态、或人工对每次调用都授权时无代价。一次拒绝用一行短理由替换工具正文的结果。

#### KV Cache 影响

仅追加；拒绝是 Session 日志中的普通工具结果，不会改写可复用前缀。

### 确认提示

#### 模型所见

不直接看到任何内容。该理由承载在人所阅读的 `ApprovalRequest` 上，因此它塑造的是用户被问到什么，而不是模型被告知什么。在 `ask` 策略下工具管线可能额外渲染它自己的审批提示，那属于那条 seam 的文本而非本包的。

##### 确认理由

```markdown
❄ 冻结点：阶段 <stageId> 步骤 <stepId>（<stepTitle>）需主会话人工确认后方可继续。
```

#### Token 影响

每个受护的冻结步骤调用一行短提示字符串，只在面向人的审批通道上付出。人工授权的调用不增加任何模型可见 token。

#### KV Cache 影响

没有任何模型请求承载这段文本，因此已可复用的前缀不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **受护集合是名字清单** — 未在 `guardedTools` 中点名的自定义写入工具会在没有确认的情况下操作冻结步骤，因此新增写入器的部署必须在同一次改动里扩充该清单。
- **只读取当前步骤的冻结标志** — 钩子询问 `ctx.yxspec.activeStep(agent)` 当前步骤是否冻结，因此即便下一步骤是冻结点，在驱动分配步骤之前发起的调用也不受守护。
- **每次受护调用分别询问** — 没有按步骤或按回合的记忆化，因此通过多次编辑产出一个冻结产物会每次调用都问一次人工。审批按设计是一次性授权，从不复用。
- **审批 seam 缺失即拒绝** — 没有应答者的组合会落到 `unavailable` 而钩子拒绝，这对无人值守运行是刻意行为，但在部署挂载流程却没有审批通道时值得知晓。
- **提示文本未做本地化** — 确认理由是固定中文字符串，因此纯英文部署会向操作者显示中文。
- **禁用会完全跳过注册** — `enabled: false` 不注册任何监听器，因此该钩子不留任何"曾被配置过"的痕迹，日后重新启用只在下次加载时生效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
