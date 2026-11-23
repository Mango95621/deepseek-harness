---
description: "YXSpec 步骤门禁的宿主级拦截：拒绝会改写已冻结产物的工具调用，以及在当前步骤声明的输入缺失时发起的调用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-gate

[English](README.md) | 中文

## 概述

用 `dsh-yxspec-gate` 让 ASPICE 步骤门禁真正生效：对已冻结 ❄ 产物的写入被拒绝，在处于当前步骤且其声明的输入缺失时发起的任何工具调用也被拒绝，并列出缺失路径。凡受控部署，都应在领域服务与台账旁边挂载它。规则以 `tools/pre-execute` 钩子运行，因此它们捕获每一次模型工具调用，而不是请每个步骤单元自行检查，也没有绕行路径。此外可运行可选的决定性门脚本，按其退出码路由。

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

注册该钩子；此后每次模型工具调用都经过这两项结构性检查。

### 何时选用

凡运行受控 YXSpec 流程、并希望门禁被强制执行而非仅被写成文档的部署都应选用它。它就是把阶段模型变成拦截的消费方，因此漏掉它就意味着只剩每个步骤单元的散文作为唯一规则。不提供 Python 的工作区仍能仅凭产物存在性正确过门，因为 `runGateScripts` 默认为关。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-gate'
  config:
    runGateScripts: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `writeTools` | `write`、`edit`、`multi_edit`、`apply_patch`、`str_replace` | 可能写入文件、因而需经冻结产物检查的工具 |
| `runGateScripts` | `false` | 是否在结构性检查之外执行某步骤的 `gateScript` |
| `gateTimeoutMs` | `30000` | 单次门脚本调用的超时毫秒数 |

带自定义写入器的部署把它的名字加进 `writeTools`。`gateTimeoutMs` 存在，是因为在预算内无法作答的门禁被视为失败而非通过：计时器触发时钩子解析出退出码 `124`。

### 两项检查各做什么

冻结产物检查从 `file_path`、`path`、`filePath` 与 `target` 读取本次调用的目标路径，逐一相对化到工作区根，并在其中有任一路径落在某个冻结步骤声明为输入的路径上时拒绝该调用。拒绝会点名该路径并指向变更请求通道，因为就地改写已签核的产物正是 CR 要防止的事。

输入门禁为发起调用的智能体读取 `ctx.yxspec.activeStep(agent)`，并向台账询问该步骤哪些 `requiredInputs` 缺失。清单非空即拒绝该调用并点名缺失路径。`runGateScripts` 打开时，该步骤的 `gateScript` 以工作区根为工作目录运行，非零退出码即拒绝该调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本插件声明 `inject = ['tools', 'yxspec', 'yxspecArtifacts']`，并在 `apply` 中注册一个 `tools/pre-execute` 监听器。它在注册时读取一次工作区根，因为它所相对化的阶段模型在该插件生命周期内是固定的。

两个数组默认值在 schemastery `Config` 中实体化，而非留给读取点的 `?? DEFAULT_WRITE_TOOLS` 兜底。Schemastery 会把裸 `z.array(z.string())` 解析为 `[]`，而它是真值，因此读取点兜底不可达，冻结检查会静默地对每个工具停止生效。把默认值声明在 schema 里，可以让解析后的配置保持诚实并可在配置目录中查看。

`frozenPaths` 在每次写入调用时遍历整个阶段模型，返回每个冻结步骤所声明的输入。它按调用重算而非缓存，因为阶段模型在实践中是只读的，但代价只是对小表的一趟遍历，而过期的冻结集合会是静默的安全回归。`runGateScript` 以 `stdio: 'ignore'` 启动脚本并从 `close` 解析退出码，把启动错误映射为 `127`、超时映射为 `124`。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | pre-execute 钩子、其目标提取，以及冻结路径与门脚本两项检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——门禁的契约与它所门控的服务。
- [领域服务](../yxspec/README.zh.md)——钩子所读取的阶段模型与按智能体当前步骤。
- [产物台账](../yxspec-artifact/README.zh.md)——输入门禁背后的落盘检查。
- [冻结点](../yxspec-freeze/README.zh.md)——在本门禁之后运行的人工确认门。
- [Tools 子系统](../../../docs/subsystems/tools.zh.md)——钩子所运行的受控执行管线。

-----

<a id="model-experience"></a>
## 模型体验

### 工具调用拒绝

#### 模型所见

被拒绝的调用成为失败调用的内容，逐字携带本包的理由。共存在两种理由：冻结产物拒绝点名相对化后的路径与变更请求通道，输入门禁拒绝点名阶段、步骤与每一条缺失路径。门脚本拒绝点名脚本与其退出码。拒绝遵循普通的工具调用投影，因此模型读到它的方式与读任何其他失败调用完全相同。

##### 冻结产物拒绝

```markdown
产物已冻结：<path>。冻结点产物不得就地改写；请走变更请求（CR）流程。
```

##### 输入门禁拒绝

```markdown
gate: 阶段 <stageId> 步骤 <stepId> 的输入缺失 → <missing paths, comma-separated>
```

#### Token 影响

每次调用都被放行时无代价。一次拒绝用一行短理由替换工具正文的结果，因此它比被它阻止的那次调用更省——但模型随后会重试，而每次重试都要付出一次完整请求。

#### KV Cache 影响

仅追加；拒绝是 Session 日志中的普通工具结果，不会改写可复用前缀。模型因回合结束而从未看到的拒绝根本不会被加入。

### 门脚本退出码

#### 模型所见

`runGateScripts` 打开且某步骤声明了 `gateScript` 时，非零退出即以点名脚本与退出码的理由拒绝该调用。脚本自身的输出被丢弃：它以 `stdio: 'ignore'` 运行，因此它打印的任何内容都不会抵达模型。

#### Token 影响

每个失败脚本一行短理由，替换工具正文的结果。

#### KV Cache 影响

仅追加，与任何其他拒绝相同。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **目标提取基于键名** — 冻结检查从调用参数读取 `file_path`、`path`、`filePath` 与 `target`，因此使用其他参数名的写入工具不会被检查，除非把它的名字加进 `writeTools` 且该键在上述清单中。
- **冻结集合派生自步骤输入** — 某条路径在某个冻结步骤将其声明为必需输入时才被冻结，因此一个由 ❄ 步骤产出、但没有任何后续步骤声明的产物不受保护。
- **门脚本运行不受信任的命令** — 某步骤的 `gateScript` 以工作区根为工作目录作为子进程执行，没有自己的沙箱。只应对脚本可信的仓库开启 `runGateScripts`，并让 `gateTimeoutMs` 保持有界。
- **脚本超时即为拒绝** — 计时器触发时钩子解析出 `124` 而非放行该调用，因此慢门禁会阻塞流程而不是静默放行。
- **工作区之外的路径只做规范化** — 解析结果位于工作区根之外的目标会按字面比较而非被拒绝，因此该检查保护已声明路径，并不圈禁写入。
- **步骤门禁需要存在当前步骤** — 发起调用的智能体没有当前步骤时，输入门禁与门脚本都会被跳过，因此在驱动分配步骤之前发起的调用不受约束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
